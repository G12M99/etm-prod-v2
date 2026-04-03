/**
 * @module db
 * @description Toutes les requêtes Supabase. Source de vérité unique.
 *              Pas de localStorage pour les données métier.
 * @requires state.js
 */

import { State, reloadMachineArrays, markRecordAsModified, markCommandeDirty } from './state.js';
import { computeHoursPerDay } from './utils.js';

// ===================================
// Configuration Supabase
// ===================================

const SUPABASE_URL = 'https://veyqcnoaiqotikpjfgjq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wa6y4sYvbvKtzSFBzw7lBg_CYdxXr1P';

// --- Debounce interne ---
let _saveTimeout = null;
let _autoSyncInterval = null;

// ===================================
// Initialisation
// ===================================

/**
 * Initialise le client Supabase.
 * @returns {boolean} true si l'initialisation a réussi
 */
export function initSupabase() {
    try {
        if (window.supabase) {
            State.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            // Expose globally for supabase.js (non-module) which reads `supabaseClient`
            window.supabaseClient = State.supabaseClient;
            console.log('Supabase client initialisé');
            return true;
        } else {
            console.warn('Supabase SDK non chargé');
            return false;
        }
    } catch (e) {
        console.error('Erreur initialisation Supabase:', e);
        return false;
    }
}

// ===================================
// Lecture — Commandes
// ===================================

/**
 * Charge toutes les commandes + opérations + slots depuis Supabase.
 * Écrit directement dans State.commandes.
 */
export async function loadCommandes() {
    if (!State.supabaseClient) throw new Error('Supabase non initialisé');

    updateSyncIndicator('syncing', 'Chargement Supabase...');

    // Fix 2 : filtre 90 jours glissants comme filet de sécurité
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    // Fix 1 + 2 : OR entre statut actif (non terminé/livré) et date récente
    // NULL statut inclus explicitement pour ne jamais manquer une nouvelle commande
    // Fix 3 : limite explicite 2000
    const { data: commandesData, error: cmdError } = await State.supabaseClient
        .from('commandes')
        .select('*')
        .or(`statut.is.null,statut.not.in.(Livré,Terminé),date_livraison.gte.${cutoffStr}`)
        .limit(2000);

    if (cmdError) throw cmdError;

    // Fix 3 : warning si limite atteinte
    if (commandesData && commandesData.length === 2000) {
        console.warn('⚠️ Limite de chargement atteinte (2000) — certaines commandes peuvent être absentes');
    }
    if (!commandesData || commandesData.length === 0) {
        State.commandes = [];
        updateSyncIndicator('synced', 'À jour (vide)');
        return;
    }

    const { data: operationsData, error: opError } = await State.supabaseClient
        .from('operations')
        .select('*');
    if (opError) throw opError;

    const { data: slotsData, error: slotError } = await State.supabaseClient
        .from('slots')
        .select('*');
    if (slotError) throw slotError;

    // Reconstruire la structure locale
    State.commandes = commandesData.map(cmd => {
        const cmdOperations = (operationsData || [])
            .filter(op => op.commande_id === cmd.id)
            .map(op => {
                const opSlots = (slotsData || [])
                    .filter(slot => slot.operation_id === op.id)
                    .map(slot => ({
                        id: slot.id,
                        machine: slot.machine_name,
                        duree: parseFloat(slot.duree),
                        semaine: slot.semaine,
                        jour: slot.jour,
                        heureDebut: slot.heure_debut,
                        heureFin: slot.heure_fin,
                        dateDebut: slot.date_debut,
                        dateFin: slot.date_fin,
                        overtime: slot.overtime
                    }));
                return {
                    id: op.id,
                    type: op.type,
                    dureeTotal: parseFloat(op.duree_total),
                    dureeOriginal: parseFloat(op.duree_original),
                    dureeOverride: op.duree_override ? parseFloat(op.duree_override) : null,
                    overrideTimestamp: op.override_timestamp,
                    progressionReelle: parseFloat(op.progression_reelle),
                    statut: op.statut,
                    slots: opSlots
                };
            });

        return {
            id: cmd.id,
            client: cmd.client_name,
            dateLivraison: cmd.date_livraison,
            statut: cmd.statut,
            materiau: cmd.materiau,
            poids: parseFloat(cmd.poids),
            refCdeClient: cmd.ref_cde_client,
            ressource: cmd.ressource,
            semaineAffectee: cmd.semaine_affectee,
            operations: cmdOperations
        };
    });

    updateSyncIndicator('synced', 'Supabase');
    console.log(`${State.commandes.length} commandes chargées depuis Supabase`);
}

/**
 * Fix 4 — Charge TOUTES les commandes (sans filtre statut/date) avec pagination.
 * À utiliser pour les exports uniquement — NE PAS appeler au démarrage.
 * @returns {Promise<Array>} Tableau brut des lignes Supabase (commandes uniquement, sans opérations ni slots)
 */
export async function fetchAllCommandes() {
    if (!State.supabaseClient) throw new Error('Supabase non initialisé');

    const PAGE_SIZE = 1000;
    let allData = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
        const { data, error } = await State.supabaseClient
            .from('commandes')
            .select('*')
            .range(from, from + PAGE_SIZE - 1);

        if (error) throw error;
        allData = [...allData, ...data];
        hasMore = data.length === PAGE_SIZE;
        from += PAGE_SIZE;
    }

    console.log(`[fetchAllCommandes] ${allData.length} commandes récupérées (export complet)`);
    return allData;
}

// ===================================
// Lecture — Machines
// ===================================

/**
 * Charge la configuration des machines depuis Supabase.
 * Reconstruit State.machinesConfig et appelle reloadMachineArrays().
 */
export async function loadMachines() {
    if (!State.supabaseClient) return;

    try {
        const { data, error } = await State.supabaseClient
            .from('machines')
            .select('*')
            .order('type');

        if (!error && data && data.length > 0) {
            State.machinesConfig = {
                cisaillage: data.filter(m => m.type === 'cisaillage').map(m => ({
                    id: m.id,
                    name: m.name,
                    capacity: parseFloat(m.capacity),
                    color: m.color,
                    active: m.active
                })),
                poinconnage: data.filter(m => m.type === 'poinconnage').map(m => ({
                    id: m.id,
                    name: m.name,
                    capacity: parseFloat(m.capacity),
                    color: m.color,
                    active: m.active
                })),
                pliage: data.filter(m => m.type === 'pliage').map(m => ({
                    id: m.id,
                    name: m.name,
                    capacity: parseFloat(m.capacity),
                    color: m.color,
                    active: m.active
                }))
            };
            console.log('Configuration machines chargée depuis Supabase');
        }
    } catch (e) {
        console.warn('Supabase machines load failed:', e);
    }

    reloadMachineArrays();
}

// ===================================
// Lecture — Schedule (Horaires)
// ===================================

/**
 * Charge la configuration des horaires depuis Supabase.
 * Reconstruit State.scheduleConfig et recalcule State.HOURS_PER_DAY.
 */
export async function loadSchedule() {
    if (!State.supabaseClient) return;

    try {
        const { data: shiftsData, error: shiftsError } = await State.supabaseClient
            .from('shifts')
            .select('*');

        const { data: schedulesData, error: schedulesError } = await State.supabaseClient
            .from('shift_schedules')
            .select('*');

        const { data: breaksData, error: breaksError } = await State.supabaseClient
            .from('breaks')
            .select('*');

        const { data: overtimeData, error: overtimeError } = await State.supabaseClient
            .from('overtime_config')
            .select('*')
            .limit(1)
            .single();

        const { data: overtimeSlotsData, error: overtimeSlotsError } = await State.supabaseClient
            .from('overtime_slots')
            .select('*');

        if (!shiftsError && shiftsData && shiftsData.length > 0) {
            const shifts = shiftsData.map(s => {
                const shiftSchedules = (schedulesData || []).filter(sc => sc.shift_id === s.id);
                const schedulesObj = {};
                shiftSchedules.forEach(sc => {
                    schedulesObj[sc.day_name] = {
                        start: sc.start_time,
                        end: sc.end_time
                    };
                });
                return {
                    id: s.id,
                    name: s.name,
                    active: s.active,
                    days: s.days || [],
                    schedules: schedulesObj
                };
            });

            const breaks = (breaksData || []).map(b => ({
                id: b.id,
                name: b.name,
                start: b.start_time,
                end: b.end_time,
                days: b.days || [],
                active: b.active
            }));

            const overtime = {
                id: overtimeData?.id || null,
                enabled: overtimeData?.enabled || false,
                maxDailyHours: overtimeData?.max_daily_hours || 2,
                maxWeeklyHours: overtimeData?.max_weekly_hours || 10,
                slots: (overtimeSlotsData || []).map(os => ({
                    days: os.days || [],
                    start: os.start_time,
                    end: os.end_time,
                    maxHours: os.max_hours
                }))
            };

            State.scheduleConfig = { shifts, breaks, overtime };
            console.log('Configuration horaires chargée depuis Supabase');

            // Recalculer HOURS_PER_DAY depuis les shifts
            _recalculateHoursPerDay();
        }
    } catch (e) {
        console.warn('Supabase schedule load failed:', e);
    }
}

/**
 * Recalcule State.HOURS_PER_DAY et State.TOTAL_HOURS_PER_WEEK
 * depuis State.scheduleConfig, filtré sur State.currentShiftId si initialisé.
 */
function _recalculateHoursPerDay() {
    const filteredConfig = State.currentShiftId
        ? { ...State.scheduleConfig, shifts: (State.scheduleConfig.shifts || []).filter(s => s.id === State.currentShiftId) }
        : State.scheduleConfig;
    const { dailyHours: result, totalWeekly } = computeHoursPerDay(filteredConfig);

    State.HOURS_PER_DAY = result;
    State.TOTAL_HOURS_PER_WEEK = totalWeekly;

    // Synchroniser CAPACITY_CONFIG avec les valeurs recalculées
    if (State.CAPACITY_CONFIG?.normal) {
        State.CAPACITY_CONFIG.normal.dailyHours = { ...result };
        State.CAPACITY_CONFIG.normal.weeklyHours = State.TOTAL_HOURS_PER_WEEK;
    }

    // Recalculer LUNCH_BREAK depuis les breaks
    const lunchBreak = (State.scheduleConfig.breaks || []).find(b => b.active);
    if (lunchBreak) {
        const start = _timeStringToDecimal(lunchBreak.start);
        const end = _timeStringToDecimal(lunchBreak.end);
        State.LUNCH_BREAK = {
            start: lunchBreak.start,
            end: lunchBreak.end,
            duration: Math.round((end - start) * 100) / 100
        };
    }
}

/**
 * Convertit "HH:MM" en décimal (ex: "07:30" → 7.5)
 */
function _timeStringToDecimal(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h + m / 60;
}

// ===================================
// Lecture — System Events
// ===================================

/**
 * Charge les événements système depuis Supabase.
 * Écrit dans State.systemEvents.
 */
export async function loadSystemEvents() {
    if (!State.supabaseClient) return;

    try {
        const { data, error } = await State.supabaseClient
            .from('system_events')
            .select('*');

        if (!error && data && data.length > 0) {
            State.systemEvents = data.map(e => ({
                id: e.id,
                type: e.type,
                name: e.name,
                reason: e.description || e.name,
                machine: (e.affected_machines && e.affected_machines.length > 0) ? e.affected_machines[0] : 'ALL',
                dateStart: e.date_start,
                dateEnd: e.date_end,
                startTimeFirstDay: e.start_time_first_day,
                endTimeLastDay: e.end_time_last_day,
                fullLastDay: e.full_last_day,
                affectedMachines: e.affected_machines || [],
                affectedShifts: e.affected_shifts || [],
                description: e.description,
                resolvedConflicts: e.resolved_conflicts || {},
                version: e.version || 2
            }));
            console.log(`${State.systemEvents.length} system events chargés depuis Supabase`);
        }
    } catch (e) {
        console.warn('Supabase system events load failed:', e);
    }
}

// ===================================
// Écriture — Commandes
// ===================================

/**
 * Upsert complet d'une commande + opérations + slots vers Supabase.
 * Gère le nettoyage des slots orphelins.
 * @param {object} cmd - Objet commande local
 */
export async function saveCommande(cmd) {
    if (!State.supabaseClient) return;

    // 1. Upsert commande
    const { error: cmdError } = await State.supabaseClient
        .from('commandes')
        .upsert({
            id: cmd.id,
            client_name: cmd.client || null,
            date_livraison: cmd.dateLivraison && cmd.dateLivraison !== '' ? cmd.dateLivraison : null,
            statut: cmd.statut || null,
            materiau: cmd.materiau || null,
            poids: cmd.poids || 0,
            ref_cde_client: cmd.refCdeClient || null,
            ressource: cmd.ressource || null,
            semaine_affectee: cmd.semaineAffectee || null,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id' });

    if (cmdError) throw cmdError;
    markRecordAsModified(cmd.id);

    // 2. Upsert opérations + nettoyage slots orphelins + upsert slots
    if (cmd.operations && cmd.operations.length > 0) {
        for (const op of cmd.operations) {
            const opId = op.id;
            if (!opId) {
                console.warn(`⚠️ Opération sans ID pour ${cmd.id}/${op.type}`);
                continue;
            }

            const { error: opError } = await State.supabaseClient
                .from('operations')
                .upsert({
                    id: opId,
                    commande_id: cmd.id,
                    type: op.type,
                    // duree_total et duree_original sont la propriété d'ETM_RP — ne pas écraser
                    duree_override: op.dureeOverride,
                    override_timestamp: op.overrideTimestamp,
                    progression_reelle: op.progressionReelle || 0,
                    statut: op.statut || 'Non placée',
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });

            if (opError) throw opError;
            markRecordAsModified(opId);

            // 3. Nettoyage des slots orphelins
            const { data: remoteSlots, error: fetchError } = await State.supabaseClient
                .from('slots')
                .select('id')
                .eq('operation_id', opId);

            if (fetchError) {
                console.warn(`⚠️ Impossible de vérifier les slots orphelins pour ${opId}:`, fetchError);
            }

            const remoteSlotIds = (remoteSlots || []).map(s => s.id);
            const localSlotIds = (op.slots || []).filter(s => s.id).map(s => s.id);

            const orphanIds = remoteSlotIds.filter(id => !localSlotIds.includes(id));
            if (orphanIds.length > 0) {
                console.log(`🧹 Suppression de ${orphanIds.length} slot(s) orphelin(s) pour ${opId}`);
                const { error: deleteError } = await State.supabaseClient
                    .from('slots')
                    .delete()
                    .in('id', orphanIds);

                if (!deleteError) {
                    orphanIds.forEach(id => markRecordAsModified(id));
                }
            }

            // 4. Upsert des slots locaux
            if (op.slots && op.slots.length > 0) {
                const slotsToUpsert = op.slots
                    .filter(slot => slot.id)
                    .map(slot => ({
                        id: slot.id,
                        operation_id: opId,
                        machine_id: slot.machine
                            ? slot.machine.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '-')
                            : null,
                        machine_name: slot.machine,
                        duree: slot.duree,
                        semaine: slot.semaine,
                        jour: slot.jour,
                        heure_debut: slot.heureDebut,
                        heure_fin: slot.heureFin,
                        date_debut: slot.dateDebut,
                        date_fin: slot.dateFin,
                        overtime: slot.overtime || false,
                        updated_at: new Date().toISOString()
                    }));

                if (slotsToUpsert.length > 0) {
                    const { error: slotError } = await State.supabaseClient
                        .from('slots')
                        .upsert(slotsToUpsert, { onConflict: 'id' });

                    if (slotError) throw slotError;
                    slotsToUpsert.forEach(s => markRecordAsModified(s.id));
                }
            }
        }
    }
}

/**
 * Sauvegarde toutes les commandes marquées dirty vers Supabase.
 * Vide le Set _dirtyCommandeIds après succès.
 */
export async function saveAllDirtyCommandes() {
    if (!State.supabaseClient) return;
    if (State._dirtyCommandeIds.size === 0) return;

    const idsToSync = [...State._dirtyCommandeIds];
    State._dirtyCommandeIds.clear();

    try {
        console.log(`💾 Supabase: ${idsToSync.length} commande(s) modifiée(s)`);

        for (const cmdId of idsToSync) {
            const cmd = State.commandes.find(c => c.id === cmdId);
            if (cmd) {
                await saveCommande(cmd);
            }
        }
    } catch (e) {
        console.error('❌ Erreur sauvegarde Supabase:', e);
        // Re-marquer les IDs en erreur pour retenter
        idsToSync.forEach(id => State._dirtyCommandeIds.add(id));
    }
}

/**
 * Version debounced de saveAllDirtyCommandes (500ms).
 */
export function saveAllDirtyCommandesDebounced() {
    if (_saveTimeout) {
        clearTimeout(_saveTimeout);
    }
    _saveTimeout = setTimeout(() => {
        saveAllDirtyCommandes();
    }, 500);
}

// ===================================
// Wrappers saveData / saveDataImmediate
// ===================================

let _isSaving = false;

/**
 * Returns true if a save is currently in progress.
 * Used by realtime handlers to avoid reload during save.
 */
export function isSaving() {
    return _isSaving;
}

/**
 * Marque une commande comme dirty et déclenche la sauvegarde debounced.
 * @param {string} commandeId
 */
export function saveData(commandeId) {
    if (commandeId) markCommandeDirty(commandeId);
    _isSaving = true;
    _saveLocalStorage();
    saveAllDirtyCommandesDebounced();
    setTimeout(() => { _isSaving = false; }, 1500);
}

/**
 * Marque une commande comme dirty et sauvegarde immédiatement (pas de debounce).
 * Utilisé par handleDrop pour une sync instantanée.
 * @param {string} commandeId
 */
export async function saveDataImmediate(commandeId) {
    if (commandeId) markCommandeDirty(commandeId);
    _isSaving = true;
    _saveLocalStorage();
    await saveAllDirtyCommandes();
    _isSaving = false;
}

/**
 * Sauvegarde les commandes dans localStorage (backup offline).
 */
function _saveLocalStorage() {
    try {
        localStorage.setItem('etm_commandes_v2', JSON.stringify(State.commandes));
    } catch (e) {
        console.warn('localStorage save failed:', e);
    }
}

// ===================================
// Écriture — Slots
// ===================================

/**
 * Supprime un slot de la table slots.
 * @param {string} slotId
 */
export async function deleteSlot(slotId) {
    if (!State.supabaseClient || !slotId) return;

    try {
        const { error } = await State.supabaseClient
            .from('slots')
            .delete()
            .eq('id', slotId);

        if (error) throw error;
        markRecordAsModified(slotId);
        console.log(`Slot ${slotId} supprimé de Supabase`);
    } catch (e) {
        console.error('Erreur suppression slot Supabase:', e);
    }
}

/**
 * Supprime tous les slots d'une opération.
 * @param {string} operationId
 */
export async function deleteAllSlotsForOperation(operationId) {
    if (!State.supabaseClient || !operationId) return;

    try {
        const { error } = await State.supabaseClient
            .from('slots')
            .delete()
            .eq('operation_id', operationId);

        if (error) throw error;
        markRecordAsModified(operationId);
        console.log(`Tous les slots de ${operationId} supprimés de Supabase`);
    } catch (e) {
        console.error('Erreur suppression slots Supabase:', e);
    }
}

/**
 * Supprime tous les slots Supabase associés à un nom de machine.
 * @param {string} machineName
 * @returns {Promise<boolean>} true si succès
 */
export async function deleteSlotsByMachineName(machineName) {
    if (!State.supabaseClient || !machineName) return true;

    try {
        const { error } = await State.supabaseClient
            .from('slots')
            .delete()
            .eq('machine_name', machineName);

        if (error) throw error;
        console.log(`Slots de la machine "${machineName}" supprimés de Supabase`);
        return true;
    } catch (e) {
        console.error('Erreur suppression slots machine Supabase:', e);
        return false;
    }
}

/**
 * Supprime une pause de Supabase.
 * @param {string} breakId
 * @returns {boolean}
 */
export async function deleteBreakFromSupabase(breakId) {
    if (!State.supabaseClient || !breakId) return true;

    try {
        const { error } = await State.supabaseClient
            .from('breaks')
            .delete()
            .eq('id', breakId);

        if (error) throw error;

        console.log(`Pause "${breakId}" supprimée de Supabase`);
        return true;
    } catch (e) {
        console.error('Erreur suppression pause Supabase:', e);
        return false;
    }
}

/**
 * Supprime un shift et ses shift_schedules de Supabase.
 * @param {string} shiftId
 * @returns {boolean}
 */
export async function deleteShiftFromSupabase(shiftId) {
    if (!State.supabaseClient || !shiftId) return true;

    try {
        // Supprimer les schedules du shift
        const { error: schedError } = await State.supabaseClient
            .from('shift_schedules')
            .delete()
            .eq('shift_id', shiftId);

        if (schedError) throw schedError;

        // Supprimer le shift lui-même
        const { error: shiftError } = await State.supabaseClient
            .from('shifts')
            .delete()
            .eq('id', shiftId);

        if (shiftError) throw shiftError;

        console.log(`Shift "${shiftId}" supprimé de Supabase`);
        return true;
    } catch (e) {
        console.error('Erreur suppression shift Supabase:', e);
        return false;
    }
}

// ===================================
// Écriture — Configuration Machines
// ===================================

/**
 * Upsert de la configuration machines dans Supabase.
 * @param {object} machinesConfig - { cisaillage: [...], poinconnage: [...], pliage: [...] }
 */
export async function saveMachines(machinesConfig) {
    if (!State.supabaseClient) return;

    try {
        const allMachines = [
            ...machinesConfig.cisaillage.map(m => ({ ...m, type: 'cisaillage' })),
            ...machinesConfig.poinconnage.map(m => ({ ...m, type: 'poinconnage' })),
            ...machinesConfig.pliage.map(m => ({ ...m, type: 'pliage' }))
        ];

        for (const machine of allMachines) {
            await State.supabaseClient
                .from('machines')
                .upsert({
                    id: machine.id,
                    name: machine.name,
                    type: machine.type,
                    capacity: machine.capacity,
                    color: machine.color,
                    active: machine.active,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
        }

        console.log('Configuration machines sauvegardée Supabase');
    } catch (e) {
        console.error('Erreur sauvegarde machines Supabase:', e);
    }
}

// ===================================
// Écriture — Configuration Horaires
// ===================================

/**
 * Upsert de la configuration horaires dans Supabase.
 * @param {object} scheduleConfig - { shifts, breaks, overtime }
 */
export async function saveSchedule(scheduleConfig) {
    if (!State.supabaseClient) return;

    State.savingSchedule = true;
    try {
        // Sauvegarder shifts
        for (const shift of scheduleConfig.shifts) {
            await State.supabaseClient
                .from('shifts')
                .upsert({
                    id: shift.id,
                    name: shift.name,
                    active: shift.active,
                    days: shift.days,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });

            // Supprimer anciens schedules pour ce shift
            await State.supabaseClient
                .from('shift_schedules')
                .delete()
                .eq('shift_id', shift.id);

            // Insérer nouveaux schedules
            if (shift.schedules) {
                for (const [dayName, schedule] of Object.entries(shift.schedules)) {
                    await State.supabaseClient
                        .from('shift_schedules')
                        .insert({
                            shift_id: shift.id,
                            day_name: dayName,
                            start_time: schedule.start,
                            end_time: schedule.end
                        });
                }
            }
        }

        // Sauvegarder breaks
        for (const brk of scheduleConfig.breaks) {
            await State.supabaseClient
                .from('breaks')
                .upsert({
                    id: brk.id,
                    name: brk.name,
                    start_time: brk.start,
                    end_time: brk.end,
                    days: brk.days,
                    active: brk.active,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
        }

        // Sauvegarder overtime config
        if (scheduleConfig.overtime) {
            // Option B : id UUID stable — généré une seule fois, réutilisé ensuite
            let overtimeId = scheduleConfig.overtime.id;
            if (!overtimeId) {
                overtimeId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                });
                // Stocker dans State pour les saves suivants
                State.scheduleConfig.overtime.id = overtimeId;
            }

            await State.supabaseClient
                .from('overtime_config')
                .upsert({
                    id: overtimeId,
                    enabled: scheduleConfig.overtime.enabled,
                    max_daily_hours: scheduleConfig.overtime.maxDailyHours,
                    max_weekly_hours: scheduleConfig.overtime.maxWeeklyHours
                }, { onConflict: 'id' });

            if (scheduleConfig.overtime.slots) {
                await State.supabaseClient
                    .from('overtime_slots')
                    .delete()
                    .eq('overtime_config_id', overtimeId);

                for (const slot of scheduleConfig.overtime.slots) {
                    await State.supabaseClient
                        .from('overtime_slots')
                        .insert({
                            overtime_config_id: overtimeId,
                            days: slot.days,
                            start_time: slot.start,
                            end_time: slot.end,
                            max_hours: slot.maxHours
                        });
                }
            }
        }

        console.log('Configuration horaires sauvegardée Supabase');
    } catch (e) {
        console.error('Erreur sauvegarde horaires Supabase:', e);
    } finally {
        // Garder le flag actif le temps que les Realtime des 5 tables arrivent
        // (shifts, shift_schedules, breaks, overtime_config, overtime_slots + debounce 2s)
        setTimeout(() => { State.savingSchedule = false; }, 7000);
    }
}

// ===================================
// Écriture — System Events
// ===================================

/**
 * Upsert de tous les événements système dans Supabase.
 * @param {Array} events
 */
export async function saveSystemEvents(events) {
    if (!State.supabaseClient) return;

    State.savingSystemEvents = true;
    try {
        // Delete all existing records then re-insert (avoids onConflict constraint requirement)
        await State.supabaseClient.from('system_events').delete().not('id', 'is', null);

        if (events.length > 0) {
            const eventsData = events.map(event => ({
                id: event.id,
                type: event.type,
                name: event.name || event.reason || 'Événement',
                date_start: event.dateStart || event.dateStr,
                date_end: event.dateEnd || event.dateStr,
                start_time_first_day: event.startTimeFirstDay,
                end_time_last_day: event.endTimeLastDay,
                full_last_day: event.fullLastDay !== false,
                affected_machines: event.machine ? [event.machine] : (event.affectedMachines || []),
                affected_shifts: event.affectedShifts || [],
                description: event.description || event.reason,
                resolved_conflicts: event.resolvedConflicts || {},
                version: event.version || 2
            }));

            const { error: insertError } = await State.supabaseClient.from('system_events').insert(eventsData);
            if (insertError) throw insertError;
        }

        console.log('System events sauvegardés vers Supabase');
    } catch (e) {
        console.error('Erreur sauvegarde system events Supabase:', e);
    } finally {
        // Keep flag active long enough to absorb the Realtime DELETE+INSERT events
        setTimeout(() => { State.savingSystemEvents = false; }, 6000);
    }
}

// ===================================
// UI & Lifecycle
// ===================================

// --- Unified connection status tracking ---
// Both sync and realtime update their own sub-state;
// the displayed indicator reflects the combined worst state.

const _connectionState = { sync: 'syncing', realtime: 'disconnected' };

function _renderConnectionStatus() {
    const el = document.getElementById('connectionStatus');
    if (!el) return;

    const s = _connectionState.sync;
    const r = _connectionState.realtime;

    // Priority: error > syncing/connecting > offline/disconnected > synced/connected
    let combined, dot, label, title;

    if (s === 'error' || r === 'error') {
        combined = 'error';
        dot = '!';
        label = 'Erreur';
        title = 'Erreur de connexion — Tentative de reconnexion...';
    } else if (s === 'syncing') {
        combined = 'connecting';
        dot = '◌';
        label = 'Synchronisation...';
        title = 'Chargement des données depuis Supabase...';
    } else if (r === 'connecting') {
        combined = 'connecting';
        dot = '◌';
        label = 'Connexion...';
        title = 'Connexion au serveur en cours...';
    } else if (s === 'offline' || r === 'disconnected') {
        combined = 'offline';
        dot = '○';
        label = 'Hors ligne';
        title = 'Déconnecté — Les modifications sont sauvegardées localement';
    } else {
        // both synced + connected
        combined = 'connected';
        dot = '●';
        label = 'Connecté';
        title = 'Connecté — Les modifications sont synchronisées en temps réel';
    }

    el.className = `connection-status status-${combined}`;
    el.title = title;
    el.innerHTML = `<span class="status-dot">${dot}</span><span class="status-label">${label}</span>`;
}

/**
 * Met à jour le volet sync de l'indicateur unifié.
 * @param {'synced'|'syncing'|'offline'|'error'} status
 */
export function updateSyncIndicator(status) {
    _connectionState.sync = status;
    _renderConnectionStatus();
}

/**
 * Met à jour le volet realtime de l'indicateur unifié.
 * Appelé depuis supabase.js via window.
 * @param {'connected'|'connecting'|'disconnected'|'error'} status
 */
export function updateRealtimeIndicator(status) {
    _connectionState.realtime = status;
    _renderConnectionStatus();
}

// Expose for supabase.js (non-module script)
window.updateRealtimeIndicator = updateRealtimeIndicator;

/**
 * Démarre la synchronisation automatique (toutes les 10 minutes).
 */
export function startAutoSync() {
    if (_autoSyncInterval) clearInterval(_autoSyncInterval);
    _autoSyncInterval = setInterval(async () => {
        try {
            await loadCommandes();
            console.log('Auto-sync Supabase terminée');
        } catch (e) {
            console.error('Auto-sync failed:', e);
            updateSyncIndicator('error', 'Erreur Sync');
        }
    }, 10 * 60 * 1000); // 10 minutes
}

/**
 * Force un rechargement complet depuis Supabase.
 * Vide State.commandes puis recharge.
 */
export async function forceFullReload() {
    State.commandes = [];
    try {
        await loadCommandes();
    } catch (e) {
        console.error('Force full reload failed:', e);
        updateSyncIndicator('error', 'Erreur rechargement');
    }
}

/**
 * @module realtime
 * @description Supabase Realtime : souscriptions, handlers de changement,
 *              refresh UI-only, offline queue, sync handlers.
 * @requires state.js, db.js, ui-list.js, ui-sidebar.js, ui-week.js, ui-day.js
 */

import { State, isOurOwnRealtimeEvent, markCommandeDirty } from './state.js';
import { Toast } from './utils.js';
import { refresh, updateCurrentTime, renderVueListe } from './ui-list.js';
import { renderCommandesNonPlacees } from './ui-sidebar.js';
import { renderVueSemaine } from './ui-week.js';
import { renderVueJournee } from './ui-day.js';
import { loadMachines, loadSchedule, loadSystemEvents, forceFullReload, saveAllDirtyCommandes, deleteSlot, isSaving } from './db.js';
import { renderMachinesManager } from './machines.js';
import { renderScheduleManager, reloadScheduleArrays } from './schedule.js';
import { renderSystemEventsList } from './system-events.js';

// ===================================
// Local state
// ===================================
const REALTIME_DEBUG = false;
let _realtimeUpdateTimer = null;
let _machineDebounceTimer = null;
let _sysEventDebounceTimer = null;
let _scheduleDebounceTimer = null;
const OFFLINE_QUEUE_KEY = 'etm_offline_queue';

// ===================================
// Refresh UI-only (no Supabase save)
// ===================================

/**
 * Re-render la vue active sans sauvegarder en Supabase.
 * Utilisé par les handlers Realtime pour éviter les boucles de write-back.
 */
export function refreshUIOnly() {
    if (State.vueActive === 'semaine') {
        renderVueSemaine();
    } else if (State.vueActive === 'journee') {
        renderVueJournee();
    } else if (State.vueActive === 'liste') {
        renderVueListe();
    }
    renderCommandesNonPlacees(State.currentSearchQuery || '');
    updateCurrentTime();
}

/**
 * Debounce pour les handlers Realtime.
 * Batch les events rapides (500ms) et ne fait que rafraîchir l'UI.
 */
export function debouncedRealtimeUpdate() {
    if (_realtimeUpdateTimer) {
        clearTimeout(_realtimeUpdateTimer);
    }
    _realtimeUpdateTimer = setTimeout(() => {
        _realtimeUpdateTimer = null;
        refreshUIOnly();
    }, 500);
}

// ===================================
// Map functions (Supabase → local)
// ===================================

/**
 * Convertit une commande Supabase en format local
 */
export function mapSupabaseCommandeToLocal(cmd) {
    return {
        id: cmd.id,
        client: cmd.client_name,
        dateLivraison: cmd.date_livraison,
        statut: cmd.statut,
        materiau: cmd.materiau,
        poids: parseFloat(cmd.poids) || 0,
        refCdeClient: cmd.ref_cde_client,
        ressource: cmd.ressource,
        semaineAffectee: cmd.semaine_affectee,
        operations: []
    };
}

/**
 * Convertit une opération Supabase en format local
 */
export function mapSupabaseOperationToLocal(op) {
    return {
        id: op.id,
        type: op.type,
        dureeTotal: parseFloat(op.duree_total) || 0,
        dureeOriginal: parseFloat(op.duree_original) || 0,
        dureeOverride: op.duree_override ? parseFloat(op.duree_override) : null,
        overrideTimestamp: op.override_timestamp,
        progressionReelle: parseFloat(op.progression_reelle) || 0,
        statut: op.statut,
        slots: []
    };
}

/**
 * Convertit un slot Supabase en format local
 */
export function mapSupabaseSlotToLocal(slot) {
    return {
        id: slot.id,
        machine: slot.machine_name,
        duree: parseFloat(slot.duree) || 0,
        semaine: slot.semaine,
        jour: slot.jour,
        heureDebut: slot.heure_debut,
        heureFin: slot.heure_fin,
        dateDebut: slot.date_debut,
        dateFin: slot.date_fin,
        overtime: slot.overtime || false
    };
}

// ===================================
// Realtime handlers
// ===================================

/**
 * Handler pour les changements de commandes en temps réel
 */
export function handleRealtimeCommandeChange(payload) {
    const recordId = payload?.new?.id || payload?.old?.id;
    if (recordId && isOurOwnRealtimeEvent(recordId)) {
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif): commande ${recordId}`);
        return;
    }

    const eventType = payload.eventType;
    console.log(`📡 Realtime commande: ${eventType} ${recordId}`);

    switch (eventType) {
        case 'INSERT': {
            const newCmd = mapSupabaseCommandeToLocal(payload.new);
            if (!State.commandes.find(c => c.id === newCmd.id)) {
                State.commandes.push(newCmd);
                console.log(`➕ Commande ${newCmd.id} ajoutée`);
            }
            break;
        }
        case 'UPDATE': {
            const cmd = State.commandes.find(c => c.id === recordId);
            if (cmd) {
                cmd.client = payload.new.client_name;
                cmd.dateLivraison = payload.new.date_livraison;
                cmd.statut = payload.new.statut;
                cmd.materiau = payload.new.materiau;
                cmd.poids = parseFloat(payload.new.poids) || 0;
                cmd.refCdeClient = payload.new.ref_cde_client;
                cmd.ressource = payload.new.ressource;
                cmd.semaineAffectee = payload.new.semaine_affectee;
                console.log(`✏️ Commande ${recordId} mise à jour`);
            }
            break;
        }
        case 'DELETE': {
            const idx = State.commandes.findIndex(c => c.id === recordId);
            if (idx !== -1) {
                State.commandes.splice(idx, 1);
                console.log(`🗑️ Commande ${recordId} supprimée`);
            }
            break;
        }
    }

    debouncedRealtimeUpdate();
}

/**
 * Handler pour les changements d'opérations en temps réel
 */
export function handleRealtimeOperationChange(payload) {
    const recordId = payload?.new?.id || payload?.old?.id;
    const eventType = payload.eventType;
    const commandeId = payload?.new?.commande_id || payload?.old?.commande_id;

    if (recordId && isOurOwnRealtimeEvent(recordId)) {
        // Même si c'est notre propre event, on met à jour les durées (propriété d'ETM_RP)
        // pour ne pas ignorer une modification ETM_RP qui aurait eu lieu pendant la fenêtre de 5s.
        if (eventType === 'UPDATE') {
            const cmd = State.commandes.find(c => c.id === commandeId);
            const op = cmd?.operations?.find(o => o.id === recordId);
            if (op) {
                op.dureeTotal = parseFloat(payload.new.duree_total) || 0;
                op.dureeOriginal = parseFloat(payload.new.duree_original) || 0;
                op.dureeOverride = payload.new.duree_override ? parseFloat(payload.new.duree_override) : null;
                debouncedRealtimeUpdate();
            }
        }
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif): operation ${recordId}`);
        return;
    }
    console.log(`📡 Realtime operation: ${eventType} ${recordId} (cmd: ${commandeId})`);

    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) {
        console.warn(`⚠️ Commande ${commandeId} non trouvée pour operation ${recordId}`);
        return;
    }

    if (!cmd.operations) cmd.operations = [];

    switch (eventType) {
        case 'INSERT': {
            if (!cmd.operations.find(op => op.id === recordId)) {
                cmd.operations.push(mapSupabaseOperationToLocal(payload.new));
                console.log(`➕ Operation ${recordId} ajoutée à ${commandeId}`);
            }
            break;
        }
        case 'UPDATE': {
            const op = cmd.operations.find(o => o.id === recordId);
            if (op) {
                op.type = payload.new.type;
                op.dureeTotal = parseFloat(payload.new.duree_total) || 0;
                op.dureeOriginal = parseFloat(payload.new.duree_original) || 0;
                op.dureeOverride = payload.new.duree_override ? parseFloat(payload.new.duree_override) : null;
                op.overrideTimestamp = payload.new.override_timestamp;
                op.progressionReelle = parseFloat(payload.new.progression_reelle) || 0;
                op.statut = payload.new.statut;
                console.log(`✏️ Operation ${recordId} mise à jour`);
            } else {
                // L'opération existe en DB (event reçu) mais est absente du State local —
                // INSERT Realtime probablement manqué → resync complet depuis Supabase.
                console.warn(`⚠️ Operation ${recordId} absente du State → rechargement complet`);
                forceFullReload();
            }
            break;
        }
        case 'DELETE': {
            const idx = cmd.operations.findIndex(o => o.id === recordId);
            if (idx !== -1) {
                cmd.operations.splice(idx, 1);
                console.log(`🗑️ Operation ${recordId} supprimée`);
            }
            break;
        }
    }

    debouncedRealtimeUpdate();
}

/**
 * Handler pour les changements de slots en temps réel
 */
export function handleRealtimeSlotChange(payload) {
    const recordId = payload?.new?.id || payload?.old?.id;
    const operationId = payload?.new?.operation_id || payload?.old?.operation_id;

    if (recordId && isOurOwnRealtimeEvent(recordId)) {
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif): slot ${recordId}`);
        return;
    }
    if (operationId && isOurOwnRealtimeEvent(operationId)) {
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif via operation): slot ${recordId}`);
        return;
    }

    const eventType = payload.eventType;
    console.log(`📡 Realtime slot: ${eventType} ${recordId} (op: ${operationId})`);

    let targetOp = null;
    for (const cmd of State.commandes) {
        if (!cmd.operations) continue;
        targetOp = cmd.operations.find(op => op.id === operationId);
        if (targetOp) break;
    }

    if (!targetOp) {
        console.warn(`⚠️ Operation ${operationId} non trouvée pour slot ${recordId}`);
        return;
    }

    if (!targetOp.slots) targetOp.slots = [];

    switch (eventType) {
        case 'INSERT': {
            if (!targetOp.slots.find(s => s.id === recordId)) {
                targetOp.slots.push(mapSupabaseSlotToLocal(payload.new));
                console.log(`➕ Slot ${recordId} ajouté à ${operationId}`);
            }
            break;
        }
        case 'UPDATE': {
            const slot = targetOp.slots.find(s => s.id === recordId);
            if (slot) {
                Object.assign(slot, mapSupabaseSlotToLocal(payload.new));
                console.log(`✏️ Slot ${recordId} mis à jour`);
            }
            break;
        }
        case 'DELETE': {
            const idx = targetOp.slots.findIndex(s => s.id === recordId);
            if (idx !== -1) {
                targetOp.slots.splice(idx, 1);
                console.log(`🗑️ Slot ${recordId} supprimé`);
            }
            break;
        }
    }

    debouncedRealtimeUpdate();
}

/**
 * Handler pour les changements de machines en temps réel
 */
export function handleRealtimeMachineChange(payload) {
    if (isSaving()) return;

    if (_machineDebounceTimer) clearTimeout(_machineDebounceTimer);
    _machineDebounceTimer = setTimeout(() => {
        console.log('🔄 Realtime: rechargement machines...');
        loadMachines().then(() => {
            renderMachinesManager();
            refresh();
        }).catch(err => console.error('Erreur reload machines:', err));
    }, 2000);
}

/**
 * Handler pour les changements d'événements système en temps réel
 */
export function handleRealtimeSystemEventChange(payload) {
    if (isSaving()) return;

    if (_sysEventDebounceTimer) clearTimeout(_sysEventDebounceTimer);
    _sysEventDebounceTimer = setTimeout(() => {
        console.log('🔄 Realtime: rechargement événements système...');
        loadSystemEvents().then(() => {
            renderSystemEventsList();
            refresh();
        }).catch(err => console.error('Erreur reload system events:', err));
    }, 2000);
}

/**
 * Handler pour les changements de configuration horaires en temps réel
 */
export function handleRealtimeScheduleChange(payload) {
    if (isSaving()) return;

    if (_scheduleDebounceTimer) clearTimeout(_scheduleDebounceTimer);
    _scheduleDebounceTimer = setTimeout(() => {
        console.log('🔄 Realtime: rechargement config horaires...');
        loadSchedule().then(() => {
            reloadScheduleArrays();
            renderScheduleManager();
            refresh();
        }).catch(err => console.error('Erreur reload schedule:', err));
    }, 2000);
}

/**
 * Merge les données Realtime avec les données locales
 */
export function mergeRealtimeCommandes(remoteData) {
    const localIds = new Set(State.commandes.map(c => c.id));
    const remoteIds = new Set(remoteData.map(c => c.id));

    remoteData.forEach(remoteCmd => {
        if (!localIds.has(remoteCmd.id)) {
            State.commandes.push(remoteCmd);
        } else {
            const localIndex = State.commandes.findIndex(c => c.id === remoteCmd.id);
            if (localIndex !== -1) {
                const localCmd = State.commandes[localIndex];
                const localHasSlots = localCmd.operations?.some(op => op.slots?.length > 0);
                const remoteHasSlots = remoteCmd.operations?.some(op => op.slots?.length > 0);

                if (remoteHasSlots || !localHasSlots) {
                    State.commandes[localIndex] = remoteCmd;
                }
            }
        }
    });

    State.commandes = State.commandes.filter(c => remoteIds.has(c.id) || !c.id);
}

// ===================================
// Offline Queue (localStorage — seul usage légitime)
// ===================================

/**
 * Récupère la file d'attente offline depuis localStorage
 */
export function getOfflineQueue() {
    try {
        const stored = localStorage.getItem(OFFLINE_QUEUE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Sauvegarde la file d'attente offline
 */
function saveOfflineQueue(queue) {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

/**
 * Ajoute une opération à la file d'attente offline
 */
export function addToOfflineQueue(action, data) {
    const queue = getOfflineQueue();
    queue.push({
        id: 'offline_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        action: action,
        data: data,
        timestamp: new Date().toISOString()
    });
    saveOfflineQueue(queue);
    console.log('📦 Ajouté à la file offline:', action);
}

/**
 * Traite la file d'attente offline quand la connexion revient
 */
export async function processOfflineQueue() {
    const queue = getOfflineQueue();
    if (queue.length === 0) return;

    console.log(`🔄 Traitement de ${queue.length} opération(s) en attente...`);
    Toast.info(`Synchronisation de ${queue.length} modification(s)...`);

    const failedItems = [];

    for (const item of queue) {
        try {
            let success = false;

            switch (item.action) {
                case 'save_commande':
                    if (item.data.commandeId) {
                        markCommandeDirty(item.data.commandeId);
                        await saveAllDirtyCommandes();
                        success = true;
                    }
                    break;
                case 'delete_slot':
                    await deleteSlot(item.data.slotId);
                    success = true;
                    break;
                default:
                    console.warn('Action offline inconnue:', item.action);
                    success = true;
            }

            if (!success) {
                failedItems.push(item);
            }

        } catch (e) {
            console.error('Erreur traitement offline:', e);
            failedItems.push(item);
        }
    }

    saveOfflineQueue(failedItems);

    if (failedItems.length === 0) {
        Toast.success('Toutes les modifications synchronisées !');
    } else {
        Toast.warning(`${failedItems.length} modification(s) en attente`);
    }
}

// ===================================
// Init Realtime subscriptions
// ===================================

/**
 * Initialise les subscriptions Realtime via window.initAllRealtimeSubscriptions
 * (défini dans supabase.js, chargé en global)
 */
export function initRealtime() {
    if (typeof window.initAllRealtimeSubscriptions === 'function' && State.supabaseClient) {
        window.initAllRealtimeSubscriptions({
            onCommandeChange: handleRealtimeCommandeChange,
            onOperationChange: handleRealtimeOperationChange,
            onSlotChange: handleRealtimeSlotChange,
            onMachineChange: handleRealtimeMachineChange,
            onSystemEventChange: handleRealtimeSystemEventChange,
            onShiftChange: handleRealtimeScheduleChange,
            onShiftScheduleChange: handleRealtimeScheduleChange,
            onBreakChange: handleRealtimeScheduleChange,
            onOvertimeConfigChange: handleRealtimeScheduleChange,
            onOvertimeSlotsChange: handleRealtimeScheduleChange
        });
    }

    // Listeners réseau (online/offline)
    window.addEventListener('online', () => {
        console.log('🌐 Connexion rétablie');
        window.updateRealtimeStatusUI?.('connected');
        setTimeout(() => processOfflineQueue(), 2000);
    });

    window.addEventListener('offline', () => {
        console.log('📴 Connexion perdue');
        window.updateRealtimeStatusUI?.('disconnected');
    });
}

// ===================================
// Sync handlers (simplified for V3)
// ===================================

/**
 * Initialise les handlers de synchronisation.
 * Version simplifiée V3 : pas de DataSyncManager, pas de localStorage data.
 */
export function initSyncHandlers() {
    // Sync manuelle → force reload depuis Supabase
    document.getElementById('btnSyncNow')?.addEventListener('click', () => {
        forceFullReload();
    });

    // Bouton menu data
    document.getElementById('btnDataMenu')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelector('.dropdown')?.classList.toggle('active');
    });

    // Fermer dropdown si clic ailleurs
    document.addEventListener('click', () => {
        document.querySelector('.dropdown.active')?.classList.remove('active');
    });
}

// ============================================
// ETM PROD V2 - Module Supabase Complet
// ============================================

// ============================================
// LECTURE - Chargement des données
// ============================================

// Charger les commandes avec leurs opérations et slots
async function fetchCommandesFromSupabase() {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
        .from('commandes')
        .select(`
            *,
            operations (
                *,
                slots (*)
            )
        `)
        .in('statut', ['En cours', 'Planifiée', 'En prépa'])
        .order('date_livraison', { ascending: true });

    if (error) {
        console.error('❌ Erreur chargement commandes:', error);
        return null;
    }
    return data;
}

// Charger les machines actives
async function fetchMachinesFromSupabase() {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
        .from('machines')
        .select('*')
        .eq('active', true)
        .order('type');

    if (error) {
        console.error('❌ Erreur chargement machines:', error);
        return null;
    }
    return data;
}

// Charger les événements système
async function fetchSystemEventsFromSupabase() {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
        .from('system_events')
        .select('*')
        .order('date_start', { ascending: true });

    if (error) {
        console.error('❌ Erreur chargement system_events:', error);
        return null;
    }
    return data;
}

// Charger la configuration des équipes (shifts + schedules + breaks)
async function fetchScheduleConfigFromSupabase() {
    if (!supabaseClient) return null;

    try {
        const [shiftsRes, schedulesRes, breaksRes] = await Promise.all([
            supabaseClient.from('shifts').select('*').order('name'),
            supabaseClient.from('shift_schedules').select('*'),
            supabaseClient.from('breaks').select('*').order('start_time')
        ]);

        if (shiftsRes.error) throw shiftsRes.error;
        if (schedulesRes.error) throw schedulesRes.error;
        if (breaksRes.error) throw breaksRes.error;

        return {
            shifts: shiftsRes.data,
            schedules: schedulesRes.data,
            breaks: breaksRes.data
        };
    } catch (error) {
        console.error('❌ Erreur chargement schedule config:', error);
        return null;
    }
}

// Charger la configuration des heures supplémentaires
async function fetchOvertimeConfigFromSupabase() {
    if (!supabaseClient) return null;

    try {
        const [configRes, slotsRes] = await Promise.all([
            supabaseClient.from('overtime_config').select('*').single(),
            supabaseClient.from('overtime_slots').select('*')
        ]);

        return {
            config: configRes.data || { enabled: false, max_daily_hours: 2, max_weekly_hours: 10 },
            slots: slotsRes.data || []
        };
    } catch (error) {
        console.error('❌ Erreur chargement overtime config:', error);
        return null;
    }
}

// ============================================
// ÉCRITURE - Sauvegarde des données
// ============================================

// --- SLOTS ---
async function saveSlotToSupabase(slot) {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
        .from('slots')
        .upsert({
            id: slot.id,
            operation_id: slot.operationId,
            machine_id: slot.machineId,
            machine_name: slot.machineName,
            duree: slot.duree,
            semaine: slot.semaine,
            jour: slot.jour,
            heure_debut: slot.heureDebut,
            heure_fin: slot.heureFin,
            date_debut: slot.dateDebut,
            date_fin: slot.dateFin,
            overtime: slot.overtime || false
        });

    if (error) {
        console.error('❌ Erreur sauvegarde slot:', error);
        return null;
    }
    console.log('✅ Slot sauvegardé:', slot.id);
    return data;
}

async function deleteSlotFromSupabase(slotId) {
    if (!supabaseClient) return false;

    const { error } = await supabaseClient
        .from('slots')
        .delete()
        .eq('id', slotId);

    if (error) {
        console.error('❌ Erreur suppression slot:', error);
        return false;
    }
    console.log('✅ Slot supprimé:', slotId);
    return true;
}

// --- OPERATIONS ---
async function updateOperationInSupabase(operationId, updates) {
    if (!supabaseClient) return false;

    const { error } = await supabaseClient
        .from('operations')
        .update({
            ...updates,
            updated_at: new Date().toISOString()
        })
        .eq('id', operationId);

    if (error) {
        console.error('❌ Erreur mise à jour opération:', error);
        return false;
    }
    console.log('✅ Opération mise à jour:', operationId);
    return true;
}

// --- COMMANDES ---
async function updateCommandeInSupabase(commandeId, updates) {
    if (!supabaseClient) return false;

    const { error } = await supabaseClient
        .from('commandes')
        .update({
            ...updates,
            updated_at: new Date().toISOString()
        })
        .eq('id', commandeId);

    if (error) {
        console.error('❌ Erreur mise à jour commande:', error);
        return false;
    }
    console.log('✅ Commande mise à jour:', commandeId);
    return true;
}

// --- MACHINES ---
async function saveMachineToSupabase(machine) {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
        .from('machines')
        .upsert({
            id: machine.id,
            name: machine.name,
            type: machine.type,
            capacity: machine.capacity,
            color: machine.color,
            active: machine.active
        });

    if (error) {
        console.error('❌ Erreur sauvegarde machine:', error);
        return null;
    }
    console.log('✅ Machine sauvegardée:', machine.id);
    return data;
}

async function deleteMachineFromSupabase(machineId) {
    if (!supabaseClient) return false;

    const { error } = await supabaseClient
        .from('machines')
        .delete()
        .eq('id', machineId);

    if (error) {
        console.error('❌ Erreur suppression machine:', error);
        return false;
    }
    console.log('✅ Machine supprimée:', machineId);
    return true;
}

// --- SYSTEM EVENTS ---
async function saveSystemEventToSupabase(event) {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
        .from('system_events')
        .upsert({
            id: event.id,
            type: event.type,
            machine: event.machine,
            date_start: event.dateStart,
            date_end: event.dateEnd,
            start_time_first_day: event.startTimeFirstDay,
            end_time_last_day: event.endTimeLastDay,
            full_last_day: event.fullLastDay,
            affected_machines: event.affectedMachines,
            affected_shifts: event.affectedShifts,
            description: event.description
        });

    if (error) {
        console.error('❌ Erreur sauvegarde system_event:', error);
        return null;
    }
    console.log('✅ System event sauvegardé:', event.id);
    return data;
}

async function deleteSystemEventFromSupabase(eventId) {
    if (!supabaseClient) return false;

    const { error } = await supabaseClient
        .from('system_events')
        .delete()
        .eq('id', eventId);

    if (error) {
        console.error('❌ Erreur suppression system_event:', error);
        return false;
    }
    console.log('✅ System event supprimé:', eventId);
    return true;
}

// --- SHIFTS ---
async function saveShiftToSupabase(shift, schedules) {
    if (!supabaseClient) return false;

    try {
        // 1. Upsert shift
        const { error: shiftError } = await supabaseClient
            .from('shifts')
            .upsert({
                id: shift.id,
                name: shift.name,
                active: shift.active
            });
        if (shiftError) throw shiftError;

        // 2. Delete old schedules
        await supabaseClient
            .from('shift_schedules')
            .delete()
            .eq('shift_id', shift.id);

        // 3. Insert new schedules
        if (schedules && schedules.length > 0) {
            const { error: schedError } = await supabaseClient
                .from('shift_schedules')
                .insert(schedules.map(s => ({
                    shift_id: shift.id,
                    day_name: s.dayName,
                    start_time: s.startTime,
                    end_time: s.endTime
                })));
            if (schedError) throw schedError;
        }

        console.log('✅ Shift sauvegardé:', shift.id);
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde shift:', error);
        return false;
    }
}

async function deleteShiftFromSupabase(shiftId) {
    if (!supabaseClient) return false;

    const { error } = await supabaseClient
        .from('shifts')
        .delete()
        .eq('id', shiftId);

    if (error) {
        console.error('❌ Erreur suppression shift:', error);
        return false;
    }
    console.log('✅ Shift supprimé:', shiftId);
    return true;
}

// --- BREAKS ---
async function saveBreakToSupabase(breakItem) {
    if (!supabaseClient) return null;

    const { data, error } = await supabaseClient
        .from('breaks')
        .upsert({
            id: breakItem.id,
            name: breakItem.name,
            start_time: breakItem.startTime,
            end_time: breakItem.endTime,
            days: breakItem.days,
            active: breakItem.active
        });

    if (error) {
        console.error('❌ Erreur sauvegarde break:', error);
        return null;
    }
    console.log('✅ Break sauvegardée:', breakItem.id);
    return data;
}

async function deleteBreakFromSupabase(breakId) {
    if (!supabaseClient) return false;

    const { error } = await supabaseClient
        .from('breaks')
        .delete()
        .eq('id', breakId);

    if (error) {
        console.error('❌ Erreur suppression break:', error);
        return false;
    }
    console.log('✅ Break supprimée:', breakId);
    return true;
}

// --- OVERTIME CONFIG ---
async function saveOvertimeConfigToSupabase(config, slots) {
    if (!supabaseClient) return false;

    try {
        // 1. Delete old config
        await supabaseClient.from('overtime_config').delete().neq('id', '');
        await supabaseClient.from('overtime_slots').delete().neq('id', '');

        // 2. Insert new config
        const { error: configError } = await supabaseClient
            .from('overtime_config')
            .insert({
                enabled: config.enabled,
                max_daily_hours: config.maxDailyHours,
                max_weekly_hours: config.maxWeeklyHours
            });
        if (configError) throw configError;

        // 3. Insert slots
        if (slots && slots.length > 0) {
            const { error: slotsError } = await supabaseClient
                .from('overtime_slots')
                .insert(slots.map(s => ({
                    days: s.days,
                    start_time: s.startTime,
                    end_time: s.endTime
                })));
            if (slotsError) throw slotsError;
        }

        console.log('✅ Overtime config sauvegardée');
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde overtime config:', error);
        return false;
    }
}

// ============================================
// REALTIME - Subscriptions temps réel
// ============================================

let realtimeChannels = [];

// Fonction générique de subscription
function subscribeToTable(tableName, callback) {
    if (!supabaseClient) return null;

    const channel = supabaseClient
        .channel(`${tableName}-changes`)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: tableName },
            (payload) => {
                console.log(`📥 ${tableName}:`, payload.eventType, payload.new?.id || payload.old?.id || '');
                callback(payload);
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log(`📡 Realtime ${tableName}: connecté`);
            }
        });

    realtimeChannels.push(channel);
    return channel;
}

// Subscriptions individuelles
function subscribeToCommandes(callback) {
    return subscribeToTable('commandes', callback);
}

function subscribeToOperations(callback) {
    return subscribeToTable('operations', callback);
}

function subscribeToSlots(callback) {
    return subscribeToTable('slots', callback);
}

function subscribeToMachines(callback) {
    return subscribeToTable('machines', callback);
}

function subscribeToSystemEvents(callback) {
    return subscribeToTable('system_events', callback);
}

function subscribeToShifts(callback) {
    return subscribeToTable('shifts', callback);
}

function subscribeToShiftSchedules(callback) {
    return subscribeToTable('shift_schedules', callback);
}

function subscribeToBreaks(callback) {
    return subscribeToTable('breaks', callback);
}

function subscribeToOvertimeConfig(callback) {
    return subscribeToTable('overtime_config', callback);
}

function subscribeToOvertimeSlots(callback) {
    return subscribeToTable('overtime_slots', callback);
}

// Initialiser TOUTES les subscriptions Realtime
function initAllRealtimeSubscriptions(handlers = {}) {
    console.log('🔄 Initialisation Realtime complète...');

    // Données de planification
    if (handlers.onCommandeChange) subscribeToCommandes(handlers.onCommandeChange);
    if (handlers.onOperationChange) subscribeToOperations(handlers.onOperationChange);
    if (handlers.onSlotChange) subscribeToSlots(handlers.onSlotChange);

    // Configuration
    if (handlers.onMachineChange) subscribeToMachines(handlers.onMachineChange);
    if (handlers.onSystemEventChange) subscribeToSystemEvents(handlers.onSystemEventChange);

    // Horaires
    if (handlers.onShiftChange) subscribeToShifts(handlers.onShiftChange);
    if (handlers.onShiftScheduleChange) subscribeToShiftSchedules(handlers.onShiftScheduleChange);
    if (handlers.onBreakChange) subscribeToBreaks(handlers.onBreakChange);

    // Overtime
    if (handlers.onOvertimeConfigChange) subscribeToOvertimeConfig(handlers.onOvertimeConfigChange);
    if (handlers.onOvertimeSlotsChange) subscribeToOvertimeSlots(handlers.onOvertimeSlotsChange);

    console.log('✅ Realtime initialisé:', realtimeChannels.length, 'channels');
}

// Se désabonner de tous les channels
function unsubscribeAllRealtime() {
    realtimeChannels.forEach(channel => {
        supabaseClient.removeChannel(channel);
    });
    realtimeChannels = [];
    console.log('🔌 Realtime déconnecté');
}

// ============================================
// UTILITAIRES
// ============================================

function isSupabaseReady() {
    return supabaseClient !== null;
}

function getRealtimeStatus() {
    return {
        connected: realtimeChannels.length > 0,
        channels: realtimeChannels.length
    };
}

console.log('📦 Module supabase.js chargé (complet)');

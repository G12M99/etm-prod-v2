/**
 * @module system-events
 * @description Gestion des événements système :
 *              maintenances et fermetures (CRUD, expansion, conflits).
 * @requires state.js, utils.js, scheduling.js, db.js, ui-list.js
 */

import { State, markCommandeDirty } from './state.js';
import {
    timeToDecimalHours, getWeekNumber, getISOWeekYear,
    getDateFromWeekDay, DAYS_OF_WEEK, formatDate,
    formatDecimalTime, Toast
} from './utils.js';
import { getScheduleForDay } from './scheduling.js';
import { saveSystemEvents as dbSaveSystemEvents } from './db.js';
import { refresh } from './ui-list.js';

// ===================================
// Local state
// ===================================
let editingEventId = null;

// ===================================
// Utility functions
// ===================================

/**
 * Détecter si un événement est au format multi-jours (v2)
 */
export function isMultiDayEvent(event) {
    return event.version === 2 || event.dateStart !== undefined;
}

/**
 * Compter les jours ouvrables entre deux dates
 */
export function countWorkingDays(startDate, endDate) {
    let count = 0;
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
        const dayIdx = current.getDay();
        if (dayIdx !== 0 && dayIdx !== 6) count++;
        current.setDate(current.getDate() + 1);
    }
    return count;
}

/**
 * Calculer les horaires effectifs pour un jour donné dans un événement multi-jours
 */
export function getEffectiveHoursForDay(event, targetDateStr, dayName) {
    const isFirstDay = (targetDateStr === event.dateStart);
    const isLastDay = (targetDateStr === event.dateEnd);
    const schedule = getScheduleForDay(dayName);

    let effectiveStart, effectiveEnd;

    if (isFirstDay && isLastDay) {
        effectiveStart = event.startTimeFirstDay;
        effectiveEnd = event.endTimeLastDay;
    } else if (isFirstDay) {
        effectiveStart = event.startTimeFirstDay;
        effectiveEnd = (event.type === 'fermeture')
            ? formatDecimalTime(schedule.overtimeEnd)
            : formatDecimalTime(schedule.standardEnd);
    } else if (isLastDay) {
        effectiveStart = formatDecimalTime(schedule.start);
        if (event.fullLastDay) {
            effectiveEnd = formatDecimalTime(schedule.overtimeEnd);
        } else {
            effectiveEnd = event.endTimeLastDay;
        }
    } else {
        effectiveStart = formatDecimalTime(schedule.start);
        effectiveEnd = (event.type === 'fermeture')
            ? formatDecimalTime(schedule.overtimeEnd)
            : formatDecimalTime(schedule.standardEnd);
    }

    return { effectiveStart, effectiveEnd };
}

/**
 * Expanser un événement multi-jours en liste de jours individuels
 */
export function expandMultiDayEvent(event) {
    if (!isMultiDayEvent(event)) {
        return [event];
    }

    const expanded = [];
    let current = new Date(event.dateStart);
    const endDate = new Date(event.dateEnd);
    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

    while (current <= endDate) {
        const dayIdx = current.getDay();
        if (dayIdx !== 0 && dayIdx !== 6) {
            const currentStr = current.toISOString().split('T')[0];
            const dayName = dayNames[dayIdx];
            const { effectiveStart, effectiveEnd } = getEffectiveHoursForDay(event, currentStr, dayName);

            expanded.push({
                ...event,
                _expanded: true,
                _parentId: event.id,
                dateStr: currentStr,
                day: dayName,
                week: getWeekNumber(current),
                year: getISOWeekYear(current),
                startTime: effectiveStart,
                endTime: effectiveEnd
            });
        }
        current.setDate(current.getDate() + 1);
    }

    return expanded;
}

/**
 * Obtenir tous les événements expansés pour l'affichage dans le planning
 */
export function getExpandedSystemEvents() {
    return State.systemEvents.flatMap(e => expandMultiDayEvent(e));
}

// ===================================
// Save / Delete
// ===================================

function saveSystemEvents() {
    dbSaveSystemEvents(State.systemEvents);
}

async function deleteSystemEventFromSupabase(id) {
    if (!State.supabaseClient) return;
    try {
        await State.supabaseClient
            .from('system_events')
            .delete()
            .eq('id', id);
        console.log(`✅ System event ${id} supprimé de Supabase`);
    } catch (e) {
        console.error('❌ Erreur suppression system event Supabase:', e);
    }
}

// ===================================
// UI toggles
// ===================================

function toggleMachineSelect() {
    const type = document.getElementById('sysEventType').value;
    const group = document.getElementById('sysMachineGroup');
    group.style.display = (type === 'fermeture') ? 'none' : 'block';
    updateFullLastDayVisibility();
}

function updateFullLastDayVisibility() {
    const dateStart = document.getElementById('sysDateStart').value;
    const dateEnd = document.getElementById('sysDateEnd').value;
    const type = document.getElementById('sysEventType').value;
    const group = document.getElementById('fullLastDayGroup');
    const checkbox = document.getElementById('sysFullLastDay');

    if (type === 'fermeture' && dateStart && dateEnd && dateStart !== dateEnd) {
        group.style.display = 'block';
    } else {
        group.style.display = 'none';
        if (checkbox) checkbox.checked = false;
    }
}

// Global for onchange HTML
window.toggleMachineSelect = toggleMachineSelect;
window.updateFullLastDayVisibility = updateFullLastDayVisibility;

// ===================================
// Modal open / add / edit / delete
// ===================================

function openSystemEventsModal() {
    const modal = document.getElementById('modalSystemEvents');
    const machineSelect = document.getElementById('sysMachine');

    machineSelect.innerHTML = State.ALL_MACHINES.map(m => `<option value="${m}">${m}</option>`).join('');

    const today = new Date().toISOString().split('T')[0];
    document.getElementById('sysDateStart').value = today;
    document.getElementById('sysDateEnd').value = today;

    document.getElementById('sysFullLastDay').checked = false;
    updateFullLastDayVisibility();

    renderSystemEventsList();
    modal.classList.add('active');
}

function addSystemEvent() {
    const type = document.getElementById('sysEventType').value;
    const machine = (type === 'fermeture') ? 'ALL' : document.getElementById('sysMachine').value;
    const dateStart = document.getElementById('sysDateStart').value;
    const dateEnd = document.getElementById('sysDateEnd').value;
    const startTime = document.getElementById('sysStart').value;
    const endTime = document.getElementById('sysEnd').value;
    const reason = document.getElementById('sysReason').value || (type === 'maintenance' ? 'Maintenance' : 'Fermeture');

    if (!dateStart || !dateEnd || !startTime || !endTime) {
        alert("Veuillez saisir les dates et les horaires.");
        return;
    }

    const startDate = new Date(dateStart);
    const endDate = new Date(dateEnd);

    if (startDate > endDate) {
        alert("La date de fin doit être après la date de début.");
        return;
    }

    if (dateStart === dateEnd) {
        const startDec = timeToDecimalHours(startTime);
        const endDec = timeToDecimalHours(endTime);
        if (endDec <= startDec) {
            alert("L'heure de fin doit être après l'heure de début.");
            return;
        }
    }

    const workingDaysCount = countWorkingDays(startDate, endDate);
    if (workingDaysCount === 0) {
        alert("Aucun jour ouvrable (Lundi-Vendredi) dans la période sélectionnée.");
        return;
    }

    const fullLastDay = document.getElementById('sysFullLastDay').checked;
    const newEvent = {
        id: editingEventId || ('SYS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5)),
        version: 2,
        type,
        machine,
        dateStart,
        dateEnd,
        startTimeFirstDay: startTime,
        endTimeLastDay: endTime,
        fullLastDay: fullLastDay,
        reason,
        createdAt: new Date().toISOString()
    };

    if (editingEventId) {
        State.systemEvents = State.systemEvents.filter(e => e.id !== editingEventId);
    }

    const totalDisplaced = resolveSystemEventConflictsV2(newEvent);

    State.systemEvents.push(newEvent);
    saveSystemEvents();
    renderSystemEventsList();
    refresh();

    if (totalDisplaced > 0) {
        alert(`⚠️ ${totalDisplaced} opération(s) ont été déplacées vers "Commandes à placer" suite à ce blocage.`);
    } else if (editingEventId) {
        Toast.success("Blocage modifié avec succès");
    } else {
        Toast.success(`Blocage ajouté (${workingDaysCount} jour(s) ouvrable(s))`);
    }

    editingEventId = null;
    resetSystemEventForm();
}

// ===================================
// Conflict resolution
// ===================================

function resolveSystemEventConflicts(event) {
    let displacedCount = 0;
    const eventStart = timeToDecimalHours(event.startTime);
    const eventEnd = timeToDecimalHours(event.endTime);

    State.commandes.forEach(cmd => {
        let cmdModified = false;

        cmd.operations.forEach(op => {
            if (!op.slots || op.slots.length === 0) return;

            const hasConflict = op.slots.some(slot => {
                if (slot.semaine !== event.week) return false;
                if (slot.jour !== event.day) return false;
                if (event.machine !== 'ALL' && slot.machine !== event.machine) return false;

                const slotStart = timeToDecimalHours(slot.heureDebut);
                const slotEnd = timeToDecimalHours(slot.heureFin);

                return (slotStart < eventEnd - 0.001) && (slotEnd > eventStart + 0.001);
            });

            if (hasConflict) {
                op.slots = [];
                op.statut = "Non placée";
                op.progressionReelle = 0;
                cmdModified = true;
                displacedCount++;
                console.log(`⚠️ Conflit détecté: Opération ${op.type} de ${cmd.id} retirée du planning.`);
            }
        });

        if (cmdModified) {
            const anyPlaced = cmd.operations.some(op => op.slots && op.slots.length > 0);
            cmd.statut = anyPlaced ? "En cours" : "Non placée";
        }
    });

    return displacedCount;
}

function resolveSystemEventConflictsV2(event) {
    let displacedCount = 0;
    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

    State.commandes.forEach(cmd => {
        let cmdModified = false;

        cmd.operations.forEach(op => {
            if (!op.slots || op.slots.length === 0) return;

            const hasConflict = op.slots.some(slot => {
                if (event.machine !== 'ALL' && slot.machine !== event.machine) return false;

                let slotDateStr;
                if (slot.dateDebut) {
                    slotDateStr = slot.dateDebut.split('T')[0];
                } else {
                    const slotDate = getDateFromWeekDay(slot.semaine, slot.jour, slot.heureDebut);
                    slotDateStr = slotDate.toISOString().split('T')[0];
                }

                if (isMultiDayEvent(event)) {
                    if (slotDateStr < event.dateStart || slotDateStr > event.dateEnd) {
                        return false;
                    }

                    const { effectiveStart, effectiveEnd } = getEffectiveHoursForDay(
                        event, slotDateStr, slot.jour
                    );

                    const eventStartDec = timeToDecimalHours(effectiveStart);
                    const eventEndDec = timeToDecimalHours(effectiveEnd);
                    const slotStart = timeToDecimalHours(slot.heureDebut);
                    const slotEnd = timeToDecimalHours(slot.heureFin);

                    return (slotStart < eventEndDec - 0.001) && (slotEnd > eventStartDec + 0.001);
                }

                if (slot.semaine !== event.week) return false;
                if (slot.jour !== event.day) return false;

                const eventStart = timeToDecimalHours(event.startTime);
                const eventEnd = timeToDecimalHours(event.endTime);
                const slotStart = timeToDecimalHours(slot.heureDebut);
                const slotEnd = timeToDecimalHours(slot.heureFin);

                return (slotStart < eventEnd - 0.001) && (slotEnd > eventStart + 0.001);
            });

            if (hasConflict) {
                op.slots = [];
                op.statut = "Non placée";
                op.progressionReelle = 0;
                cmdModified = true;
                displacedCount++;
                console.log(`⚠️ Conflit détecté: Opération ${op.type} de ${cmd.id} retirée du planning.`);
            }
        });

        if (cmdModified) {
            const anyPlaced = cmd.operations.some(op => op.slots && op.slots.length > 0);
            cmd.statut = anyPlaced ? "En cours" : "Non placée";
        }
    });

    return displacedCount;
}

// ===================================
// Delete
// ===================================

function deleteSystemEvent(id) {
    deleteSystemEventFromSupabase(id);

    State.systemEvents = State.systemEvents.filter(e => e.id !== id);
    saveSystemEvents();
    renderSystemEventsList();
    refresh();
    Toast.info("Blocage supprimé");
}

// ===================================
// Render list
// ===================================

export function renderSystemEventsList() {
    const container = document.getElementById('systemEventsList');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    const activeEvents = State.systemEvents.filter(e => {
        if (isMultiDayEvent(e)) {
            return e.dateEnd >= todayStr;
        } else {
            return e.dateStr >= todayStr;
        }
    });

    if (activeEvents.length === 0) {
        container.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#999;">Aucun blocage actif</td></tr>';
        return;
    }

    const sorted = [...activeEvents].sort((a, b) => {
        const dateA = isMultiDayEvent(a) ? a.dateStart : a.dateStr;
        const dateB = isMultiDayEvent(b) ? b.dateStart : b.dateStr;
        return dateA.localeCompare(dateB);
    });

    container.innerHTML = sorted.map(e => {
        const isMultiDay = isMultiDayEvent(e);

        let periodDisplay;
        if (isMultiDay) {
            const start = new Date(e.dateStart);
            const end = new Date(e.dateEnd);
            const isSingleDay = e.dateStart === e.dateEnd;

            if (isSingleDay) {
                periodDisplay = `
                    <span style="font-weight:bold">${start.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'2-digit'})}</span><br>
                    <small>${e.startTimeFirstDay} - ${e.endTimeLastDay}</small>
                `;
            } else {
                periodDisplay = `
                    <span style="font-weight:bold">
                        ${start.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit'})} -
                        ${end.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'2-digit'})}
                    </span><br>
                    <small>Début: ${e.startTimeFirstDay} | Fin: ${e.endTimeLastDay}</small>
                `;
            }
        } else {
            periodDisplay = `
                ${e.dateStr ? `<span style="font-weight:bold">${new Date(e.dateStr).toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit'})}</span>` : ''}
                S${e.week} ${e.day}<br>
                <small>${e.startTime} - ${e.endTime}</small>
            `;
        }

        return `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding:10px;">
                    <span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.85em;
                                 background:${e.type === 'fermeture' ? '#f8d7da' : '#fff3cd'};
                                 color:${e.type === 'fermeture' ? '#721c24' : '#856404'};">
                        ${e.type === 'fermeture' ? 'Fermeture' : 'Maintenance'}
                    </span>
                </td>
                <td style="padding:10px; font-weight:500;">
                    ${e.machine === 'ALL' ? 'Toutes les machines' : e.machine}
                </td>
                <td style="padding:10px;">${periodDisplay}</td>
                <td style="padding:10px; color:#666;">${e.reason}</td>
                <td style="padding:10px; text-align:right;">
                    <button class="btn btn-sm btn-secondary" onclick="editSystemEvent('${e.id}')"
                            style="margin-right:5px;">Modifier</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteSystemEvent('${e.id}')">Supprimer</button>
                </td>
            </tr>
        `;
    }).join('');
}

// ===================================
// Edit event
// ===================================

function editSystemEvent(id) {
    const event = State.systemEvents.find(e => e.id === id);
    if (!event) {
        Toast.error("Événement introuvable");
        return;
    }

    editingEventId = id;

    document.getElementById('sysEventType').value = event.type;
    toggleMachineSelect();

    if (event.machine !== 'ALL') {
        document.getElementById('sysMachine').value = event.machine;
    }

    if (isMultiDayEvent(event)) {
        document.getElementById('sysDateStart').value = event.dateStart;
        document.getElementById('sysDateEnd').value = event.dateEnd;
        document.getElementById('sysStart').value = event.startTimeFirstDay;
        document.getElementById('sysEnd').value = event.endTimeLastDay;
    } else {
        document.getElementById('sysDateStart').value = event.dateStr;
        document.getElementById('sysDateEnd').value = event.dateStr;
        document.getElementById('sysStart').value = event.startTime;
        document.getElementById('sysEnd').value = event.endTime;
    }

    document.getElementById('sysFullLastDay').checked = event.fullLastDay || false;
    updateFullLastDayVisibility();

    document.getElementById('sysReason').value = event.reason || '';

    const addBtn = document.getElementById('btnAddSystemEvent');
    if (addBtn) {
        addBtn.textContent = 'Sauvegarder les modifications';
        addBtn.classList.remove('btn-primary');
        addBtn.classList.add('btn-success');
    }

    if (!document.getElementById('btnCancelEdit')) {
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'btnCancelEdit';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Annuler';
        cancelBtn.style.marginLeft = '10px';
        cancelBtn.onclick = cancelEditSystemEvent;
        if (addBtn && addBtn.parentNode) {
            addBtn.parentNode.appendChild(cancelBtn);
        }
    }

    Toast.info("Mode édition activé");
}

function cancelEditSystemEvent() {
    editingEventId = null;
    resetSystemEventForm();
    Toast.info("Édition annulée");
}

function resetSystemEventForm() {
    document.getElementById('sysEventType').value = 'maintenance';
    toggleMachineSelect();

    const today = new Date().toISOString().split('T')[0];
    document.getElementById('sysDateStart').value = today;
    document.getElementById('sysDateEnd').value = today;
    document.getElementById('sysStart').value = '07:30';
    document.getElementById('sysEnd').value = '16:30';
    document.getElementById('sysReason').value = '';

    const addBtn = document.getElementById('btnAddSystemEvent');
    if (addBtn) {
        addBtn.textContent = 'Ajouter le blocage';
        addBtn.classList.remove('btn-success');
        addBtn.classList.add('btn-primary');
    }

    const cancelBtn = document.getElementById('btnCancelEdit');
    if (cancelBtn) {
        cancelBtn.remove();
    }
}

// ===================================
// Event handlers init
// ===================================

export function initSystemEventsHandlers() {
    document.getElementById('btnManageSystemEvents')?.addEventListener('click', openSystemEventsModal);

    document.getElementById('btnCloseSystemEvents')?.addEventListener('click', () => {
        document.getElementById('modalSystemEvents').classList.remove('active');
    });

    document.getElementById('btnAddSystemEvent')?.addEventListener('click', addSystemEvent);

    document.getElementById('modalSystemEvents')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalSystemEvents') {
            document.getElementById('modalSystemEvents').classList.remove('active');
        }
    });
}

// ===================================
// Window exports for onclick in HTML
// ===================================
window.deleteSystemEvent = deleteSystemEvent;
window.editSystemEvent = editSystemEvent;
window.cancelEditSystemEvent = cancelEditSystemEvent;
window.getExpandedSystemEvents = getExpandedSystemEvents;
window.isMultiDayEvent = isMultiDayEvent;
window.getEffectiveHoursForDay = getEffectiveHoursForDay;

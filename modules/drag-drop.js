/**
 * @module drag-drop
 * @description Gestion complète du drag & drop dans les vues Semaine et Journée.
 *   Inclut handleDrop (la fonction la plus complexe de l'app, ~450 lignes).
 * @requires state.js, utils.js, scheduling.js, db.js, ui-day.js, ui-sidebar.js, ui-list.js
 */

import { State, markCommandeDirty, historyManager } from './state.js';
import {
    formatDecimalTime, timeToDecimalHours, generateSlotId,
    getDateFromWeekDay, getWeekNumber, formatHours, Toast
} from './utils.js';
import {
    getPlacedOrders, getGlobalScheduleRangeForDay, getBlockedZonesForDay,
    isTimeInBlockedZone, isInOvertimeZone, findFirstAvailableGap, findNextGap,
    calculateEndTimeWithBreaks, detectOvertimeOverflow
} from './scheduling.js';
import { saveDataImmediate, saveData, deleteAllSlotsForOperation } from './db.js';
import { renderVueJournee } from './ui-day.js';
import { renderCommandesNonPlacees } from './ui-sidebar.js';
import { refresh } from './ui-list.js';
import {
    replanifierOperationsSuivantes, splitAtNormalHoursEnd
} from './auto-place.js';
import { showOvertimeConfirmDialog } from './urgent.js';

// ===================================
// initDragAndDrop
// ===================================

/**
 * Attach all drag & drop listeners to the current DOM.
 * Called after each view render.
 */
export function initDragAndDrop() {
    // Draggable operation slots on timeline
    document.querySelectorAll('.operation-slot.draggable').forEach(slot => {
        slot.addEventListener('dragstart', handleDragStart);
        slot.addEventListener('dragend', handleDragEnd);
    });

    // Drop zones (time-slot cells)
    document.querySelectorAll('.drop-zone').forEach(zone => {
        zone.addEventListener('dragover', handleDragOver);
        zone.addEventListener('drop', handleDrop);
        zone.addEventListener('dragleave', handleDragLeave);
    });

    // Sidebar Drop Zone (to unplan)
    const sidebarZone = document.getElementById('unplacedOrdersContainer');
    if (sidebarZone) {
        sidebarZone.addEventListener('dragover', handleDragOver);
        sidebarZone.addEventListener('drop', handleSidebarDrop);
        sidebarZone.addEventListener('dragleave', handleDragLeave);
    }

    // Workflow 2 étapes: "A placer" badges draggable for de-assignment
    document.querySelectorAll('.command-badge-aplacer[draggable="true"]').forEach(badge => {
        badge.addEventListener('dragstart', handleDesaffectationDragStart);
        badge.addEventListener('dragend', handleDesaffectationDragEnd);
    });

    // De-assignment drop zone (in sidebar week view)
    const desaffectZone = document.getElementById('dropzoneDesaffect');
    if (desaffectZone) {
        desaffectZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('drag-over');
        });
        desaffectZone.addEventListener('dragleave', (e) => {
            e.currentTarget.classList.remove('drag-over');
        });
        desaffectZone.addEventListener('drop', handleDesaffectationDrop);
    }
}

// ===================================
// Sidebar Drop (unplan operation)
// ===================================

/**
 * Handle drop on sidebar — unplan operation.
 * Cascade only if Cisaillage is removed.
 */
export function handleSidebarDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active');

    if (!State.draggedOperation) return;
    if (State.draggedOperation.fromSidebar) return;

    const cmd = State.commandes.find(c => c.id === State.draggedOperation.commandeId);
    if (!cmd) return;

    const operation = cmd.operations.find(op => op.type === State.draggedOperation.operationType);
    if (!operation) return;

    const operationType = operation.type;
    let removedCount = 0;

    if (operationType === 'Cisaillage') {
        if (!confirm(`Retirer Cisaillage de la commande ${cmd.id} ?\n\nCela retirera \u00e9galement Poin\u00e7onnage et Pliage.`)) {
            return;
        }

        cmd.operations.forEach(op => {
            if (op.slots && op.slots.length > 0) {
                if (op.id) {
                    deleteAllSlotsForOperation(op.id);
                }
                op.slots = [];
                op.statut = 'Non plac\u00e9e';
                op.progressionReelle = 0;
                removedCount++;
            }
        });
    } else {
        if (!confirm(`Retirer ${operationType} de la commande ${cmd.id} ?`)) {
            return;
        }

        if (operation.id) {
            deleteAllSlotsForOperation(operation.id);
        }
        operation.slots = [];
        operation.statut = 'Non plac\u00e9e';
        operation.progressionReelle = 0;
        removedCount = 1;
    }

    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
    const anyPlaced = cmd.operations.some(op => op.slots && op.slots.length > 0);

    if (allPlaced) cmd.statut = 'Planifi\u00e9e';
    else if (anyPlaced) cmd.statut = 'En cours';
    else cmd.statut = 'Non plac\u00e9e';

    historyManager.saveState(`Unplan ${cmd.id} (${removedCount} ops)`);
    markCommandeDirty(cmd.id);
    saveData(cmd.id);
    refresh();
    Toast.info(`${removedCount} op\u00e9ration(s) retir\u00e9e(s) du planning`);
}

// ===================================
// Basic drag handlers
// ===================================

export function handleDragStart(e) {
    State.draggedOperation = JSON.parse(e.target.getAttribute('data-operation'));
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active');
    e.dataTransfer.effectAllowed = 'move';
}

export function handleSidebarDragStart(e) {
    State.draggedOperation = JSON.parse(e.target.getAttribute('data-sidebar-operation'));
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active');
    e.dataTransfer.effectAllowed = 'move';
}

export function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    document.body.classList.remove('dragging-active');
    document.querySelectorAll('.drop-zone').forEach(zone => {
        zone.classList.remove('drag-over');
    });
}

export function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
}

export function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

// ===================================
// Week affectation drag & drop
// ===================================

/**
 * Drag start for a full command (week view affectation).
 */
export function handleCommandeDragStart(e) {
    State.draggedOperation = JSON.parse(e.target.getAttribute('data-commande-affectation'));
    State.draggedOperation.isCommandeAffectation = true;
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active');
    e.dataTransfer.effectAllowed = 'move';
}

/**
 * Drop on a week cell — assign command to week.
 */
export async function handleWeekCellDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active');

    if (!State.draggedOperation || !State.draggedOperation.isCommandeAffectation) {
        State.draggedOperation = null;
        return;
    }

    const targetWeek = parseInt(e.currentTarget.getAttribute('data-week'));
    const targetYear = parseInt(e.currentTarget.getAttribute('data-year'));

    const cmd = State.commandes.find(c => c.id === State.draggedOperation.commandeId);
    if (!cmd) {
        Toast.error('Commande non trouv\u00e9e');
        State.draggedOperation = null;
        return;
    }

    const weekStr = `${targetYear}-W${String(targetWeek).padStart(2, '0')}`;
    cmd.semaineAffectee = weekStr;

    historyManager.saveState(`Affectation ${cmd.id} \u00e0 S${targetWeek}`);

    markCommandeDirty(cmd.id);
    saveData(cmd.id);

    Toast.success(`Commande ${cmd.id} affect\u00e9e \u00e0 la semaine ${targetWeek}`);
    refresh();

    State.draggedOperation = null;
}

// ===================================
// De-assignment drag & drop
// ===================================

/**
 * Unassign a command from its week + remove all slots.
 * @param {string} commandeId
 */
export function desaffecterCommande(commandeId) {
    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) {
        Toast.error('Commande non trouv\u00e9e');
        return;
    }

    const hasSlots = cmd.operations.some(op => op.slots && op.slots.length > 0);

    let confirmMsg = `Retirer la commande ${commandeId} de la semaine ?`;
    if (hasSlots) {
        confirmMsg += `\n\nATTENTION: Les op\u00e9rations d\u00e9j\u00e0 plac\u00e9es seront \u00e9galement retir\u00e9es du planning.`;
    }

    if (!confirm(confirmMsg)) return;

    cmd.operations.forEach(op => {
        if (op.slots && op.slots.length > 0) {
            if (op.id) {
                deleteAllSlotsForOperation(op.id);
            }
            op.slots = [];
            op.statut = 'Non plac\u00e9e';
            op.progressionReelle = 0;
        }
    });

    cmd.semaineAffectee = null;
    cmd.statut = 'Non plac\u00e9e';

    historyManager.saveState(`D\u00e9saffectation ${commandeId}`);

    markCommandeDirty(commandeId);
    saveData(commandeId);

    Toast.info(`Commande ${commandeId} retir\u00e9e de la planification`);
    refresh();
}

export function handleDesaffectationDragStart(e) {
    const data = JSON.parse(e.target.getAttribute('data-commande-desaffectation'));
    State.draggedOperation = { ...data, isCommandeAffectation: true };
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active');
    document.body.classList.add('dragging-desaffectation');
    e.dataTransfer.effectAllowed = 'move';
}

export function handleDesaffectationDragEnd(e) {
    e.target.classList.remove('dragging');
    document.body.classList.remove('dragging-active');
    document.body.classList.remove('dragging-desaffectation');
    document.querySelectorAll('.sidebar-dropzone-desaffect').forEach(zone => {
        zone.classList.remove('drag-over');
    });
}

export function handleDesaffectationDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active');
    document.body.classList.remove('dragging-desaffectation');

    if (!State.draggedOperation || !State.draggedOperation.isDesaffectation) {
        State.draggedOperation = null;
        return;
    }

    const commandeId = State.draggedOperation.commandeId;
    State.draggedOperation = null;

    desaffecterCommande(commandeId);
}

// ===================================
// isMachineAvailable
// ===================================

/**
 * Check if a specific time slot is available on a machine.
 * @param {string} machine
 * @param {string} day
 * @param {number} week
 * @param {string} startTime - HH:MM
 * @param {number} duration - hours
 * @returns {{ valid: boolean, reason: string }}
 */
export function isMachineAvailable(machine, day, week, startTime, duration) {
    const EPSILON = 0.001;
    const start = timeToDecimalHours(startTime);
    const end = start + duration;

    const globalSchedule = getGlobalScheduleRangeForDay(day);
    const dayStart = globalSchedule.globalStart;
    const dayEnd = globalSchedule.globalEnd;

    if (start < dayStart - EPSILON) {
        return { valid: false, reason: `L'horaire de d\u00e9but (${startTime}) est avant l'ouverture (${formatDecimalTime(dayStart)}).` };
    }
    if (end > dayEnd + EPSILON) {
        return { valid: false, reason: `L'op\u00e9ration se termine \u00e0 ${formatDecimalTime(end)}, ce qui d\u00e9passe la fermeture (${formatDecimalTime(dayEnd)}).` };
    }

    const blockedZones = getBlockedZonesForDay(day);
    for (const zone of blockedZones) {
        if (start >= zone.start && end <= zone.end) {
            return { valid: false, reason: `L'op\u00e9ration ne peut pas \u00eatre plac\u00e9e enti\u00e8rement dans "${zone.name}".` };
        }
    }

    const placedOrders = getPlacedOrders();
    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot =>
            slot.machine === machine &&
            slot.jour === day &&
            slot.semaine === week
        );

    for (const slot of slots) {
        const sStart = timeToDecimalHours(slot.heureDebut);
        const sEnd = timeToDecimalHours(slot.heureFin);

        if (start < sEnd - EPSILON && end > sStart + EPSILON) {
            return { valid: false, reason: `La machine est occup\u00e9e de ${slot.heureDebut} \u00e0 ${slot.heureFin} par une autre op\u00e9ration.` };
        }
    }

    return { valid: true, reason: '' };
}

// ===================================
// handleDrop — Core placement logic (~450 lines)
// ===================================

/**
 * Main drop handler for placing/moving operations on the timeline.
 * The most complex function in the application.
 */
export async function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active');

    const targetMachine = e.currentTarget.getAttribute('data-machine');
    const targetDay = e.currentTarget.getAttribute('data-day');
    const targetWeek = parseInt(e.currentTarget.getAttribute('data-week'));
    const targetHour = e.currentTarget.getAttribute('data-hour');
    const targetTime = e.currentTarget.getAttribute('data-time');

    if (!State.draggedOperation) return;

    // 1. Identify Command & Operation
    const cmd = State.commandes.find(c => c.id === State.draggedOperation.commandeId);
    if (!cmd) return;
    const operation = cmd.operations.find(op => op.type === State.draggedOperation.operationType);
    if (!operation) return;

    // 2. Backup current state (in case of failure)
    const originalSlots = JSON.parse(JSON.stringify(operation.slots));
    const originalStatut = operation.statut;

    // Helper for restore on error
    function restoreAndAlert(msg) {
        operation.slots = originalSlots;
        operation.statut = originalStatut;
        alert(msg);
        refresh();
    }

    // CHECK MACHINE COMPATIBILITY
    if (targetMachine) {
        let validMachines = [];
        if (operation.type === 'Cisaillage') validMachines = State.MACHINES.cisailles;
        else if (operation.type === 'Poin\u00e7onnage') validMachines = State.MACHINES.poinconneuses;
        else if (operation.type === 'Pliage') validMachines = State.MACHINES.plieuses;

        if (!validMachines.includes(targetMachine)) {
            restoreAndAlert(`Impossible : ${operation.type} ne peut pas \u00eatre r\u00e9alis\u00e9 sur ${targetMachine}.`);
            return;
        }
    }

    // 3. Multi-fragment detection
    if (operation.slots.length > 1) {
        console.log(`\ud83d\udd17 Op\u00e9ration multi-fragments d\u00e9tect\u00e9e (${operation.slots.length} parties) \u2192 tentative de fusion`);
    }

    let durationToPlace = operation.dureeTotal;

    // 4. Calculate Search Start Time
    let dropDecimal = 7.5;
    if (targetHour) {
        dropDecimal = parseFloat(targetHour);
    }
    if (targetTime) {
        const parts = targetTime.split(':');
        dropDecimal = parseInt(parts[0]) + parseInt(parts[1]) / 60;
    }

    // Validate drop not in blocked zone
    const blockedZone = isTimeInBlockedZone(targetDay, dropDecimal);
    if (blockedZone) {
        alert(`Impossible : ${formatDecimalTime(dropDecimal)} est dans "${blockedZone.name}"`);
        return;
    }

    let searchWeek = targetWeek;
    let searchDay = targetDay;
    let searchYear = State.anneeSelectionnee;

    // Year rollover correction
    const now = new Date();
    const currentWeekNum = getWeekNumber(now);
    if (currentWeekNum > 40 && searchWeek < 10 && searchYear === now.getFullYear()) {
        searchYear++;
    }

    // B. Strict Global Chronology Constraints
    let chronologyMinDecimal = 0;
    const targetDateStart = getDateFromWeekDay(searchWeek, searchDay, '00:00', searchYear);
    const targetDateEnd = new Date(targetDateStart);
    targetDateEnd.setDate(targetDateEnd.getDate() + 1);

    // Check Predecessor — Only Cisaillage imposes constraints
    const cisaillageOp = cmd.operations.find(op => op.type === 'Cisaillage');
    if (cisaillageOp && cisaillageOp.slots && cisaillageOp.slots.length > 0) {
        if (operation.type === 'Poin\u00e7onnage' || operation.type === 'Pliage') {
            const lastSlot = [...cisaillageOp.slots].sort((a, b) => a.dateFin.localeCompare(b.dateFin)).pop();
            const cisaillageEndDate = new Date(lastSlot.dateFin);

            if (cisaillageEndDate.getTime() > targetDateEnd.getTime() - 60000) {
                restoreAndAlert(`\u26d4 IMPOSSIBLE : Cisaillage termine apr\u00e8s ce jour.`);
                return;
            }
            if (cisaillageEndDate.getTime() > targetDateStart.getTime()) {
                chronologyMinDecimal = cisaillageEndDate.getHours() + cisaillageEndDate.getMinutes() / 60;
            }
        }
    }

    // Check Successor — Only if moving Cisaillage
    let successorMaxDecimal = 24;
    if (operation.type === 'Cisaillage') {
        for (const opType of ['Poin\u00e7onnage', 'Pliage']) {
            const nextOp = cmd.operations.find(op => op.type === opType);
            if (nextOp && nextOp.slots && nextOp.slots.length > 0) {
                const firstSlot = [...nextOp.slots].sort((a, b) => a.dateDebut.localeCompare(b.dateDebut))[0];
                const nextStartDate = new Date(firstSlot.dateDebut);
                if (nextStartDate.getTime() < targetDateStart.getTime()) {
                    restoreAndAlert(`\u26d4 IMPOSSIBLE : ${opType} commence avant ce jour.`);
                    return;
                }
                if (nextStartDate.getTime() < targetDateEnd.getTime()) {
                    const nextStartDecimal = nextStartDate.getHours() + nextStartDate.getMinutes() / 60;
                    successorMaxDecimal = Math.min(successorMaxDecimal, nextStartDecimal);
                }
            }
        }
    }

    const effectiveSearchStart = Math.max(dropDecimal, chronologyMinDecimal);
    const effectiveSearchTimeStr = formatDecimalTime(effectiveSearchStart);

    // ATOMIC MOVE: Clear and re-place
    const slotsBackup = [...operation.slots];
    operation.slots = [];

    // Find contiguous gap for the whole operation
    const gapStart = findFirstAvailableGap(targetMachine, searchDay, searchWeek, operation.dureeTotal, effectiveSearchTimeStr, true, searchYear);

    if (gapStart) {
        const startParts = gapStart.split(':');
        const startDec = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;
        const endDec = calculateEndTimeWithBreaks(startDec, operation.dureeTotal, searchDay);

        // ===== OVERTIME VALIDATION =====
        const overtimeCheck = detectOvertimeOverflow(startDec, operation.dureeTotal, searchDay);

        if (overtimeCheck.overflows) {
            if (overtimeCheck.exceedsDay) {
                operation.slots = slotsBackup;
                restoreAndAlert(`\u26d4 IMPOSSIBLE : L'op\u00e9ration d\u00e9passe la journ\u00e9e enti\u00e8re (m\u00eame avec heures sup). Utilisez le placement automatique pour scindage multi-jours.`);
                return;
            }

            const machineOvertimeUsed = State.overtimeTracker.byMachine[targetMachine]?.hours || 0;
            const weeklyOvertimeUsed = State.overtimeTracker.totalHoursUsed || 0;

            const canUseOvertime = (
                machineOvertimeUsed + overtimeCheck.overtimeNeeded <= 2 &&
                weeklyOvertimeUsed + overtimeCheck.overtimeNeeded <= 10
            );

            if (!canUseOvertime) {
                operation.slots = slotsBackup;
                restoreAndAlert(`\u26d4 IMPOSSIBLE : Limites heures suppl\u00e9mentaires atteintes (max 2h/jour, 10h/semaine).`);
                return;
            }


            const confirmResult = await showOvertimeConfirmDialog({
                type: operation.type,
                machine: targetMachine,
                day: searchDay,
                normalDuration: operation.dureeTotal - overtimeCheck.overtimeNeeded,
                overtimeDuration: overtimeCheck.overtimeNeeded,
                totalDuration: operation.dureeTotal
            });

            if (confirmResult === 'refuse') {

                const fragments = splitAtNormalHoursEnd(
                    operation, targetMachine, searchWeek, searchYear, searchDay, startDec
                ) || [];

                if (fragments.length === 0) {
                    operation.slots = slotsBackup;
                    restoreAndAlert('Impossible de scinder l\'op\u00e9ration.');
                    return;
                }

                operation.slots = fragments.map((frag, index) => ({
                    id: generateSlotId(operation.id, fragments.slice(0, index)),
                    machine: frag.machine,
                    duree: frag.duration,
                    semaine: frag.week,
                    annee: frag.year,
                    jour: frag.day,
                    heureDebut: formatDecimalTime(frag.startHour),
                    heureFin: formatDecimalTime(frag.endHour),
                    dateDebut: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.startHour), frag.year).toISOString(),
                    dateFin: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.endHour), frag.year).toISOString(),
                    overtime: isInOvertimeZone(frag.day, frag.startHour)
                }));

                operation.statut = 'Planifi\u00e9e';
                const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                cmd.statut = allPlaced ? 'Planifi\u00e9e' : 'En cours';


                replanifierOperationsSuivantes(cmd, operation);

                renderVueJournee();
                renderCommandesNonPlacees(State.currentSearchQuery || '');
                saveDataImmediate(cmd.id);
                Toast.info(`Op\u00e9ration scind\u00e9e en ${fragments.length} partie(s) (heures sup refus\u00e9es)`);
                return;
            }

            // Accepted → track overtime
            if (!State.overtimeTracker.byMachine[targetMachine]) {
                State.overtimeTracker.byMachine[targetMachine] = { hours: 0 };
            }
            State.overtimeTracker.byMachine[targetMachine].hours += overtimeCheck.overtimeNeeded;
            State.overtimeTracker.totalHoursUsed += overtimeCheck.overtimeNeeded;
        }
        // ===== END OVERTIME VALIDATION =====

        // Successor check on final end time
        if (endDec > successorMaxDecimal + 0.001) {
            operation.slots = slotsBackup;
            restoreAndAlert(`\u26d4 IMPOSSIBLE : L'op\u00e9ration se terminerait apr\u00e8s le d\u00e9but de l'op\u00e9ration suivante (${formatDecimalTime(successorMaxDecimal)}).`);
            return;
        }

        // Apply new slot
        operation.slots = [{
            id: generateSlotId(operation.id, []),
            machine: targetMachine,
            duree: operation.dureeTotal,
            semaine: searchWeek,
            jour: searchDay,
            heureDebut: gapStart,
            heureFin: formatDecimalTime(endDec),
            dateDebut: getDateFromWeekDay(searchWeek, searchDay, gapStart, searchYear).toISOString(),
            dateFin: getDateFromWeekDay(searchWeek, searchDay, formatDecimalTime(endDec), searchYear).toISOString(),
            overtime: isInOvertimeZone(searchDay, startDec)
        }];

        operation.statut = 'Planifi\u00e9e';
        const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
        cmd.statut = allPlaced ? 'Planifi\u00e9e' : 'En cours';

        replanifierOperationsSuivantes(cmd, operation);

        renderVueJournee();
        renderCommandesNonPlacees(State.currentSearchQuery || '');
        saveDataImmediate(cmd.id);

        const wasMultiFragment = slotsBackup.length > 1;
        if (wasMultiFragment) {
            Toast.success(`Op\u00e9ration fusionn\u00e9e en un seul bloc \u00e0 ${gapStart}`);
        } else {
            Toast.success(`Op\u00e9ration d\u00e9plac\u00e9e \u00e0 ${gapStart}`);
        }
    } else {
        // No contiguous gap — look for partial gap
        const partialGap = findNextGap(targetMachine, searchDay, searchWeek, effectiveSearchTimeStr, searchYear);

        if (partialGap) {
            const gapStartDec = timeToDecimalHours(partialGap.startTime);
            const normalEndHour = searchDay === 'Vendredi' ? 12 : 16.5;
            const overtimeEndHour = searchDay === 'Vendredi' ? 14 : 18;

            const availableInGap = Math.min(partialGap.duration, Math.max(0, normalEndHour - gapStartDec));
            const overtimeNeeded = Math.min(operation.dureeTotal - availableInGap, overtimeEndHour - normalEndHour);

            const machineOvertimeUsed = State.overtimeTracker.byMachine[targetMachine]?.hours || 0;
            const weeklyOvertimeUsed = State.overtimeTracker.totalHoursUsed || 0;
            const canUseOvertime = (
                machineOvertimeUsed + overtimeNeeded <= 2 &&
                weeklyOvertimeUsed + overtimeNeeded <= 10
            );

            const totalAvailableWithOvertime = availableInGap + (canUseOvertime ? overtimeNeeded : 0);

            if (canUseOvertime && overtimeNeeded > 0.25 && totalAvailableWithOvertime >= operation.dureeTotal - 0.01) {
                // Propose overtime dialog
    
                const confirmResult = await showOvertimeConfirmDialog({
                    type: operation.type,
                    machine: targetMachine,
                    day: searchDay,
                    normalDuration: availableInGap,
                    overtimeDuration: overtimeNeeded,
                    totalDuration: operation.dureeTotal
                });

                if (confirmResult === 'accept') {
                    if (!State.overtimeTracker.byMachine[targetMachine]) {
                        State.overtimeTracker.byMachine[targetMachine] = { hours: 0 };
                    }
                    State.overtimeTracker.byMachine[targetMachine].hours += overtimeNeeded;
                    State.overtimeTracker.totalHoursUsed += overtimeNeeded;

                    const endDec = calculateEndTimeWithBreaks(gapStartDec, operation.dureeTotal, searchDay);

                    operation.slots = [{
                        id: generateSlotId(operation.id, []),
                        machine: targetMachine,
                        duree: operation.dureeTotal,
                        semaine: searchWeek,
                        jour: searchDay,
                        heureDebut: partialGap.startTime,
                        heureFin: formatDecimalTime(endDec),
                        dateDebut: getDateFromWeekDay(searchWeek, searchDay, partialGap.startTime, searchYear).toISOString(),
                        dateFin: getDateFromWeekDay(searchWeek, searchDay, formatDecimalTime(endDec), searchYear).toISOString(),
                        overtime: true
                    }];

                    operation.statut = 'Planifi\u00e9e';
                    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                    cmd.statut = allPlaced ? 'Planifi\u00e9e' : 'En cours';

    
                    replanifierOperationsSuivantes(cmd, operation);

                    renderVueJournee();
                    renderCommandesNonPlacees(State.currentSearchQuery || '');
                    saveDataImmediate(cmd.id);
                    Toast.success(`Op\u00e9ration plac\u00e9e avec ${formatHours(overtimeNeeded)} d'heures suppl\u00e9mentaires`);
                } else {
                    // Refused → split
    
                    const fragments = splitAtNormalHoursEnd(
                        operation, targetMachine, searchWeek, searchYear, searchDay, gapStartDec
                    ) || [];

                    if (fragments.length === 0) {
                        operation.slots = slotsBackup;
                        restoreAndAlert('Impossible de scinder l\'op\u00e9ration.');
                        return;
                    }

                    operation.slots = fragments.map((frag, index) => ({
                        id: generateSlotId(operation.id, fragments.slice(0, index)),
                        machine: frag.machine,
                        duree: frag.duration,
                        semaine: frag.week,
                        annee: frag.year,
                        jour: frag.day,
                        heureDebut: formatDecimalTime(frag.startHour),
                        heureFin: formatDecimalTime(frag.endHour),
                        dateDebut: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.startHour), frag.year).toISOString(),
                        dateFin: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.endHour), frag.year).toISOString(),
                        overtime: isInOvertimeZone(frag.day, frag.startHour)
                    }));

                    operation.statut = 'Planifi\u00e9e';
                    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                    cmd.statut = allPlaced ? 'Planifi\u00e9e' : 'En cours';

    
                    replanifierOperationsSuivantes(cmd, operation);

                    renderVueJournee();
                    renderCommandesNonPlacees(State.currentSearchQuery || '');
                    saveDataImmediate(cmd.id);
                    Toast.info(`Op\u00e9ration scind\u00e9e en ${fragments.length} partie(s) (heures sup refus\u00e9es)`);
                }
            } else {
                // Split directly (no overtime possible/sufficient)

                const fragments = splitAtNormalHoursEnd(
                    operation, targetMachine, searchWeek, searchYear, searchDay, gapStartDec
                ) || [];

                if (fragments.length === 0) {
                    operation.slots = slotsBackup;
                    restoreAndAlert('Impossible de scinder l\'op\u00e9ration.');
                    return;
                }

                operation.slots = fragments.map((frag, index) => ({
                    id: generateSlotId(operation.id, fragments.slice(0, index)),
                    machine: frag.machine,
                    duree: frag.duration,
                    semaine: frag.week,
                    annee: frag.year,
                    jour: frag.day,
                    heureDebut: formatDecimalTime(frag.startHour),
                    heureFin: formatDecimalTime(frag.endHour),
                    dateDebut: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.startHour), frag.year).toISOString(),
                    dateFin: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.endHour), frag.year).toISOString(),
                    overtime: isInOvertimeZone(frag.day, frag.startHour)
                }));

                operation.statut = 'Planifi\u00e9e';
                const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                cmd.statut = allPlaced ? 'Planifi\u00e9e' : 'En cours';


                replanifierOperationsSuivantes(cmd, operation);

                renderVueJournee();
                renderCommandesNonPlacees(State.currentSearchQuery || '');
                saveDataImmediate(cmd.id);
                Toast.info(`Op\u00e9ration scind\u00e9e en ${fragments.length} partie(s)`);
            }
        } else {
            // No gap at all
            operation.slots = slotsBackup;
            restoreAndAlert(`Impossible de d\u00e9placer l'op\u00e9ration : aucun cr\u00e9neau disponible.`);
        }
    }
}

// ===================================
// Global exposure
// ===================================

window.desaffecterCommande = desaffecterCommande;
window.initDragAndDrop = initDragAndDrop;

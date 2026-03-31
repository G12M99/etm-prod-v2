/**
 * @module semi-auto
 * @description Planification semi-automatique via modale
 *              (vue semaine). Wizard 2 étapes : configuration + récap.
 * @requires state.js, utils.js, scheduling.js, auto-place.js, db.js, ui-list.js
 */

import { State, markCommandeDirty, historyManager } from './state.js';
import {
    timeToDecimalHours, formatHours, formatDate, generateSlotId,
    getDateFromWeekDay, getDateFromWeekDayTime, addHoursToTime,
    getWeekNumber, getISOWeekYear, DAYS_OF_WEEK, Toast
} from './utils.js';
import {
    calculerCapaciteMachine, getCapacityColorClass, findNextGap
} from './scheduling.js';
import { getMachinesForOp, getNextWorkDay } from './auto-place.js';
import { saveData } from './db.js';
import { refresh } from './ui-list.js';

// ===================================
// Local state
// ===================================

let planifierSemiAutoState = {
    commandeId: null,
    commande: null,
    targetWeek: null,
    targetYear: null,
    selectedMachines: {},
    selectedDay: null,
    selectedTime: null,
    calculatedSlots: [],
    timeSlots: []
};

// ===================================
// Open modal
// ===================================

function openPlanifierSemiAutoModal(commandeId, targetWeek, targetYear) {
    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        return;
    }

    planifierSemiAutoState = {
        commandeId: commandeId,
        commande: cmd,
        targetWeek: targetWeek,
        targetYear: targetYear,
        selectedMachines: {},
        selectedDay: null,
        selectedTime: null,
        calculatedSlots: [],
        timeSlots: generateTimeSlots()
    };

    initPlanifierModal(cmd, targetWeek, targetYear);

    document.getElementById('planifierStep1').classList.add('active');
    document.getElementById('planifierStep2').classList.remove('active');
    document.getElementById('modalPlanifierSemiAuto').classList.add('active');
}

// ===================================
// Init modal content
// ===================================

function initPlanifierModal(cmd, targetWeek, targetYear) {
    document.getElementById('planifierModalTitle').textContent = `Planifier ${cmd.id}`;

    document.getElementById('planifierClientInfo').innerHTML = `
        <strong>Client:</strong> ${cmd.client} |
        <strong>Livraison:</strong> ${formatDate(cmd.dateLivraison)}
    `;

    renderPlanifierOperations(cmd);

    const opsAPlacer = cmd.operations.filter(op => !op.slots || op.slots.length === 0);
    const hasPoinconnage = opsAPlacer.some(op => op.type === 'Poinçonnage');
    const hasPliage = opsAPlacer.some(op => op.type === 'Pliage');
    const parallelOption = document.getElementById('planifierParallelOption');
    const parallelCheckbox = document.getElementById('planifierParallelCheckbox');

    if (hasPoinconnage && hasPliage) {
        parallelOption.style.display = 'block';
        parallelCheckbox.checked = false;
    } else {
        parallelOption.style.display = 'none';
        parallelCheckbox.checked = false;
    }

    renderPlanifierDayOptions(targetWeek, targetYear);
    initPlanifierTimeSlider();
}

// ===================================
// Time slots generation
// ===================================

function generateTimeSlots() {
    const slots = [];
    for (let h = 7; h <= 18; h++) {
        for (let m = 0; m < 60; m += 30) {
            if (h === 18 && m > 0) break;
            const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
            slots.push(timeStr);
        }
    }
    return slots;
}

// ===================================
// Render operations with machine selector
// ===================================

function getMachinesForOperationType(opType) {
    const type = opType.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (type === 'cisaillage') {
        return State.machinesConfig.cisaillage.filter(m => m.active).map(m => m.name);
    } else if (type === 'poinconnage') {
        return State.machinesConfig.poinconnage.filter(m => m.active).map(m => m.name);
    } else if (type === 'pliage') {
        return State.machinesConfig.pliage.filter(m => m.active).map(m => m.name);
    }
    return [];
}

function renderMachineGaugeInline(machineName, week, year) {
    const capacity = calculerCapaciteMachine(machineName, week, year);
    const capacityClass = getCapacityColorClass(capacity.pourcentage);

    return `
        <div class="gauge-bar-inline">
            <div class="gauge-fill-inline ${capacityClass}" style="width: ${Math.min(100, capacity.pourcentage)}%"></div>
        </div>
        <span class="gauge-label-inline">${capacity.pourcentage}%</span>
    `;
}

function renderPlanifierOperations(cmd) {
    const container = document.getElementById('planifierOperationsList');
    const opsAPlacer = cmd.operations.filter(op => !op.slots || op.slots.length === 0);

    if (opsAPlacer.length === 0) {
        container.innerHTML = '<p class="no-ops-message">Toutes les opérations sont déjà placées.</p>';
        return;
    }

    let html = '';
    opsAPlacer.forEach((op, index) => {
        const opClass = op.type.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const machines = getMachinesForOperationType(op.type);
        const duration = (window.hasTimeOverride?.(op) ?? false) ? op.dureeOverride : op.dureeTotal;

        if (!planifierSemiAutoState.selectedMachines[index]) {
            planifierSemiAutoState.selectedMachines[index] = machines[0];
        }

        html += `
            <div class="planifier-operation-item ${opClass}" data-op-index="${index}">
                <div class="planifier-op-info">
                    <span class="planifier-op-type">${op.type}</span>
                    <span class="planifier-op-duration">${formatHours(duration)}</span>
                </div>
                <div class="planifier-op-machine-select">
                    <select id="planifierMachine_${index}" onchange="updatePlanifierMachineSelection(${index}, this.value)">
                        ${machines.map(m => `<option value="${m}">${m}</option>`).join('')}
                    </select>
                    <div class="gauge-inline" id="planifierGauge_${index}">
                        ${renderMachineGaugeInline(machines[0], planifierSemiAutoState.targetWeek, planifierSemiAutoState.targetYear)}
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function updatePlanifierMachineSelection(opIndex, machineName) {
    planifierSemiAutoState.selectedMachines[opIndex] = machineName;

    const gaugeContainer = document.getElementById(`planifierGauge_${opIndex}`);
    if (gaugeContainer) {
        gaugeContainer.innerHTML = renderMachineGaugeInline(
            machineName,
            planifierSemiAutoState.targetWeek,
            planifierSemiAutoState.targetYear
        );
    }
}

// ===================================
// Day options
// ===================================

function getWeekDates(week, year) {
    const dates = [];
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = new Date(simple);

    if (dow <= 4)
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    for (let i = 0; i < 5; i++) {
        const d = new Date(ISOweekStart);
        d.setDate(ISOweekStart.getDate() + i);
        dates.push(d);
    }
    return dates;
}

function renderPlanifierDayOptions(week, year) {
    const select = document.getElementById('planifierDaySelect');
    const weekDates = getWeekDates(week, year);

    let html = '';
    DAYS_OF_WEEK.forEach((day, index) => {
        const date = weekDates[index];
        const dateStr = date ? `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}` : '';
        html += `<option value="${index}">${day} ${dateStr}</option>`;
    });

    select.innerHTML = html;
    select.value = '0';
    planifierSemiAutoState.selectedDay = 0;

    select.addEventListener('change', (e) => {
        planifierSemiAutoState.selectedDay = parseInt(e.target.value);
        updateTimeSliderForDay();
    });
}

// ===================================
// Time slider
// ===================================

function initPlanifierTimeSlider() {
    const slider = document.getElementById('planifierTimeSlider');
    const display = document.getElementById('planifierTimeDisplay');

    updateTimeSliderForDay();

    slider.addEventListener('input', (e) => {
        const index = parseInt(e.target.value);
        const time = planifierSemiAutoState.timeSlots[index] || '07:30';
        display.textContent = time;
        planifierSemiAutoState.selectedTime = time;
    });

    slider.value = 1;
    display.textContent = planifierSemiAutoState.timeSlots[1] || '07:30';
    planifierSemiAutoState.selectedTime = planifierSemiAutoState.timeSlots[1] || '07:30';
}

function updateTimeSliderForDay() {
    const slider = document.getElementById('planifierTimeSlider');
    const dayIndex = planifierSemiAutoState.selectedDay;
    const dayName = DAYS_OF_WEEK[dayIndex];

    let slots = [];
    if (dayName === 'Vendredi') {
        for (let h = 7; h <= 14; h++) {
            for (let m = 0; m < 60; m += 30) {
                if (h === 14 && m > 0) break;
                slots.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
            }
        }
    } else {
        for (let h = 7; h <= 18; h++) {
            for (let m = 0; m < 60; m += 30) {
                if (h === 7 && m === 0) continue;
                if (h === 18 && m > 0) break;
                slots.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
            }
        }
    }

    planifierSemiAutoState.timeSlots = slots;
    slider.max = slots.length - 1;
    slider.value = 0;

    const display = document.getElementById('planifierTimeDisplay');
    display.textContent = slots[0];
    planifierSemiAutoState.selectedTime = slots[0];
}

// ===================================
// Helpers
// ===================================

function getEndOfDayHour(dayName) {
    if (dayName === 'Vendredi') return 12;
    return 16.5;
}

function getDayStartTime(dayName) {
    if (dayName === 'Vendredi') return '07:00';
    return '07:30';
}

// ===================================
// Calculate semi-auto placement
// ===================================

function calculerPlacementSemiAuto() {
    const state = planifierSemiAutoState;
    const cmd = state.commande;

    if (!cmd) {
        Toast.error('Erreur: commande non trouvée');
        return;
    }

    const opsAPlacer = cmd.operations.filter(op => !op.slots || op.slots.length === 0);

    if (opsAPlacer.length === 0) {
        Toast.warning('Aucune opération à placer');
        return;
    }

    const placeInParallel = document.getElementById('planifierParallelCheckbox')?.checked || false;

    const startDay = DAYS_OF_WEEK[state.selectedDay];
    const startTime = state.selectedTime;
    const startWeek = state.targetWeek;
    const startYear = state.targetYear;

    const calculatedSlots = [];
    let currentConstraint = {
        week: startWeek,
        year: startYear,
        dayIndex: state.selectedDay,
        timeStr: startTime
    };

    let constraintAfterCisaillage = null;

    // Check if Cisaillage already placed
    const cisaillageOp = cmd.operations.find(op => op.type === 'Cisaillage');
    if (cisaillageOp && cisaillageOp.slots && cisaillageOp.slots.length > 0) {
        const cisaillageLastSlot = [...cisaillageOp.slots].sort((a, b) => {
            if (a.semaine !== b.semaine) return a.semaine - b.semaine;
            const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
            if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
            return a.heureFin.localeCompare(b.heureFin);
        }).pop();

        const cisaillageEndConstraint = {
            week: cisaillageLastSlot.semaine,
            year: cisaillageLastSlot.annee || startYear,
            dayIndex: DAYS_OF_WEEK.indexOf(cisaillageLastSlot.jour),
            timeStr: cisaillageLastSlot.heureFin
        };

        const userDate = getDateFromWeekDay(startWeek, startDay, startTime, startYear);
        const cisaillageEndDate = getDateFromWeekDay(
            cisaillageEndConstraint.week,
            DAYS_OF_WEEK[cisaillageEndConstraint.dayIndex],
            cisaillageEndConstraint.timeStr,
            cisaillageEndConstraint.year
        );

        if (cisaillageEndDate > userDate) {
            currentConstraint = cisaillageEndConstraint;
            console.log(`⚠️ Cisaillage déjà placé: contrainte ajustée à S${currentConstraint.week} ${DAYS_OF_WEEK[currentConstraint.dayIndex]} ${currentConstraint.timeStr}`);
            Toast.info(`Contrainte ajustée: Cisaillage se termine à ${cisaillageEndConstraint.timeStr}`);
        }

        constraintAfterCisaillage = currentConstraint;
    }

    for (let i = 0; i < opsAPlacer.length; i++) {
        const op = opsAPlacer[i];
        const selectedMachine = state.selectedMachines[i];
        const duration = (window.hasTimeOverride?.(op) ?? false) ? op.dureeOverride : op.dureeTotal;

        let constraintToUse = currentConstraint;
        if (placeInParallel && (op.type === 'Poinçonnage' || op.type === 'Pliage')) {
            constraintToUse = constraintAfterCisaillage || currentConstraint;
            console.log(`🔀 Mode parallèle: ${op.type} démarre à S${constraintToUse.week} ${DAYS_OF_WEEK[constraintToUse.dayIndex]} ${constraintToUse.timeStr}`);
        }

        const slotsForOp = findSlotsForOperationSemiAuto(
            op,
            selectedMachine,
            duration,
            constraintToUse,
            cmd
        );

        if (!slotsForOp || slotsForOp.length === 0) {
            Toast.error(`Impossible de placer ${op.type}: aucun créneau disponible`);
            return;
        }

        calculatedSlots.push({
            operation: op,
            opIndex: cmd.operations.indexOf(op),
            machine: selectedMachine,
            slots: slotsForOp,
            duration: duration
        });

        if (op.type === 'Cisaillage' && placeInParallel) {
            const lastSlot = slotsForOp[slotsForOp.length - 1];
            constraintAfterCisaillage = {
                week: lastSlot.semaine,
                year: lastSlot.year || startYear,
                dayIndex: DAYS_OF_WEEK.indexOf(lastSlot.jour),
                timeStr: lastSlot.heureFin
            };

            if (timeToDecimalHours(lastSlot.heureFin) >= getEndOfDayHour(lastSlot.jour)) {
                const next = getNextWorkDay(lastSlot.jour, lastSlot.semaine, constraintAfterCisaillage.year);
                constraintAfterCisaillage = {
                    week: next.week,
                    year: next.year,
                    dayIndex: DAYS_OF_WEEK.indexOf(next.day),
                    timeStr: getDayStartTime(next.day)
                };
            }
            console.log(`📌 Contrainte après Cisaillage sauvegardée: S${constraintAfterCisaillage.week} ${DAYS_OF_WEEK[constraintAfterCisaillage.dayIndex]} ${constraintAfterCisaillage.timeStr}`);
        }

        if (!placeInParallel || op.type === 'Cisaillage') {
            const lastSlot = slotsForOp[slotsForOp.length - 1];
            currentConstraint = {
                week: lastSlot.semaine,
                year: lastSlot.year || startYear,
                dayIndex: DAYS_OF_WEEK.indexOf(lastSlot.jour),
                timeStr: lastSlot.heureFin
            };

            if (timeToDecimalHours(lastSlot.heureFin) >= getEndOfDayHour(lastSlot.jour)) {
                const next = getNextWorkDay(lastSlot.jour, lastSlot.semaine, currentConstraint.year);
                currentConstraint = {
                    week: next.week,
                    year: next.year,
                    dayIndex: DAYS_OF_WEEK.indexOf(next.day),
                    timeStr: getDayStartTime(next.day)
                };
            }
        }
    }

    state.calculatedSlots = calculatedSlots;
    showPlanifierRecap(calculatedSlots, cmd);
}

// ===================================
// Find slots for operation (multi-day capable)
// ===================================

function findSlotsForOperationSemiAuto(operation, machine, duration, constraint, cmd) {
    const slots = [];
    let remainingDuration = duration;
    let currentWeek = constraint.week;
    let currentYear = constraint.year;
    let currentDayIndex = constraint.dayIndex;
    let currentTimeStr = constraint.timeStr;

    const maxIterations = 20;
    let iterations = 0;

    while (remainingDuration > 0.01 && iterations < maxIterations) {
        iterations++;
        const dayName = DAYS_OF_WEEK[currentDayIndex];

        const gap = findNextGap(machine, dayName, currentWeek, currentTimeStr, currentYear);

        if (!gap) {
            const next = getNextWorkDay(dayName, currentWeek, currentYear);
            currentWeek = next.week;
            currentYear = next.year;
            currentDayIndex = DAYS_OF_WEEK.indexOf(next.day);
            currentTimeStr = getDayStartTime(next.day);
            continue;
        }

        const usableDuration = Math.min(gap.duration || 0, remainingDuration);

        if (usableDuration < 0.1 || isNaN(usableDuration)) {
            const endTime = addHoursToTime(gap.startTime, gap.duration || 0);
            currentTimeStr = endTime;
            continue;
        }

        const endTime = addHoursToTime(gap.startTime, usableDuration);
        const dateDebut = getDateFromWeekDayTime(currentWeek, dayName, gap.startTime, currentYear);
        const dateFin = getDateFromWeekDayTime(currentWeek, dayName, endTime, currentYear);

        slots.push({
            machine: machine,
            jour: dayName,
            semaine: currentWeek,
            year: currentYear,
            heureDebut: gap.startTime,
            heureFin: endTime,
            dateDebut: dateDebut.toISOString().split('.')[0],
            dateFin: dateFin.toISOString().split('.')[0],
            duree: usableDuration
        });

        remainingDuration -= usableDuration;

        if (remainingDuration > 0.01) {
            if (timeToDecimalHours(endTime) >= getEndOfDayHour(dayName)) {
                const next = getNextWorkDay(dayName, currentWeek, currentYear);
                currentWeek = next.week;
                currentYear = next.year;
                currentDayIndex = DAYS_OF_WEEK.indexOf(next.day);
                currentTimeStr = getDayStartTime(next.day);
            } else {
                currentTimeStr = endTime;
            }
        }
    }

    return slots.length > 0 ? slots : null;
}

// ===================================
// Recap (step 2)
// ===================================

function formatDayDate(jour, semaine, year) {
    const dates = getWeekDates(semaine, year || State.anneeSelectionnee);
    const dayIndex = DAYS_OF_WEEK.indexOf(jour);
    const date = dates[dayIndex];
    if (date) {
        return `${jour} ${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
    }
    return jour;
}

function formatDateFr(date) {
    return date.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function showPlanifierRecap(calculatedSlots, cmd) {
    const recapList = document.getElementById('planifierRecapList');
    const warningDiv = document.getElementById('planifierWarningLivraison');

    let lastEndDate = null;
    calculatedSlots.forEach(item => {
        item.slots.forEach(slot => {
            const endDate = new Date(slot.dateFin);
            if (!lastEndDate || endDate > lastEndDate) {
                lastEndDate = endDate;
            }
        });
    });

    const livraisonDate = new Date(cmd.dateLivraison);
    if (lastEndDate && lastEndDate > livraisonDate) {
        warningDiv.innerHTML = `⚠️ Attention: Le placement se termine le ${formatDateFr(lastEndDate)}, après la date de livraison (${formatDate(cmd.dateLivraison)})`;
        warningDiv.classList.add('visible');
    } else {
        warningDiv.classList.remove('visible');
    }

    let html = '';
    calculatedSlots.forEach(item => {
        const opClass = item.operation.type.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        html += `<div class="recap-item ${opClass}">`;
        html += `<div class="recap-item-header">${item.operation.type}: ${item.machine}</div>`;
        html += `<div class="recap-item-details">${formatHours(item.duration)}</div>`;

        item.slots.forEach(slot => {
            const dayDate = formatDayDate(slot.jour, slot.semaine, slot.year);
            html += `<div class="recap-item-slot">${dayDate} de ${slot.heureDebut} à ${slot.heureFin}</div>`;
        });

        html += '</div>';
    });

    recapList.innerHTML = html;

    document.getElementById('planifierStep1').classList.remove('active');
    document.getElementById('planifierStep2').classList.add('active');
}

// ===================================
// Confirm & apply
// ===================================

function confirmerPlacementSemiAuto() {
    const state = planifierSemiAutoState;

    if (!state.calculatedSlots || state.calculatedSlots.length === 0) {
        Toast.error('Aucun placement à confirmer');
        return;
    }

    const cmd = State.commandes.find(c => c.id === state.commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        return;
    }

    const cmdId = cmd.id;

    const slotsToApply = [...state.calculatedSlots];

    closePlanifierModal();

    slotsToApply.forEach(item => {
        const operation = cmd.operations[item.opIndex];
        if (operation) {
            if (!operation.slots) {
                operation.slots = [];
            }
            item.slots.forEach(slot => {
                const duree = typeof slot.duree === 'number' && !isNaN(slot.duree) ? slot.duree : 0;
                operation.slots.push({
                    id: generateSlotId(operation.id, operation.slots),
                    machine: slot.machine,
                    duree: duree,
                    jour: slot.jour,
                    semaine: slot.semaine,
                    heureDebut: slot.heureDebut,
                    heureFin: slot.heureFin,
                    dateDebut: slot.dateDebut,
                    dateFin: slot.dateFin
                });
            });
            operation.statut = "Planifiée";
        }
    });

    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
    if (allPlaced) {
        cmd.statut = "Planifiée";
    } else {
        cmd.statut = "En cours";
    }

    historyManager.saveState(`Planifier semi-auto ${cmdId}`);

    markCommandeDirty(cmdId);
    saveData(cmdId);
    refresh();
    Toast.success(`${cmdId} planifié avec succès`);
}

// ===================================
// Navigation
// ===================================

function backToPlanifierStep1() {
    document.getElementById('planifierStep2').classList.remove('active');
    document.getElementById('planifierStep1').classList.add('active');
}

function closePlanifierModal() {
    document.getElementById('modalPlanifierSemiAuto').classList.remove('active');

    planifierSemiAutoState = {
        commandeId: null,
        commande: null,
        targetWeek: null,
        targetYear: null,
        selectedMachines: {},
        selectedDay: null,
        selectedTime: null,
        calculatedSlots: [],
        timeSlots: []
    };
}

// ===================================
// Event handlers init
// ===================================

export function initPlanifierSemiAutoHandlers() {
    document.getElementById('btnClosePlanifier')?.addEventListener('click', closePlanifierModal);
    document.getElementById('btnClosePlanifierStep2')?.addEventListener('click', closePlanifierModal);
    document.getElementById('btnCancelPlanifier')?.addEventListener('click', closePlanifierModal);

    document.getElementById('btnCalculerPlacement')?.addEventListener('click', calculerPlacementSemiAuto);

    document.getElementById('btnBackToStep1')?.addEventListener('click', backToPlanifierStep1);
    document.getElementById('btnConfirmerPlacement')?.addEventListener('click', confirmerPlacementSemiAuto);

    document.getElementById('modalPlanifierSemiAuto')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalPlanifierSemiAuto') {
            closePlanifierModal();
        }
    });
}

// ===================================
// Window exports for onclick in HTML
// ===================================
window.openPlanifierSemiAutoModal = openPlanifierSemiAutoModal;
window.updatePlanifierMachineSelection = updatePlanifierMachineSelection;
window.closePlanifierModal = closePlanifierModal;

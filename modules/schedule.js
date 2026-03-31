/**
 * @module schedule
 * @description Gestion dynamique des horaires : équipes, pauses,
 *              heures supplémentaires. CRUD via modales.
 * @requires state.js, utils.js, scheduling.js, db.js, ui-list.js
 */

import { State, markAllCommandesDirty } from './state.js';
import { timeToDecimalHours, timeStringToDecimal, DAYS_OF_WEEK, Toast } from './utils.js';
import { getAvailableRangesForDay, getActiveBreaksForDay } from './scheduling.js';
import { saveSchedule } from './db.js';
import { refresh } from './ui-list.js';

// ===================================
// Save config
// ===================================

function saveScheduleConfig() {
    saveSchedule(State.scheduleConfig);
}

// ===================================
// Reload arrays from scheduleConfig
// ===================================

/**
 * Calcule le total d'heures disponibles par jour (toutes equipes confondues)
 */
function calculateHoursPerDay() {
    const result = {};

    DAYS_OF_WEEK.forEach(day => {
        const ranges = getAvailableRangesForDay(day);
        let totalHours = 0;

        ranges.forEach(range => {
            let hours = range.end - range.start;

            getActiveBreaksForDay(day).forEach(b => {
                const breakStart = timeStringToDecimal(b.start);
                const breakEnd = timeStringToDecimal(b.end);

                if (breakStart < range.end && breakEnd > range.start) {
                    const overlapStart = Math.max(breakStart, range.start);
                    const overlapEnd = Math.min(breakEnd, range.end);
                    hours -= (overlapEnd - overlapStart);
                }
            });

            totalHours += Math.max(0, hours);
        });

        if (totalHours > 0) result[day] = totalHours;
    });

    return result;
}

/**
 * Retourne la pause dejeuner principale active (pour compatibilite)
 */
function getActiveLunchBreak() {
    const dejeuner = State.scheduleConfig.breaks.find(b => b.active && b.id === 'dejeuner');
    if (dejeuner) {
        return {
            start: dejeuner.start,
            end: dejeuner.end,
            duration: timeStringToDecimal(dejeuner.end) - timeStringToDecimal(dejeuner.start)
        };
    }
    return { start: '12:30', end: '13:00', duration: 0.5 };
}

/**
 * Construit la config horaire dynamique pour un jour
 */
function buildScheduleConfigForDay(day) {
    const ranges = getAvailableRangesForDay(day);
    if (ranges.length === 0) return null;

    const breaks = getActiveBreaksForDay(day);
    const overtime = State.scheduleConfig.overtime;
    const overtimeSlot = overtime && overtime.enabled ? overtime.slots.find(s => s.days.includes(day)) : null;

    const dayStart = Math.min(...ranges.map(r => r.start));
    const dayEnd = Math.max(...ranges.map(r => r.end));
    const overtimeEnd = overtimeSlot ? timeStringToDecimal(overtimeSlot.end) : dayEnd;

    const lunchBreak = breaks.find(b => b.id === 'dejeuner');

    return {
        start: dayStart,
        standardEnd: dayEnd,
        overtimeEnd: Math.max(dayEnd, overtimeEnd),
        lunchStart: lunchBreak ? timeStringToDecimal(lunchBreak.start) : null,
        lunchEnd: lunchBreak ? timeStringToDecimal(lunchBreak.end) : null,
        breaks: breaks.map(b => ({
            start: timeStringToDecimal(b.start),
            end: timeStringToDecimal(b.end),
            name: b.name
        })),
        ranges: ranges
    };
}

/**
 * Reconstruit SCHEDULE_CONFIG a partir de scheduleConfig dynamique
 */
function buildScheduleConfig() {
    const mondayConfig = buildScheduleConfigForDay('Lundi');
    const fridayConfig = buildScheduleConfigForDay('Vendredi');

    return {
        MONDAY_TO_THURSDAY: mondayConfig || {
            start: 7.5,
            standardEnd: 16.5,
            overtimeEnd: 18.0,
            lunchStart: 12.5,
            lunchEnd: 13.0
        },
        FRIDAY: fridayConfig || {
            start: 7.0,
            standardEnd: 12.0,
            overtimeEnd: 14.0,
            lunchStart: null,
            lunchEnd: null
        },
        CR_THRESHOLD: 1.05,
        CR_FORCE_THRESHOLD: 0.95,
        MAX_DISPLACEMENTS_NORMAL: 5,
        MAX_DISPLACEMENTS_FORCE: 20,
        SEARCH_HORIZON_DAYS: 14
    };
}

/**
 * Recharge les tableaux d'horaires depuis scheduleConfig.
 * Met à jour State.HOURS_PER_DAY, State.LUNCH_BREAK, State.TOTAL_HOURS_PER_WEEK.
 */
export function reloadScheduleArrays() {
    State.HOURS_PER_DAY = calculateHoursPerDay();
    State.LUNCH_BREAK = getActiveLunchBreak();
    State.TOTAL_HOURS_PER_WEEK = Object.values(State.HOURS_PER_DAY).reduce((a, b) => a + b, 0);

    console.log('[ScheduleConfig] Arrays recharges:', {
        HOURS_PER_DAY: State.HOURS_PER_DAY,
        LUNCH_BREAK: State.LUNCH_BREAK,
        TOTAL_HOURS_PER_WEEK: State.TOTAL_HOURS_PER_WEEK
    });
}

// ===================================
// Check & unassign out-of-schedule operations
// ===================================

function checkAndUnassignOutOfScheduleOperations() {
    let unassignedCount = 0;

    State.commandes.forEach(cmd => {
        cmd.operations?.forEach(op => {
            if (!op.slots || op.slots.length === 0) return;

            op.slots = op.slots.filter(slot => {
                const dayConfig = buildScheduleConfigForDay(slot.jour);
                if (!dayConfig) {
                    unassignedCount++;
                    return false;
                }

                const slotStart = timeToDecimalHours(slot.heureDebut);
                const slotEnd = slotStart + slot.duree;

                const isValid = dayConfig.ranges.some(range =>
                    slotStart >= range.start && slotEnd <= range.end
                ) || (slotStart >= dayConfig.start && slotEnd <= dayConfig.overtimeEnd);

                if (!isValid) unassignedCount++;
                return isValid;
            });
        });

        if (cmd.statut === 'Planifiee') {
            const hasPlacedOps = cmd.operations?.some(op => op.slots && op.slots.length > 0);
            if (!hasPlacedOps) cmd.statut = 'En attente';
        }
    });

    if (unassignedCount > 0) {
        markAllCommandesDirty();
        Toast.warning(`${unassignedCount} operation(s) desaffectee(s) (hors nouveaux horaires)`);
    }

    return unassignedCount;
}

// ===================================
// Open / Close modals
// ===================================

function openScheduleManager() {
    document.getElementById('modalSchedule').style.display = 'flex';
    renderScheduleManager();
}

function closeScheduleManager() {
    document.getElementById('modalSchedule').style.display = 'none';
}

// ===================================
// Render
// ===================================

export function renderScheduleManager() {
    // Render shifts
    const shiftsList = document.getElementById('shiftsList');
    if (State.scheduleConfig.shifts && State.scheduleConfig.shifts.length > 0) {
        shiftsList.innerHTML = State.scheduleConfig.shifts.map(shift => {
            const daysHtml = shift.days.map(d => `<span class="shift-day">${d.substring(0, 3)}</span>`).join('');
            const statusClass = shift.active ? 'status-active' : 'status-inactive';
            const statusText = shift.active ? 'Active' : 'Inactive';

            const firstDay = shift.days[0];
            const schedule = shift.schedules && shift.schedules[firstDay];
            const timeInfo = schedule ? `${schedule.start} - ${schedule.end}` : '';

            return `
                <div class="shift-item" onclick="openShiftEdit('${shift.id}')">
                    <span class="shift-icon">👷</span>
                    <div class="shift-info">
                        <span class="shift-name">${shift.name}</span>
                        <span class="shift-details">${timeInfo}</span>
                        <div class="shift-days">${daysHtml}</div>
                    </div>
                    <span class="shift-status ${statusClass}">${statusText}</span>
                </div>
            `;
        }).join('');
    } else {
        shiftsList.innerHTML = '<div class="no-shifts">Aucune equipe configuree</div>';
    }

    // Render breaks
    const breaksList = document.getElementById('breaksList');
    if (State.scheduleConfig.breaks && State.scheduleConfig.breaks.length > 0) {
        breaksList.innerHTML = State.scheduleConfig.breaks.map(brk => {
            const daysHtml = brk.days.map(d => `<span class="shift-day">${d.substring(0, 3)}</span>`).join('');
            const statusClass = brk.active ? 'status-active' : 'status-inactive';
            const statusText = brk.active ? 'Active' : 'Inactive';

            return `
                <div class="break-item" onclick="openBreakEdit('${brk.id}')">
                    <span class="break-icon">☕</span>
                    <div class="break-info">
                        <span class="break-name">${brk.name}</span>
                        <span class="break-details">${brk.start} - ${brk.end}</span>
                        <div class="shift-days">${daysHtml}</div>
                    </div>
                    <span class="break-status ${statusClass}">${statusText}</span>
                </div>
            `;
        }).join('');
    } else {
        breaksList.innerHTML = '<div class="no-breaks">Aucune pause configuree</div>';
    }

    // Render overtime
    const toggleOvertime = document.getElementById('toggleOvertime');
    const overtimeConfig = document.getElementById('overtimeConfig');

    if (toggleOvertime) {
        toggleOvertime.checked = State.scheduleConfig.overtime && State.scheduleConfig.overtime.enabled;
    }

    if (overtimeConfig && State.scheduleConfig.overtime) {
        overtimeConfig.classList.toggle('disabled', !State.scheduleConfig.overtime.enabled);

        let slotsHtml = '';
        if (State.scheduleConfig.overtime.slots) {
            slotsHtml = State.scheduleConfig.overtime.slots.map(slot => `
                <div class="overtime-slot">
                    <span class="overtime-slot-days">${slot.days.join(', ')}</span>
                    <span class="overtime-slot-time">${slot.start} - ${slot.end}</span>
                </div>
            `).join('');
        }

        overtimeConfig.innerHTML = `
            ${slotsHtml}
            <div style="margin-top: 8px; font-size: 12px; color: var(--color-text-secondary);">
                Max: ${State.scheduleConfig.overtime.maxDailyHours}h/jour, ${State.scheduleConfig.overtime.maxWeeklyHours}h/semaine
            </div>
        `;
    }
}

// ===================================
// Shift edit modal
// ===================================

function openShiftEdit(shiftId = null) {
    const modal = document.getElementById('modalShiftEdit');
    const title = document.getElementById('shiftEditTitle');
    const deleteBtn = document.getElementById('btnDeleteShift');
    const form = document.getElementById('formShiftEdit');

    form.reset();

    if (shiftId) {
        const shift = State.scheduleConfig.shifts.find(s => s.id === shiftId);
        if (!shift) return;

        title.textContent = "Modifier l'equipe";
        deleteBtn.style.display = 'block';

        document.getElementById('shiftEditId').value = shift.id;
        document.getElementById('shiftEditName').value = shift.name;
        document.getElementById('shiftEditActive').value = shift.active ? 'true' : 'false';

        document.querySelectorAll('#shiftDaysCheckboxes input[name="shiftDay"]').forEach(cb => {
            cb.checked = shift.days.includes(cb.value);
        });

        updateShiftSchedulesDisplay(shift.schedules || {});
    } else {
        title.textContent = "Ajouter une equipe";
        deleteBtn.style.display = 'none';
        document.getElementById('shiftEditId').value = '';

        document.querySelectorAll('#shiftDaysCheckboxes input[name="shiftDay"]').forEach(cb => {
            cb.checked = true;
        });

        updateShiftSchedulesDisplay({});
    }

    modal.style.display = 'flex';
}

function updateShiftSchedulesDisplay(schedules) {
    const container = document.getElementById('shiftSchedulesContainer');
    const selectedDays = Array.from(document.querySelectorAll('#shiftDaysCheckboxes input[name="shiftDay"]:checked'))
        .map(cb => cb.value);

    if (selectedDays.length === 0) {
        container.innerHTML = '<div style="color: var(--color-text-secondary); padding: 12px;">Selectionnez au moins un jour</div>';
        return;
    }

    container.innerHTML = selectedDays.map(day => {
        const schedule = schedules[day] || { start: '07:30', end: '16:30' };
        if (day === 'Vendredi' && !schedules[day]) {
            schedule.start = '07:00';
            schedule.end = '12:00';
        }

        return `
            <div class="shift-schedule-row" data-day="${day}">
                <label>${day}</label>
                <input type="time" name="scheduleStart_${day}" value="${schedule.start}" required>
                <input type="time" name="scheduleEnd_${day}" value="${schedule.end}" required>
            </div>
        `;
    }).join('');
}

function closeShiftEdit() {
    document.getElementById('modalShiftEdit').style.display = 'none';
}

function saveShiftEdit() {
    const shiftId = document.getElementById('shiftEditId').value;
    const name = document.getElementById('shiftEditName').value.trim();
    const active = document.getElementById('shiftEditActive').value === 'true';

    if (!name) {
        Toast.error('Veuillez entrer un nom');
        return;
    }

    const days = Array.from(document.querySelectorAll('#shiftDaysCheckboxes input[name="shiftDay"]:checked'))
        .map(cb => cb.value);

    if (days.length === 0) {
        Toast.error('Selectionnez au moins un jour');
        return;
    }

    const schedules = {};
    days.forEach(day => {
        const startInput = document.querySelector(`input[name="scheduleStart_${day}"]`);
        const endInput = document.querySelector(`input[name="scheduleEnd_${day}"]`);
        if (startInput && endInput) {
            schedules[day] = {
                start: startInput.value,
                end: endInput.value
            };
        }
    });

    if (shiftId) {
        const index = State.scheduleConfig.shifts.findIndex(s => s.id === shiftId);
        if (index !== -1) {
            State.scheduleConfig.shifts[index] = {
                ...State.scheduleConfig.shifts[index],
                name,
                active,
                days,
                schedules
            };
            Toast.success('Equipe modifiee');
        }
    } else {
        const newId = `shift-${Date.now()}`;
        State.scheduleConfig.shifts.push({
            id: newId,
            name,
            active,
            days,
            schedules
        });
        Toast.success('Equipe ajoutee');
    }

    saveScheduleConfig();
    reloadScheduleArrays();
    checkAndUnassignOutOfScheduleOperations();
    closeShiftEdit();
    renderScheduleManager();
    refresh();
}

function deleteShift() {
    const shiftId = document.getElementById('shiftEditId').value;
    if (!shiftId) return;

    if (!confirm('Etes-vous sur de vouloir supprimer cette equipe ?')) return;

    const index = State.scheduleConfig.shifts.findIndex(s => s.id === shiftId);
    if (index !== -1) {
        State.scheduleConfig.shifts.splice(index, 1);

        saveScheduleConfig();
        reloadScheduleArrays();
        checkAndUnassignOutOfScheduleOperations();
        closeShiftEdit();
        renderScheduleManager();
        refresh();
        Toast.success('Equipe supprimee');
    }
}

// ===================================
// Break edit modal
// ===================================

function openBreakEdit(breakId = null) {
    const modal = document.getElementById('modalBreakEdit');
    const title = document.getElementById('breakEditTitle');
    const deleteBtn = document.getElementById('btnDeleteBreak');
    const form = document.getElementById('formBreakEdit');

    form.reset();

    if (breakId) {
        const brk = State.scheduleConfig.breaks.find(b => b.id === breakId);
        if (!brk) return;

        title.textContent = 'Modifier la pause';
        deleteBtn.style.display = 'block';

        document.getElementById('breakEditId').value = brk.id;
        document.getElementById('breakEditName').value = brk.name;
        document.getElementById('breakEditStart').value = brk.start;
        document.getElementById('breakEditEnd').value = brk.end;
        document.getElementById('breakEditActive').value = brk.active ? 'true' : 'false';

        document.querySelectorAll('#breakDaysCheckboxes input[name="breakDay"]').forEach(cb => {
            cb.checked = brk.days.includes(cb.value);
        });
    } else {
        title.textContent = 'Ajouter une pause';
        deleteBtn.style.display = 'none';
        document.getElementById('breakEditId').value = '';
        document.getElementById('breakEditStart').value = '10:00';
        document.getElementById('breakEditEnd').value = '10:15';

        document.querySelectorAll('#breakDaysCheckboxes input[name="breakDay"]').forEach(cb => {
            cb.checked = true;
        });
    }

    modal.style.display = 'flex';
}

function closeBreakEdit() {
    document.getElementById('modalBreakEdit').style.display = 'none';
}

function saveBreakEdit() {
    const breakId = document.getElementById('breakEditId').value;
    const name = document.getElementById('breakEditName').value.trim();
    const start = document.getElementById('breakEditStart').value;
    const end = document.getElementById('breakEditEnd').value;
    const active = document.getElementById('breakEditActive').value === 'true';

    if (!name) {
        Toast.error('Veuillez entrer un nom');
        return;
    }

    if (!start || !end) {
        Toast.error('Veuillez entrer les horaires');
        return;
    }

    const days = Array.from(document.querySelectorAll('#breakDaysCheckboxes input[name="breakDay"]:checked'))
        .map(cb => cb.value);

    if (days.length === 0) {
        Toast.error('Selectionnez au moins un jour');
        return;
    }

    if (breakId) {
        const index = State.scheduleConfig.breaks.findIndex(b => b.id === breakId);
        if (index !== -1) {
            State.scheduleConfig.breaks[index] = {
                ...State.scheduleConfig.breaks[index],
                name,
                start,
                end,
                days,
                active
            };
            Toast.success('Pause modifiee');
        }
    } else {
        const newId = `break-${Date.now()}`;
        State.scheduleConfig.breaks.push({
            id: newId,
            name,
            start,
            end,
            days,
            active
        });
        Toast.success('Pause ajoutee');
    }

    saveScheduleConfig();
    reloadScheduleArrays();
    closeBreakEdit();
    renderScheduleManager();
    refresh();
}

function deleteBreak() {
    const breakId = document.getElementById('breakEditId').value;
    if (!breakId) return;

    if (!confirm('Etes-vous sur de vouloir supprimer cette pause ?')) return;

    const index = State.scheduleConfig.breaks.findIndex(b => b.id === breakId);
    if (index !== -1) {
        State.scheduleConfig.breaks.splice(index, 1);

        saveScheduleConfig();
        reloadScheduleArrays();
        closeBreakEdit();
        renderScheduleManager();
        refresh();
        Toast.success('Pause supprimee');
    }
}

// ===================================
// Overtime toggle
// ===================================

function toggleOvertimeEnabled() {
    State.scheduleConfig.overtime.enabled = document.getElementById('toggleOvertime').checked;
    saveScheduleConfig();
    reloadScheduleArrays();
    renderScheduleManager();
    refresh();
}

// ===================================
// Reset / Export
// ===================================

function resetScheduleConfig() {
    if (!confirm('Etes-vous sur de vouloir reinitialiser les horaires ?\n\nCela restaurera les horaires par defaut.')) {
        return;
    }

    State.scheduleConfig = JSON.parse(JSON.stringify(window.SCHEDULE_DEFAULT_CONFIG || {}));
    reloadScheduleArrays();
    checkAndUnassignOutOfScheduleOperations();
    renderScheduleManager();
    refresh();
    Toast.success('Horaires reinitialises');
}

function exportScheduleConfig() {
    const dataStr = JSON.stringify(State.scheduleConfig, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'schedule_config.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    Toast.success('Configuration horaires exportee');
}

// ===================================
// Event handlers init
// ===================================

export function initScheduleManagerHandlers() {
    document.getElementById('btnManageSchedule')?.addEventListener('click', openScheduleManager);

    document.getElementById('btnCloseSchedule')?.addEventListener('click', closeScheduleManager);
    document.getElementById('btnCloseScheduleBottom')?.addEventListener('click', closeScheduleManager);

    document.getElementById('btnResetSchedule')?.addEventListener('click', resetScheduleConfig);
    document.getElementById('btnExportSchedule')?.addEventListener('click', exportScheduleConfig);

    document.getElementById('btnAddShift')?.addEventListener('click', () => openShiftEdit(null));
    document.getElementById('btnAddBreak')?.addEventListener('click', () => openBreakEdit(null));

    document.getElementById('toggleOvertime')?.addEventListener('change', toggleOvertimeEnabled);

    document.getElementById('btnCloseShiftEdit')?.addEventListener('click', closeShiftEdit);
    document.getElementById('btnCancelShiftEdit')?.addEventListener('click', closeShiftEdit);
    document.getElementById('btnDeleteShift')?.addEventListener('click', deleteShift);
    document.getElementById('formShiftEdit')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveShiftEdit();
    });

    document.getElementById('shiftDaysCheckboxes')?.addEventListener('change', () => {
        const shiftId = document.getElementById('shiftEditId').value;
        const shift = shiftId ? State.scheduleConfig.shifts.find(s => s.id === shiftId) : null;
        updateShiftSchedulesDisplay(shift?.schedules || {});
    });

    document.getElementById('btnCloseBreakEdit')?.addEventListener('click', closeBreakEdit);
    document.getElementById('btnCancelBreakEdit')?.addEventListener('click', closeBreakEdit);
    document.getElementById('btnDeleteBreak')?.addEventListener('click', deleteBreak);
    document.getElementById('formBreakEdit')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveBreakEdit();
    });

    document.getElementById('modalSchedule')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalSchedule') closeScheduleManager();
    });

    document.getElementById('modalShiftEdit')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalShiftEdit') closeShiftEdit();
    });

    document.getElementById('modalBreakEdit')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalBreakEdit') closeBreakEdit();
    });
}

// ===================================
// Window exports for onclick in HTML
// ===================================
window.openShiftEdit = openShiftEdit;
window.closeShiftEdit = closeShiftEdit;
window.openBreakEdit = openBreakEdit;
window.closeBreakEdit = closeBreakEdit;

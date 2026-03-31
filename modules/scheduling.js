/**
 * @module scheduling
 * @description Logique de planification : capacité, horaires, recherche de créneaux,
 *              ordre chronologique. Lit State en lecture seule. Aucun effet de bord DOM ou Supabase.
 * @requires state.js
 * @requires utils.js
 */

import { State } from './state.js';
import {
    timeToDecimalHours,
    timeStringToDecimal,
    formatDecimalTime,
    getWeekNumber,
    getISOWeekYear,
    getDateFromWeekDay,
    DAYS_OF_WEEK
} from './utils.js';
import {
    getExpandedSystemEvents as _getExpandedSystemEventsFromModule
} from './system-events.js';

// ===================================
// Config horaire interne (Smart Scenario)
// ===================================

/**
 * Builds the SCHEDULE_CONFIG from State.scheduleConfig dynamically.
 * Called internally — not exported.
 */
function _buildScheduleConfig() {
    const mondayConfig = _buildScheduleConfigForDay('Lundi');
    const fridayConfig = _buildScheduleConfigForDay('Vendredi');

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

function _buildScheduleConfigForDay(day) {
    const ranges = getAvailableRangesForDay(day);
    if (ranges.length === 0) return null;

    const breaks = getActiveBreaksForDay(day);
    const overtime = State.scheduleConfig.overtime;
    const overtimeSlot = overtime && overtime.enabled ? (overtime.slots || []).find(s => s.days && s.days.includes(day)) : null;

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

// ===================================
// System Events helpers — delegated to system-events.js
// (kept as re-export for backward compatibility with importers)
// ===================================

/**
 * Get all system events expanded into individual day entries.
 * Delegates to system-events.js to avoid duplication.
 * @returns {Array}
 */
export function getExpandedSystemEvents() {
    return _getExpandedSystemEventsFromModule();
}

// ===================================
// Filtrage commandes
// ===================================

/**
 * Filter active orders (excludes Terminée/Livrée, case-insensitive).
 * @returns {Array}
 */
export function getActiveOrders() {
    return State.commandes.filter(cmd => {
        const status = cmd.statut.toLowerCase().trim();
        return status !== 'terminée' && status !== 'livrée';
    });
}

/**
 * Get placed orders (with at least one slot).
 * @returns {Array}
 */
export function getPlacedOrders() {
    return getActiveOrders().filter(cmd => {
        const status = cmd.statut.toLowerCase().trim();

        if (status === 'en cours' || status === 'planifiée') {
            return true;
        }

        if (status === 'en prépa') {
            return cmd.operations.some(op => op.slots && op.slots.length > 0);
        }

        return false;
    });
}

/**
 * Get unplaced orders (with at least one operation without slots).
 * @returns {Array}
 */
export function getUnplacedOrders() {
    return State.commandes.filter(cmd => {
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;
        return cmd.operations.some(op => !op.slots || op.slots.length === 0);
    });
}

/**
 * Get orders not assigned to any week (workflow 2 steps).
 * @returns {Array}
 */
export function getCommandesNonAffectees() {
    return State.commandes.filter(cmd => {
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;
        return cmd.semaineAffectee === null || cmd.semaineAffectee === undefined;
    });
}

/**
 * Get unplaced operations for a specific assigned week.
 * @param {number} semaine
 * @param {number} annee
 * @returns {Array<{commande: object, operation: object}>}
 */
export function getOperationsAffecteesSemaine(semaine, annee) {
    const targetWeekStr = `${annee}-W${String(semaine).padStart(2, '0')}`;
    const result = [];

    State.commandes.forEach(cmd => {
        if (cmd.semaineAffectee !== targetWeekStr) return;
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return;

        cmd.operations.forEach(op => {
            if (!op.slots || op.slots.length === 0) {
                result.push({ commande: cmd, operation: op });
            }
        });
    });

    return result;
}

/**
 * Get orders assigned to a week with at least one unplaced operation.
 * @param {number} semaine
 * @param {number} annee
 * @returns {Array}
 */
export function getCommandesAffecteesNonPlacees(semaine, annee) {
    const targetWeekStr = `${annee}-W${String(semaine).padStart(2, '0')}`;

    return State.commandes.filter(cmd => {
        if (cmd.semaineAffectee !== targetWeekStr) return false;
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;
        if (!cmd.operations || cmd.operations.length === 0) return true;
        return cmd.operations.some(op => !op.slots || op.slots.length === 0);
    });
}

/**
 * Check if a command should be shown in list view.
 * @param {object} cmd
 * @returns {boolean}
 */
export function shouldShowCommandeInList(cmd) {
    if (!State.hideCompletedStatuses) return true;
    const status = cmd.statut.toLowerCase().trim();
    return status !== 'terminée' && status !== 'livrée';
}

// ===================================
// Capacité
// ===================================

/**
 * Calculate operation duration based on material weight.
 * @param {string} type - Operation type (Cisaillage, Poinçonnage, Pliage)
 * @param {number} poids - Weight in kg
 * @returns {number} Duration in decimal hours
 */
export function calculerDureeOperation(type, poids) {
    return Math.round((poids * State.DUREE_PAR_KG[type]) * 100) / 100;
}

/**
 * Calculate machine capacity for a week.
 * @param {string} machine
 * @param {number} semaine
 * @param {number} [annee]
 * @returns {{ heuresUtilisees: number, pourcentage: number }}
 */
export function calculerCapaciteMachine(machine, semaine, annee = null) {
    const targetYear = annee ?? State.anneeSelectionnee;
    const placedOrders = getPlacedOrders();

    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            if (slot.machine !== machine || slot.semaine !== semaine) return false;
            const slotYear = getISOWeekYear(slot.dateDebut);
            return slotYear === targetYear;
        });

    const heuresUtilisees = slots.reduce((sum, slot) => sum + slot.duree, 0);
    const pourcentage = Math.round((heuresUtilisees / State.TOTAL_HOURS_PER_WEEK) * 100);

    return { heuresUtilisees, pourcentage };
}

/**
 * Calculate machine capacity for a specific day.
 * @param {string} machine
 * @param {string} jour
 * @param {number} semaine
 * @param {number} [annee]
 * @returns {{ heuresUtilisees: number, capaciteJour: number, pourcentage: number, capacityClass: string, isOvertime: boolean }}
 */
export function calculerCapaciteJour(machine, jour, semaine, annee = null) {
    const targetYear = annee ?? State.anneeSelectionnee;
    const placedOrders = getPlacedOrders();
    const capaciteJour = State.HOURS_PER_DAY[jour];

    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            if (slot.machine !== machine || slot.jour !== jour || slot.semaine !== semaine) return false;
            const slotYear = getISOWeekYear(slot.dateDebut);
            return slotYear === targetYear;
        });

    const heuresUtilisees = slots.reduce((sum, slot) => sum + slot.duree, 0);
    const pourcentage = Math.round((heuresUtilisees / capaciteJour) * 100);

    let capacityClass = 'capacity-ok';
    if (heuresUtilisees > capaciteJour) {
        capacityClass = 'capacity-overtime';
    } else if (pourcentage >= 96) {
        capacityClass = 'capacity-danger';
    } else if (pourcentage >= 76) {
        capacityClass = 'capacity-warning';
    }

    return {
        heuresUtilisees,
        capaciteJour,
        pourcentage,
        capacityClass,
        isOvertime: heuresUtilisees > capaciteJour
    };
}

/**
 * Get capacity color class from a percentage.
 * @param {number} pourcentage
 * @returns {string}
 */
export function getCapacityColorClass(pourcentage) {
    if (pourcentage >= 96) return 'capacity-danger';
    if (pourcentage >= 76) return 'capacity-warning';
    return 'capacity-ok';
}

/**
 * Calculate global weekly capacity (all machines).
 * Includes placed and assigned-but-unplaced operations.
 * @param {number} semaine
 * @param {number} annee
 * @returns {{ heuresAffectees: number, heuresPlacees: number, heuresNonPlacees: number, capaciteTotale: number, pourcentage: number }}
 */
export function calculerCapaciteSemaineGlobale(semaine, annee) {
    const targetWeekStr = `${annee}-W${String(semaine).padStart(2, '0')}`;

    const capaciteTotale = State.TOTAL_HOURS_PER_WEEK * State.ALL_MACHINES.length;

    // 1. Placed hours
    const placedOrders = getPlacedOrders();
    const heuresPlacees = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots || [])
        .filter(slot => {
            if (slot.semaine !== semaine) return false;
            const slotYear = getISOWeekYear(slot.dateDebut);
            return slotYear === annee;
        })
        .reduce((sum, slot) => sum + slot.duree, 0);

    // 2. Assigned but unplaced hours
    const commandesAffectees = State.commandes.filter(cmd => {
        if (cmd.semaineAffectee !== targetWeekStr) return false;
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;
        return true;
    });

    const heuresNonPlacees = commandesAffectees
        .flatMap(cmd => cmd.operations)
        .filter(op => !op.slots || op.slots.length === 0)
        .reduce((sum, op) => sum + (op.dureeOverride || op.dureeTotal || 0), 0);

    const heuresAffectees = heuresPlacees + heuresNonPlacees;
    const pourcentage = Math.round((heuresAffectees / capaciteTotale) * 100);

    return {
        heuresAffectees,
        heuresPlacees,
        heuresNonPlacees,
        capaciteTotale,
        pourcentage
    };
}

// ===================================
// Horaires
// ===================================

/**
 * Get available time ranges for a day from active shifts.
 * @param {string} day - French day name
 * @returns {Array<{shiftId: string, shiftName: string, start: number, end: number}>}
 */
export function getAvailableRangesForDay(day) {
    const ranges = [];
    (State.scheduleConfig.shifts || [])
        .filter(s => s.active && s.schedules && s.schedules[day])
        .forEach(shift => {
            const schedule = shift.schedules[day];
            ranges.push({
                shiftId: shift.id,
                shiftName: shift.name,
                start: timeStringToDecimal(schedule.start),
                end: timeStringToDecimal(schedule.end)
            });
        });
    return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Get active breaks for a day.
 * @param {string} day
 * @returns {Array}
 */
export function getActiveBreaksForDay(day) {
    return (State.scheduleConfig.breaks || []).filter(b => b.active && b.days && b.days.includes(day));
}

/**
 * Get schedule config (start, standardEnd, overtimeEnd) for a day.
 * Uses the dynamically built SCHEDULE_CONFIG.
 * @param {string} dayName
 * @returns {object}
 */
export function getScheduleForDay(dayName) {
    const config = _buildScheduleConfig();
    if (dayName === 'Vendredi') {
        return config.FRIDAY;
    }
    return config.MONDAY_TO_THURSDAY;
}

/**
 * Get global schedule range for a day (all shifts combined + overtime).
 * @param {string} dayName
 * @returns {{ globalStart: number, globalEnd: number, shifts: Array, gaps: Array }}
 */
export function getGlobalScheduleRangeForDay(dayName) {
    const ranges = getAvailableRangesForDay(dayName);
    if (!ranges || ranges.length === 0) {
        const fallback = getScheduleForDay(dayName);
        return {
            globalStart: fallback.start,
            globalEnd: fallback.overtimeEnd,
            shifts: [{ shiftId: 'default', shiftName: 'Equipe Jour', start: fallback.start, end: fallback.overtimeEnd }],
            gaps: []
        };
    }

    ranges.sort((a, b) => a.start - b.start);

    const globalStart = Math.min(...ranges.map(r => r.start));
    let globalEnd = Math.max(...ranges.map(r => r.end));

    if (State.scheduleConfig.overtime && State.scheduleConfig.overtime.enabled && State.scheduleConfig.overtime.slots) {
        const overtimeSlot = State.scheduleConfig.overtime.slots.find(s => s.days && s.days.includes(dayName));
        if (overtimeSlot) {
            const overtimeEnd = timeStringToDecimal(overtimeSlot.end);
            if (overtimeEnd > globalEnd) {
                globalEnd = overtimeEnd;
            }
        }
    }

    const gaps = [];
    for (let i = 0; i < ranges.length - 1; i++) {
        const currentEnd = ranges[i].end;
        const nextStart = ranges[i + 1].start;
        if (nextStart > currentEnd) {
            gaps.push({ start: currentEnd, end: nextStart });
        }
    }

    return { globalStart, globalEnd, shifts: ranges, gaps };
}

/**
 * Get ALL blocked zones for a day (breaks + inter-shift gaps).
 * @param {string} day
 * @returns {Array<{start: number, end: number, type: string, name: string}>}
 */
export function getBlockedZonesForDay(day) {
    const blockedZones = [];

    const breaks = getActiveBreaksForDay(day);
    breaks.forEach(b => {
        blockedZones.push({
            start: timeStringToDecimal(b.start),
            end: timeStringToDecimal(b.end),
            type: 'break',
            name: b.name || 'Pause'
        });
    });

    const scheduleRange = getGlobalScheduleRangeForDay(day);
    if (scheduleRange.gaps) {
        scheduleRange.gaps.forEach(gap => {
            blockedZones.push({
                start: gap.start,
                end: gap.end,
                type: 'inter-shift-gap',
                name: 'Hors horaires'
            });
        });
    }

    return blockedZones.sort((a, b) => a.start - b.start);
}

/**
 * Check if a decimal time falls inside a blocked zone.
 * @param {string} day
 * @param {number} timeDecimal
 * @returns {object|null} The blocked zone or null
 */
export function isTimeInBlockedZone(day, timeDecimal) {
    const zones = getBlockedZonesForDay(day);
    for (const zone of zones) {
        if (timeDecimal >= zone.start && timeDecimal < zone.end) {
            return zone;
        }
    }
    return null;
}

/**
 * Check if a decimal time is in the overtime zone.
 * @param {string} day
 * @param {number} timeDecimal
 * @returns {boolean}
 */
export function isInOvertimeZone(day, timeDecimal) {
    const ranges = getAvailableRangesForDay(day);
    if (!ranges || ranges.length === 0) {
        const schedule = getScheduleForDay(day);
        return timeDecimal >= schedule.standardEnd;
    }

    const lastShiftEnd = Math.max(...ranges.map(r => r.end));
    return timeDecimal >= lastShiftEnd;
}

/**
 * Get overtime end time for a shift/day.
 * @param {string} day
 * @param {string} [shiftId]
 * @returns {number} Decimal time
 */
export function getOvertimeEndForShift(day, shiftId = null) {
    if (!State.scheduleConfig.overtime || !State.scheduleConfig.overtime.enabled) {
        return day === 'Vendredi' ? 14.0 : 18.0;
    }
    const slot = (State.scheduleConfig.overtime.slots || []).find(s => s.days && s.days.includes(day));
    return slot ? timeStringToDecimal(slot.end) : (day === 'Vendredi' ? 14.0 : 18.0);
}

/**
 * Calculate end time accounting for ALL blocked zones (breaks + inter-shift gaps).
 * @param {number} startDec - Start time in decimal
 * @param {number} duration - Duration in hours
 * @param {string} day - Day name
 * @returns {number} End time in decimal
 */
export function calculateEndTimeWithBreaks(startDec, duration, day) {
    const blockedZones = getBlockedZonesForDay(day);
    if (blockedZones.length === 0) return startDec + duration;

    let currentPos = startDec;
    let remaining = duration;

    for (const zone of blockedZones) {
        if (remaining <= 0.001) break;
        if (currentPos >= zone.end) continue;

        if (currentPos >= zone.start && currentPos < zone.end) {
            currentPos = zone.end;
            continue;
        }

        const availableBefore = zone.start - currentPos;
        if (remaining <= availableBefore) {
            return currentPos + remaining;
        }

        remaining -= availableBefore;
        currentPos = zone.end;
    }

    return currentPos + remaining;
}

/**
 * Detect if an operation overflows into overtime.
 * @param {number} startDec
 * @param {number} duration
 * @param {string} day
 * @returns {{ overflows: boolean, normalEnd: number, operationEnd: number, overtimeNeeded?: number, canFitWithOvertime?: boolean, exceedsDay?: boolean }}
 */
export function detectOvertimeOverflow(startDec, duration, day) {
    const schedule = getScheduleForDay(day);
    const normalEnd = schedule.standardEnd;
    const operationEnd = calculateEndTimeWithBreaks(startDec, duration, day);

    if (operationEnd <= normalEnd) {
        return { overflows: false, normalEnd, operationEnd };
    }

    const overtimeNeeded = operationEnd - normalEnd;
    const overtimeEnd = schedule.overtimeEnd;

    return {
        overflows: true,
        normalEnd,
        operationEnd,
        overtimeNeeded,
        canFitWithOvertime: operationEnd <= overtimeEnd,
        exceedsDay: operationEnd > overtimeEnd
    };
}

// ===================================
// Créneaux
// ===================================

/**
 * Get machines sorted by load (least loaded first).
 * @param {Array<string>} machinesList
 * @param {number} targetWeek
 * @param {number} [targetYear]
 * @returns {Array<string>} Sorted machine names
 */
export function getMachinesByLoadOrder(machinesList, targetWeek, targetYear = null) {
    const year = targetYear ?? State.anneeSelectionnee;

    const machineLoads = machinesList.map(machine => {
        let totalLoad = 0;

        // Calculate load for weeks 1 to targetWeek (fixed from original bug: was hardcoded at 50)
        for (let week = 1; week <= targetWeek; week++) {
            const weekCapacity = calculerCapaciteMachine(machine, week, year);
            totalLoad += weekCapacity.heuresUtilisees;
        }

        return {
            machine: machine,
            totalLoad: totalLoad,
            weekCapacity: calculerCapaciteMachine(machine, targetWeek, year)
        };
    });

    machineLoads.sort((a, b) => a.totalLoad - b.totalLoad);

    return machineLoads.map(m => m.machine);
}

/**
 * Find first available gap in a day for an operation.
 * Takes into account blocked zones, system events, and existing slots.
 * @param {string} machine
 * @param {string} jour
 * @param {number} semaine
 * @param {number} durationNeeded
 * @param {string} [minTimeStr]
 * @param {boolean} [allowOvertime=false]
 * @param {number} [year]
 * @returns {string|null} Start time "HH:MM" or null
 */
export function findFirstAvailableGap(machine, jour, semaine, durationNeeded, minTimeStr = null, allowOvertime = false, year = null) {
    const targetYear = year ?? State.anneeSelectionnee;
    const placedOrders = getPlacedOrders();

    // 1. Get occupied slots
    const machineSlots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            if (slot.machine !== machine || slot.jour !== jour || slot.semaine !== semaine) return false;
            const slotYear = getISOWeekYear(slot.dateDebut);
            return slotYear === targetYear;
        })
        .map(slot => ({
            start: timeToDecimalHours(slot.heureDebut),
            end: timeToDecimalHours(slot.heureFin)
        }));

    // Add system events
    getExpandedSystemEvents()
        .filter(e => {
            if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== jour || e.week !== semaine) return false;
            const eventYear = e.year || getISOWeekYear(e.dateStr);
            return eventYear === targetYear;
        })
        .forEach(e => {
            machineSlots.push({
                start: timeToDecimalHours(e.startTime),
                end: timeToDecimalHours(e.endTime)
            });
        });

    machineSlots.sort((a, b) => a.start - b.start);

    // 2. Day boundaries
    const dayStart = jour === 'Vendredi' ? 7 : 7.5;
    let dayEnd;
    if (jour === 'Vendredi') {
        dayEnd = allowOvertime ? 14 : 12;
    } else {
        dayEnd = allowOvertime ? 18 : 16.5;
    }

    // 3. Search start
    let currentSearch = dayStart;
    if (minTimeStr) {
        const parts = minTimeStr.split(':');
        currentSearch = Math.max(currentSearch, parseInt(parts[0]) + parseInt(parts[1]) / 60);
    }

    const blockedZones = getBlockedZonesForDay(jour);

    // 4. Iterate to find a slot
    while (currentSearch + durationNeeded <= dayEnd + 0.001) {

        // A. Handle blocked zones for start time
        for (const zone of blockedZones) {
            if (currentSearch >= zone.start && currentSearch < zone.end) {
                currentSearch = zone.end;
            }
            if (durationNeeded < 0.5 && currentSearch < zone.start &&
                currentSearch + durationNeeded > zone.start) {
                currentSearch = zone.end;
            }
        }

        // B. Calculate required end time
        const requiredEnd = calculateEndTimeWithBreaks(currentSearch, durationNeeded, jour);

        // C. Check day limit
        if (requiredEnd > dayEnd + 0.001) {
            return null;
        }

        // D. Check collision with existing slots
        const collisionSlot = machineSlots.find(slot =>
            currentSearch < slot.end - 0.001 && requiredEnd > slot.start + 0.001
        );

        if (collisionSlot) {
            currentSearch = Math.max(currentSearch, collisionSlot.end);
        } else {
            return formatDecimalTime(currentSearch);
        }
    }

    return null;
}

/**
 * Find next available gap and its maximum duration.
 * @param {string} machine
 * @param {string} jour
 * @param {number} semaine
 * @param {string} [minTimeStr]
 * @param {number} [year]
 * @returns {{ startTime: string, duration: number } | null}
 */
export function findNextGap(machine, jour, semaine, minTimeStr = null, year = null) {
    const targetYear = year ?? State.anneeSelectionnee;
    const placedOrders = getPlacedOrders();

    console.log(`   findNextGap: ${machine} ${jour} S${semaine}, ${placedOrders.length} commandes placées`);

    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            if (slot.machine !== machine) return false;
            if (slot.jour !== jour) return false;
            if (slot.semaine !== semaine) return false;
            const slotYear = new Date(slot.dateDebut).getFullYear();
            return slotYear === targetYear;
        })
        .sort((a, b) => a.heureDebut.localeCompare(b.heureDebut));

    if (slots.length > 0) {
        console.log(`      Créneaux occupés: ${slots.map(s => `${s.heureDebut}-${s.heureFin}`).join(', ')}`);
    }

    // Time boundaries
    const startHour = jour === 'Vendredi' ? 7 : 7.5;
    const endHour = jour === 'Vendredi' ? 12 : 16.5;
    const totalMinutes = (endHour - startHour) * 60;

    // Busy periods
    const busyPeriods = slots.map(slot => {
        const startParts = slot.heureDebut.split(':');
        const endParts = slot.heureFin.split(':');
        const slotStartHour = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;
        const slotEndHour = parseInt(endParts[0]) + parseInt(endParts[1]) / 60;
        return {
            start: (slotStartHour - startHour) * 60,
            end: (slotEndHour - startHour) * 60
        };
    });

    // Add system events
    getExpandedSystemEvents()
        .filter(e => {
            if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== jour || e.week !== semaine) return false;
            const eventYear = e.year || getISOWeekYear(e.dateStr);
            return eventYear === targetYear;
        })
        .forEach(e => {
            const eStart = timeToDecimalHours(e.startTime);
            const eEnd = timeToDecimalHours(e.endTime);
            busyPeriods.push({
                start: (eStart - startHour) * 60,
                end: (eEnd - startHour) * 60
            });
        });

    // Add lunch break for Mon-Thu
    if (jour !== 'Vendredi') {
        const lunchStartParts = State.LUNCH_BREAK.start.split(':');
        const lunchEndParts = State.LUNCH_BREAK.end.split(':');
        const lunchStartHour = parseInt(lunchStartParts[0]) + parseInt(lunchStartParts[1]) / 60;
        const lunchEndHour = parseInt(lunchEndParts[0]) + parseInt(lunchEndParts[1]) / 60;
        busyPeriods.push({
            start: (lunchStartHour - startHour) * 60,
            end: (lunchEndHour - startHour) * 60
        });
        busyPeriods.sort((a, b) => a.start - b.start);
    }

    let currentTime = 0;

    if (minTimeStr) {
        const minParts = minTimeStr.split(':');
        const minHourDecimal = parseInt(minParts[0]) + parseInt(minParts[1]) / 60;
        const startOffset = (minHourDecimal - startHour) * 60;
        currentTime = Math.max(0, startOffset);
    }

    for (const busy of busyPeriods) {
        const gapSize = busy.start - currentTime;
        if (gapSize >= 1) {
            const gapStartDecimal = startHour + currentTime / 60;
            const gapStartHour = Math.floor(gapStartDecimal);
            const gapStartMinute = Math.round((gapStartDecimal - gapStartHour) * 60);
            return {
                startTime: `${gapStartHour.toString().padStart(2, '0')}:${gapStartMinute.toString().padStart(2, '0')}`,
                duration: gapSize / 60
            };
        }
        currentTime = Math.max(currentTime, busy.end);
    }

    const remainingMinutes = totalMinutes - currentTime;
    if (remainingMinutes >= 1) {
        const gapStartDecimal = startHour + currentTime / 60;
        const gapStartHour = Math.floor(gapStartDecimal);
        const gapStartMinute = Math.round((gapStartDecimal - gapStartHour) * 60);
        return {
            startTime: `${gapStartHour.toString().padStart(2, '0')}:${gapStartMinute.toString().padStart(2, '0')}`,
            duration: remainingMinutes / 60
        };
    }

    return null;
}

/**
 * Find best machine slot across all machines/days/weeks (4-week horizon).
 * @param {object} operation
 * @param {object} cmd
 * @param {Array<string>} machinesList
 * @param {number} [durationNeeded]
 * @param {object} [globalMinStart] - { week, dayIndex, timeStr }
 * @returns {{ machine: string, week: number, year: number, day: string, startTime: string, usableDuration: number, loadScore: number, weekPriority: number } | null}
 */
export function findBestMachineSlot(operation, cmd, machinesList, durationNeeded = null, globalMinStart = null) {
    if (durationNeeded === null) durationNeeded = operation.dureeTotal;

    // Same Machine Priority: if operation already started, force same machine
    if (operation.slots && operation.slots.length > 0) {
        const assignedMachine = operation.slots[0].machine;
        if (machinesList.includes(assignedMachine)) {
            machinesList = [assignedMachine];
        }
    }

    const candidates = [];

    const currentWeekStart = getWeekNumber(new Date());
    const currentYearStart = new Date().getFullYear();

    console.log(`findBestMachineSlot: ${operation.type}, durée ${durationNeeded}h, semaine courante ${currentWeekStart}`);
    if (globalMinStart) {
        console.log(`   globalMinStart = S${globalMinStart.week} ${DAYS_OF_WEEK[globalMinStart.dayIndex]} ${globalMinStart.timeStr}`);
    }

    for (let i = 0; i < 4; i++) {
        let targetWeek = currentWeekStart + i;
        let targetYear = currentYearStart;

        if (targetWeek > 52) {
            targetWeek -= 52;
            targetYear++;
        }

        // Global date filter (week)
        if (globalMinStart) {
            let globalOffset = globalMinStart.week - currentWeekStart;
            if (globalOffset < 0) globalOffset += 52;
            if (i < globalOffset) {
                continue;
            }
        }

        console.log(`   Scanning Semaine ${targetWeek} (année ${targetYear})`);

        const sortedMachines = getMachinesByLoadOrder(machinesList, targetWeek, targetYear);

        for (let dayIdx = 0; dayIdx < DAYS_OF_WEEK.length; dayIdx++) {
            let globalOffset = 0;
            if (globalMinStart) {
                globalOffset = globalMinStart.week - currentWeekStart;
                if (globalOffset < 0) globalOffset += 52;
            }

            if (globalMinStart && i === globalOffset && dayIdx < globalMinStart.dayIndex) {
                continue;
            }

            const day = DAYS_OF_WEEK[dayIdx];
            const week = targetWeek;

            for (const machine of sortedMachines) {
                let minTimeStr = null;

                // Global time filter
                if (globalMinStart && i === globalOffset && dayIdx === globalMinStart.dayIndex) {
                    minTimeStr = globalMinStart.timeStr;
                }

                // Check previous operation (chronology)
                const opIndex = cmd.operations.indexOf(operation);
                if (opIndex > 0) {
                    const prevOp = cmd.operations[opIndex - 1];
                    if (prevOp.slots && prevOp.slots.length > 0) {
                        const lastSlot = prevOp.slots[prevOp.slots.length - 1];
                        if (lastSlot.semaine === week && lastSlot.jour === day) {
                            if (!minTimeStr || timeToDecimalHours(lastSlot.heureFin) > timeToDecimalHours(minTimeStr)) {
                                minTimeStr = lastSlot.heureFin;
                            }
                        }
                    }
                }

                // Search for valid gap
                let currentSearchTimeStr = minTimeStr;

                while (true) {
                    const gap = findNextGap(machine, day, week, currentSearchTimeStr, targetYear);

                    if (!gap) break;

                    // Calculate gap end time for next iteration
                    const startH = parseInt(gap.startTime.split(':')[0]);
                    const startM = parseInt(gap.startTime.split(':')[1]);
                    const startDec = startH + startM / 60;
                    const endDec = startDec + gap.duration;
                    const endH = Math.floor(endDec);
                    const endM = Math.round((endDec - endH) * 60);
                    const gapEndTimeStr = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;

                    // Validate chronological order
                    const validation = canPlaceOperation(cmd, operation, week, day, gap.startTime, targetYear);
                    if (!validation.valid) {
                        currentSearchTimeStr = gapEndTimeStr;
                        continue;
                    }

                    const usableDuration = Math.min(gap.duration, durationNeeded);

                    // Skip tiny gaps unless the operation itself is tiny
                    if (usableDuration < 0.25 && durationNeeded > 0.25) {
                        currentSearchTimeStr = gapEndTimeStr;
                        continue;
                    }

                    const machineCapacity = calculerCapaciteMachine(machine, week, targetYear);
                    const loadScore = machineCapacity.heuresUtilisees / State.TOTAL_HOURS_PER_WEEK;

                    candidates.push({
                        machine,
                        week,
                        year: targetYear,
                        day,
                        startTime: gap.startTime,
                        usableDuration,
                        loadScore,
                        weekPriority: i
                    });

                    break;
                }
            }
        }
    }

    if (candidates.length === 0) return null;

    console.log(`   ${candidates.length} candidat(s) trouvé(s)`);

    // Sort candidates
    candidates.sort((a, b) => {
        if (a.weekPriority !== b.weekPriority) return a.weekPriority - b.weekPriority;

        const dayIndexA = DAYS_OF_WEEK.indexOf(a.day);
        const dayIndexB = DAYS_OF_WEEK.indexOf(b.day);
        if (dayIndexA !== dayIndexB) return dayIndexA - dayIndexB;

        const timeA = timeToDecimalHours(a.startTime);
        const timeB = timeToDecimalHours(b.startTime);
        if (timeA !== timeB) return timeA - timeB;

        return a.loadScore - b.loadScore;
    });

    return candidates[0];
}

// ===================================
// Ordre chronologique
// ===================================

/**
 * Validate that operations are in correct order:
 * Cisaillage must come before Poinçonnage and Pliage.
 * Poinçonnage and Pliage can be in any order relative to each other.
 * @param {object} commande
 * @returns {{ valid: boolean, message: string }}
 */
export function validateOperationOrder(commande) {
    const operations = commande.operations;
    if (!operations || operations.length === 0) return { valid: true, message: '' };

    const cisaillageIndex = operations.findIndex(op => op.type === 'Cisaillage');

    if (cisaillageIndex !== -1) {
        for (let i = 0; i < cisaillageIndex; i++) {
            const op = operations[i];
            if (op.type === 'Poinçonnage' || op.type === 'Pliage') {
                return {
                    valid: false,
                    message: `ORDRE DE PRODUCTION INVALIDE\n\n"${op.type}" ne peut pas être avant "Cisaillage".\n\nCisaillage doit toujours être la première opération.`
                };
            }
        }
    }

    return { valid: true, message: '' };
}

/**
 * Check if an operation can be placed at a given date/time.
 * Enforces: Cisaillage must END before Poinçonnage/Pliage START.
 * Poinçonnage and Pliage can overlap.
 * @param {object} commande
 * @param {object} operation
 * @param {number} targetWeek
 * @param {string} targetDay
 * @param {string} [targetStartTime='09:00']
 * @param {number} [targetYear]
 * @returns {{ valid: boolean, message: string }}
 */
export function canPlaceOperation(commande, operation, targetWeek, targetDay, targetStartTime = '09:00', targetYear = null) {
    const year = targetYear ?? State.anneeSelectionnee;
    const operations = commande.operations;
    const currentType = operation.type;

    const targetStartDate = getDateFromWeekDay(targetWeek, targetDay, targetStartTime, year);
    const targetEndDate = new Date(targetStartDate);
    targetEndDate.setHours(targetEndDate.getHours() + operation.dureeTotal);

    // RULE 1: If Cisaillage is placed and we place Poinçonnage/Pliage, Cisaillage must be finished
    if (currentType === 'Poinçonnage' || currentType === 'Pliage') {
        const cisaillageOp = operations.find(op => op.type === 'Cisaillage');

        if (cisaillageOp && cisaillageOp.slots && cisaillageOp.slots.length > 0) {
            const cisaillageLastSlot = [...cisaillageOp.slots].sort((a, b) => {
                if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
                if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                return a.heureFin.localeCompare(b.heureFin);
            }).pop();

            const cisaillageEndDate = new Date(cisaillageLastSlot.dateFin || getDateFromWeekDay(cisaillageLastSlot.semaine, cisaillageLastSlot.jour, cisaillageLastSlot.heureFin, year));

            if (targetStartDate < cisaillageEndDate) {
                const timeDiff = Math.round((cisaillageEndDate - targetStartDate) / (1000 * 60));
                const endHourFloat = parseInt(cisaillageLastSlot.heureFin.split(':')[0]) + parseInt(cisaillageLastSlot.heureFin.split(':')[1]) / 60;
                const suggestedHour = Math.ceil(endHourFloat);
                const suggestedTime = `${suggestedHour.toString().padStart(2, '0')}:00`;

                return {
                    valid: false,
                    message: `ORDRE CHRONOLOGIQUE INVALIDE\n\n"${operation.type}" ne peut pas commencer AVANT la fin de "Cisaillage"\n\nCisaillage se termine:\n   S${cisaillageLastSlot.semaine} ${cisaillageLastSlot.jour} à ${cisaillageLastSlot.heureFin}\n\n${operation.type} commence:\n   S${targetWeek} ${targetDay} à ${targetStartTime}\n\nConflit: ${timeDiff} minutes de chevauchement\n\nSolution: Placez "${operation.type}" à partir de ${suggestedTime}`
                };
            }
        }
    }

    // RULE 2: If placing Cisaillage, it must end before Poinçonnage AND Pliage
    if (currentType === 'Cisaillage') {
        const poinconnageOp = operations.find(op => op.type === 'Poinçonnage');
        if (poinconnageOp && poinconnageOp.slots && poinconnageOp.slots.length > 0) {
            const poinconnageFirstSlot = [...poinconnageOp.slots].sort((a, b) => {
                if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
                if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                return a.heureDebut.localeCompare(b.heureDebut);
            })[0];

            const poinconnageStartDate = new Date(poinconnageFirstSlot.dateDebut || getDateFromWeekDay(poinconnageFirstSlot.semaine, poinconnageFirstSlot.jour, poinconnageFirstSlot.heureDebut, year));

            if (targetEndDate > poinconnageStartDate) {
                return {
                    valid: false,
                    message: `ORDRE CHRONOLOGIQUE INVALIDE\n\n"Cisaillage" doit SE TERMINER AVANT le début de "Poinçonnage"\n\nPoinçonnage commence:\n   S${poinconnageFirstSlot.semaine} ${poinconnageFirstSlot.jour} à ${poinconnageFirstSlot.heureDebut}\n\nSolution: Placez "Cisaillage" plus tôt`
                };
            }
        }

        const pliageOp = operations.find(op => op.type === 'Pliage');
        if (pliageOp && pliageOp.slots && pliageOp.slots.length > 0) {
            const pliageFirstSlot = [...pliageOp.slots].sort((a, b) => {
                if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
                if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                return a.heureDebut.localeCompare(b.heureDebut);
            })[0];

            const pliageStartDate = new Date(pliageFirstSlot.dateDebut || getDateFromWeekDay(pliageFirstSlot.semaine, pliageFirstSlot.jour, pliageFirstSlot.heureDebut, year));

            if (targetEndDate > pliageStartDate) {
                return {
                    valid: false,
                    message: `ORDRE CHRONOLOGIQUE INVALIDE\n\n"Cisaillage" doit SE TERMINER AVANT le début de "Pliage"\n\nPliage commence:\n   S${pliageFirstSlot.semaine} ${pliageFirstSlot.jour} à ${pliageFirstSlot.heureDebut}\n\nSolution: Placez "Cisaillage" plus tôt`
                };
            }
        }
    }

    // Poinçonnage and Pliage can overlap — no check between them
    return { valid: true, message: '' };
}

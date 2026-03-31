/**
 * @module auto-place
 * @description Algorithme de placement automatique des opérations,
 *              cascade reschedule, split intelligent, insertion urgente.
 * @requires state.js, utils.js, scheduling.js, db.js, ui-list.js
 */

import { State } from './state.js';
import {
    timeToDecimalHours, decimalToTimeString, generateSlotId,
    getDateFromWeekDay, getWeekNumber, getISOWeekYear, formatHours,
    DAYS_OF_WEEK, Toast
} from './utils.js';
import {
    getPlacedOrders, getScheduleForDay, getBlockedZonesForDay,
    calculateEndTimeWithBreaks, findBestMachineSlot,
    validateOperationOrder, getExpandedSystemEvents
} from './scheduling.js';
import { saveData } from './db.js';
import { refresh } from './ui-list.js';
import { showOvertimeConfirmDialog } from './urgent.js';

// ===================================
// Helpers
// ===================================

/**
 * Retourne les machines disponibles pour un type d'opération
 */
export function getMachinesForOp(type) {
    if (type === 'Cisaillage') return State.MACHINES.cisailles;
    if (type === 'Poinçonnage') return State.MACHINES.poinconneuses;
    if (type === 'Pliage') return State.MACHINES.plieuses;
    return [];
}

/**
 * Get next work day
 */
export function getNextWorkDay(currentDay, currentWeek, currentYear) {
    const dayIndex = DAYS_OF_WEEK.indexOf(currentDay);

    if (dayIndex < 4) {
        // Pas encore vendredi, jour suivant
        return {
            day: DAYS_OF_WEEK[dayIndex + 1],
            week: currentWeek,
            year: currentYear
        };
    }

    // C'était vendredi, passer à lundi de la semaine suivante
    let nextWeek = currentWeek + 1;
    let nextYear = currentYear;

    if (nextWeek > 52) {
        nextWeek = 1;
        nextYear++;
    }

    return {
        day: 'Lundi',
        week: nextWeek,
        year: nextYear
    };
}

/**
 * Retourne les opérations d'une commande dans l'ordre métier
 */
export function getOperationSequence(commande) {
    const orderMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
    return [...commande.operations].sort((a, b) => {
        return (orderMap[a.type] || 99) - (orderMap[b.type] || 99);
    });
}

/**
 * Retourne les opérations qui suivent une opération donnée dans la séquence
 */
export function getFollowingOperations(commande, currentOperation) {
    const sequence = getOperationSequence(commande);
    const currentIndex = sequence.findIndex(op => op.type === currentOperation.type);

    if (currentIndex === -1 || currentIndex === sequence.length - 1) {
        return []; // Pas d'opération suivante
    }

    return sequence.slice(currentIndex + 1);
}

/**
 * Compare deux slots et retourne le meilleur (le plus proche du point de départ)
 */
export function compareSlotsForSequencing(slotA, slotB, targetWeek, targetYear, targetDay, targetHour) {
    // Calculer la distance temporelle depuis le point cible
    const getTimeDistance = (slot) => {
        // Convertir week/year/day en nombre de jours depuis une référence
        const weekDiff = (slot.week - targetWeek) + (slot.year - targetYear) * 52;
        const dayMap = { 'Lundi': 0, 'Mardi': 1, 'Mercredi': 2, 'Jeudi': 3, 'Vendredi': 4 };
        const dayDiff = (dayMap[slot.day] || 0) - (dayMap[targetDay] || 0);
        const totalDayDiff = weekDiff * 5 + dayDiff;
        const hourDiff = slot.startHour - targetHour;

        return totalDayDiff * 24 + hourDiff; // Distance en heures
    };

    const distA = getTimeDistance(slotA);
    const distB = getTimeDistance(slotB);

    // Préférer le slot le plus proche
    if (distA < distB) return slotA;
    if (distB < distA) return slotB;

    // Si même distance, préférer le slot sans overtime
    if (!slotA.isOvertime && slotB.isOvertime) return slotA;
    if (!slotB.isOvertime && slotA.isOvertime) return slotB;

    return slotA; // Par défaut
}

/**
 * Check if event is multi-day format
 */
function isMultiDayEvent(event) {
    return event.version === 2 || event.dateStart !== undefined;
}

/**
 * Calculer les horaires effectifs pour un jour donné dans un événement multi-jours
 */
function getEffectiveHoursForDay(event, targetDateStr, dayName) {
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
            ? decimalToTimeString(schedule.overtimeEnd)
            : decimalToTimeString(schedule.standardEnd);
    } else if (isLastDay) {
        effectiveStart = decimalToTimeString(schedule.start);
        if (event.fullLastDay) {
            effectiveEnd = decimalToTimeString(schedule.overtimeEnd);
        } else {
            effectiveEnd = event.endTimeLastDay;
        }
    } else {
        effectiveStart = decimalToTimeString(schedule.start);
        effectiveEnd = (event.type === 'fermeture')
            ? decimalToTimeString(schedule.overtimeEnd)
            : decimalToTimeString(schedule.standardEnd);
    }

    return { effectiveStart, effectiveEnd };
}

/**
 * Helper: Get Date from week number, year and day name
 */
function getDateFromWeekAndDay(weekNum, year, dayName) {
    const simple = new Date(year, 0, 1 + (weekNum - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = new Date(simple);
    if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    const dayIndex = DAYS_OF_WEEK.indexOf(dayName);
    const targetDate = new Date(ISOweekStart);
    targetDate.setDate(ISOweekStart.getDate() + dayIndex);

    return targetDate;
}

function formatSlotResult(start, end) {
    const hStart = Math.floor(start);
    const mStart = Math.round((start - hStart) * 60);
    const hEnd = Math.floor(end);
    const mEnd = Math.round((end - hEnd) * 60);

    const timeRangeStr = `${hStart.toString().padStart(2,'0')}:${mStart.toString().padStart(2,'0')}-${hEnd.toString().padStart(2,'0')}:${mEnd.toString().padStart(2,'0')}`;

    return {
        range: timeRangeStr,
        endDecimal: end
    };
}

function formatTimeRange(start, end) {
    const h1 = Math.floor(start);
    const m1 = Math.round((start - h1) * 60);
    const h2 = Math.floor(end);
    const m2 = Math.round((end - h2) * 60);
    return `${h1.toString().padStart(2,'0')}:${m1.toString().padStart(2,'0')}-${h2.toString().padStart(2,'0')}:${m2.toString().padStart(2,'0')}`;
}

// ===================================
// System Block Detection
// ===================================

/**
 * Check if there is a system block (maintenance/fermeture)
 * Supporte les deux formats : v1 (ancien) et v2 (multi-jours)
 */
export function hasSystemBlock(machine, dayName, weekNum, yearNum, startHour, endHour) {
    // Calculer la date cible pour comparaison avec les événements v2
    const targetDate = getDateFromWeekDay(weekNum, dayName, "00:00", yearNum);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    const hasEvent = State.systemEvents.some(e => {
        // Machine check commun
        if (e.machine !== machine && e.machine !== 'ALL') return false;

        // === FORMAT V2 (multi-jours) ===
        if (isMultiDayEvent(e)) {
            // Vérifier si targetDate est dans la plage [dateStart, dateEnd]
            if (targetDateStr < e.dateStart || targetDateStr > e.dateEnd) return false;

            // Calculer les horaires effectifs pour CE jour
            const { effectiveStart, effectiveEnd } = getEffectiveHoursForDay(e, targetDateStr, dayName);

            const eventStart = timeToDecimalHours(effectiveStart);
            const eventEnd = timeToDecimalHours(effectiveEnd);

            return (startHour < eventEnd && endHour > eventStart);
        }

        // === FORMAT V1 (ancien) ===
        if (e.day !== dayName || e.week !== weekNum) return false;
        if (e.year && e.year !== yearNum) return false;

        const eventStart = timeToDecimalHours(e.startTime);
        const eventEnd = timeToDecimalHours(e.endTime);

        return (startHour < eventEnd && endHour > eventStart);
    });

    if (hasEvent) return true;

    // La pause déjeuner n'est plus vérifiée ici : le split intelligent s'en occupe
    return false;
}

// ===================================
// Conflict Detection
// ===================================

/**
 * Find conflicts at a specific time slot
 */
export function findConflicts(machine, dayName, weekNum, yearNum, startHour, endHour) {
    const conflicts = [];
    const placedOrders = getPlacedOrders();

    placedOrders.forEach(cmd => {
        cmd.operations.forEach(op => {
            if (!op.slots) return;
            op.slots.forEach(slot => {
                if (slot.machine !== machine || slot.jour !== dayName) return;
                if (slot.semaine !== weekNum) return;
                if (slot.annee && slot.annee !== yearNum) return;

                const slotStart = timeToDecimalHours(slot.heureDebut);
                const slotEnd = timeToDecimalHours(slot.heureFin);

                if (startHour < slotEnd && endHour > slotStart) {
                    conflicts.push({
                        commandeId: cmd.id,
                        commande: cmd,
                        operation: op,
                        slot: slot,
                        slotStart,
                        slotEnd
                    });
                }
            });
        });
    });

    return conflicts;
}

// ===================================
// Urgent Slot Finding
// ===================================

/**
 * Trouve un créneau urgent sur la journée étendue (Matin -> Fin Heures Sup)
 */
export function findUrgentSlot(machine, day, duration, minStartHour = 0, targetWeek = State.semaineSelectionnee, targetYear = State.anneeSelectionnee) {
    // 1. Définir les bornes de la journée étendue
    const dayStart = day === 'Vendredi' ? 7.0 : 7.5;

    // Fin absolue (Standard + Max Heures Sup)
    const dayEnd = day === 'Vendredi' ? 14.0 : 18.0;

    // Le début effectif ne peut pas être avant l'ouverture
    let searchStart = Math.max(dayStart, minStartHour);

    // Si la durée dépasse le temps restant total possible
    if (searchStart + duration > dayEnd) return null;

    // 2. Récupérer tous les créneaux OCCUPÉS
    const placedOrders = getPlacedOrders();
    const busySlots = placedOrders
        .flatMap(c => c.operations)
        .flatMap(o => o.slots)
        .filter(s => {
            if (s.machine !== machine || s.jour !== day || s.semaine !== targetWeek) return false;
            if (s.annee && s.annee !== targetYear) return false;
            return true;
        })
        .map(s => ({
            start: timeToDecimalHours(s.heureDebut),
            end: timeToDecimalHours(s.heureFin)
        }));

    // Ajouter les blocages système (Maintenance / Fermeture)
    State.systemEvents
        .filter(e => (e.machine === machine || e.machine === 'ALL') && e.day === day && e.week === targetWeek && (!e.year || e.year === targetYear))
        .forEach(e => {
            busySlots.push({
                start: timeToDecimalHours(e.startTime),
                end: timeToDecimalHours(e.endTime)
            });
        });

    // Ajouter toutes les zones bloquees (pauses + gaps inter-equipes)
    const blockedZones = getBlockedZonesForDay(day);
    blockedZones.forEach(zone => {
        busySlots.push({ start: zone.start, end: zone.end, type: zone.type });
    });

    // Trier les créneaux occupés
    busySlots.sort((a, b) => a.start - b.start);

    // 3. Chercher un trou (Gap)
    let currentPointer = searchStart;

    for (const busy of busySlots) {
        if (currentPointer < busy.start) {
            const gapSize = busy.start - currentPointer;
            if (gapSize >= duration - 0.001) {
                return formatSlotResult(currentPointer, currentPointer + duration);
            }
        }
        currentPointer = Math.max(currentPointer, busy.end);
    }

    // 4. Vérifier le dernier trou
    if (currentPointer + duration <= dayEnd + 0.001) {
        return formatSlotResult(currentPointer, currentPointer + duration);
    }

    return null;
}

/**
 * Find standard gap (no overtime)
 */
export function findStandardGap(machine, day, week, year, duration, minStart) {
    const dayStart = 7.5;
    const dayEnd = day === 'Vendredi' ? 12.0 : 16.5;
    if (minStart >= dayEnd) return null;

    const startSearch = Math.max(dayStart, minStart);

    const slot = findUrgentSlot(machine, day, duration, startSearch, week, year);

    if (slot && slot.endDecimal <= dayEnd) {
        return { start: slot.endDecimal - duration, end: slot.endDecimal };
    }
    return null;
}

/**
 * Find all gaps in standard hours
 */
export function findAllGaps(machine, day, week, year, minStart) {
    const gaps = [];
    const dayEnd = day === 'Vendredi' ? 12.0 : 16.5;
    let current = Math.max(7.5, minStart);

    while (current < dayEnd) {
        const slot = findUrgentSlot(machine, day, 0.5, current, week, year);
        if (slot && slot.endDecimal <= dayEnd) {
            const gapStart = slot.endDecimal - 0.5;
            gaps.push({ start: gapStart, end: slot.endDecimal, duration: 0.5 });
            current = slot.endDecimal;
        } else {
            current += 0.5;
        }
    }
    return gaps;
}

// ===================================
// Displaceability Score
// ===================================

/**
 * Calculate how easily an operation can be displaced
 */
export function calculateDisplaceabilityScore(operation, commandeData, currentDate) {
    const deliveryDate = new Date(commandeData.dateLivraison);
    const now = new Date(currentDate);

    // Temps restant jusqu'à la livraison (en heures)
    const timeUntilDelivery = (deliveryDate - now) / (1000 * 60 * 60);

    // Calculer le travail restant
    let remainingWork = 0;
    commandeData.operations.forEach(op => {
        if (op.slots && op.slots.length > 0) {
            const totalSlotted = op.slots.reduce((sum, slot) => sum + (slot.duree || 0), 0);
            remainingWork += Math.max(0, op.dureeTotal - totalSlotted);
        } else {
            remainingWork += op.dureeTotal || 0;
        }
    });

    if (remainingWork === 0) remainingWork = 0.1;

    const slack = timeUntilDelivery - remainingWork;
    const criticalRatio = timeUntilDelivery / remainingWork;
    const score = (slack * 0.6) + (criticalRatio * 0.4);

    return {
        score,
        slack,
        criticalRatio,
        remainingWork,
        timeUntilDelivery
    };
}

// ===================================
// Find Next Available Slot for Displacement
// ===================================

/**
 * Find next available slot for displacement with robust gap finding
 * Returns: { week, year, day, startHour, endHour, isOvertime } or null
 */
export function findNextAvailableSlotForDisplacement(machine, duration, startDay, startWeek, startYear, minHour, allowOvertime = true) {
    console.log(`[GAP_FINDER] Searching slot: machine=${machine}, duration=${duration}h, from ${startDay} week ${startWeek}, minHour=${minHour}, overtime=${allowOvertime}`);

    const SEARCH_HORIZON_DAYS = 14;
    let searchDate = getDateFromWeekAndDay(startWeek, startYear, startDay);
    searchDate.setHours(Math.floor(minHour), Math.round((minHour - Math.floor(minHour)) * 60), 0, 0);

    const now = new Date();

    for (let dayOffset = 0; dayOffset < SEARCH_HORIZON_DAYS; dayOffset++) {
        const weekNum = getWeekNumber(searchDate);
        const yearNum = getISOWeekYear(searchDate);
        const dayIdx = searchDate.getDay() - 1;

        if (dayIdx < 0 || dayIdx > 4) {
            searchDate.setDate(searchDate.getDate() + 1);
            continue;
        }

        const dayName = DAYS_OF_WEEK[dayIdx];
        const schedule = getScheduleForDay(dayName);

        const isToday = searchDate.toDateString() === now.toDateString();
        const currentHourDecimal = now.getHours() + now.getMinutes() / 60;
        const searchStartHour = (dayOffset === 0) ?
            Math.max(schedule.start, minHour, isToday ? currentHourDecimal : 0) :
            schedule.start;

        const searchEndHour = allowOvertime ? schedule.overtimeEnd : schedule.standardEnd;

        // Récupérer tous les créneaux occupés
        const busySlots = [];
        const placedOrders = getPlacedOrders();

        placedOrders.forEach(cmd => {
            cmd.operations.forEach(op => {
                if (!op.slots) return;
                op.slots.forEach(slot => {
                    if (slot.machine !== machine || slot.jour !== dayName) return;
                    if (slot.semaine !== weekNum) return;
                    if (slot.annee && slot.annee !== yearNum) return;

                    busySlots.push({
                        start: timeToDecimalHours(slot.heureDebut),
                        end: timeToDecimalHours(slot.heureFin),
                        type: 'operation'
                    });
                });
            });
        });

        // Ajouter les systemEvents expansés
        getExpandedSystemEvents()
            .filter(e => (e.machine === machine || e.machine === 'ALL') &&
                         e.day === dayName &&
                         e.week === weekNum &&
                         (!e.year || e.year === yearNum))
            .forEach(e => {
                busySlots.push({
                    start: timeToDecimalHours(e.startTime),
                    end: timeToDecimalHours(e.endTime),
                    type: 'system'
                });
            });

        // Ajouter les zones bloquees
        const blockedZones = getBlockedZonesForDay(dayName);
        blockedZones.forEach(zone => {
            busySlots.push({ start: zone.start, end: zone.end, type: zone.type });
        });

        busySlots.sort((a, b) => a.start - b.start);

        // Chercher des gaps
        let currentPointer = searchStartHour;

        for (const busy of busySlots) {
            if (currentPointer < busy.start) {
                const gapSize = busy.start - currentPointer;

                if (gapSize >= duration - 0.001) {
                    const endHour = currentPointer + duration;

                    if (endHour <= searchEndHour + 0.001) {
                        const isOvertime = endHour > schedule.standardEnd;

                        console.log(`[GAP_FINDER] ✓ Found slot: ${dayName} ${decimalToTimeString(currentPointer)}-${decimalToTimeString(endHour)} (overtime=${isOvertime})`);

                        return {
                            machine: machine,
                            week: weekNum,
                            year: yearNum,
                            day: dayName,
                            startHour: currentPointer,
                            endHour: endHour,
                            isOvertime: isOvertime
                        };
                    }
                }
            }
            currentPointer = Math.max(currentPointer, busy.end);
        }

        // Vérifier le dernier gap
        if (currentPointer + duration <= searchEndHour + 0.001) {
            const endHour = currentPointer + duration;
            const isOvertime = endHour > schedule.standardEnd;

            console.log(`[GAP_FINDER] ✓ Found slot (end of day): ${dayName} ${decimalToTimeString(currentPointer)}-${decimalToTimeString(endHour)} (overtime=${isOvertime})`);

            return {
                machine: machine,
                week: weekNum,
                year: yearNum,
                day: dayName,
                startHour: currentPointer,
                endHour: endHour,
                isOvertime: isOvertime
            };
        }

        // Passer au jour suivant
        searchDate.setDate(searchDate.getDate() + 1);
    }

    console.log(`[GAP_FINDER] ✗ No slot found after ${SEARCH_HORIZON_DAYS} days`);
    return null;
}

// ===================================
// Split Operations
// ===================================

/**
 * Scinde une opération à la limite des heures normales (évite les heures sup)
 */
export function splitAtNormalHoursEnd(operation, machine, startWeek, startYear, startDay, startHour) {
    const fragments = [];
    let remainingDuration = operation.dureeTotal;
    let currentWeek = startWeek;
    let currentYear = startYear;
    let currentDay = startDay;
    let currentHour = startHour;

    console.log(`[SPLIT-NORMAL] Scindage à limite heures normales pour ${operation.type} (${remainingDuration}h) à partir de ${currentDay} ${decimalToTimeString(currentHour)}`);

    while (remainingDuration > 0.01) {
        const schedule = getScheduleForDay(currentDay);
        const normalEnd = schedule.standardEnd;

        // Gerer toutes les zones bloquees (pauses + gaps inter-equipes)
        let fragmentEnd = currentHour + remainingDuration;
        const blockedZones = getBlockedZonesForDay(currentDay);

        for (const zone of blockedZones) {
            if (currentHour < zone.start && fragmentEnd > zone.start) {
                // Split avant la zone bloquee
                const durationBeforeZone = zone.start - currentHour;
                console.log(`[SPLIT-NORMAL] ⚠️ Opération chevauche ${zone.name} → split avant zone (${durationBeforeZone}h)`);

                fragments.push({
                    duration: durationBeforeZone,
                    machine: machine,
                    week: currentWeek,
                    year: currentYear,
                    day: currentDay,
                    startHour: currentHour,
                    endHour: zone.start,
                    type: operation.type
                });

                remainingDuration -= durationBeforeZone;
                currentHour = zone.end;
                fragmentEnd = calculateEndTimeWithBreaks(currentHour, remainingDuration, currentDay);
            }
        }

        // Vérifier si dépasse les heures normales
        if (fragmentEnd > normalEnd) {
            const durationUntilNormalEnd = normalEnd - currentHour;
            console.log(`[SPLIT-NORMAL] ⚠️ Opération dépasse heures normales → split à ${decimalToTimeString(normalEnd)} (${durationUntilNormalEnd}h)`);

            fragments.push({
                duration: durationUntilNormalEnd,
                machine: machine,
                week: currentWeek,
                year: currentYear,
                day: currentDay,
                startHour: currentHour,
                endHour: normalEnd,
                type: operation.type
            });

            remainingDuration -= durationUntilNormalEnd;

            // Passer au jour suivant
            const nextDay = getNextWorkDay(currentDay, currentWeek, currentYear);
            if (!nextDay) {
                console.error('[SPLIT-NORMAL] ✗ Impossible de continuer au jour suivant');
                break;
            }

            currentWeek = nextDay.week;
            currentYear = nextDay.year;
            currentDay = nextDay.day;
            currentHour = getScheduleForDay(currentDay).start;
            console.log(`[SPLIT-NORMAL] Continuation le lendemain: ${currentDay} semaine ${currentWeek} à ${decimalToTimeString(currentHour)}`);
        } else {
            // Tient dans la journée (heures normales)
            fragments.push({
                duration: remainingDuration,
                machine: machine,
                week: currentWeek,
                year: currentYear,
                day: currentDay,
                startHour: currentHour,
                endHour: fragmentEnd,
                type: operation.type
            });

            remainingDuration = 0;
        }
    }

    console.log(`[SPLIT-NORMAL] Résultat: ${fragments.length} fragment(s):`, fragments.map(f => `${f.day} ${decimalToTimeString(f.startHour)}-${decimalToTimeString(f.endHour)} (${f.duration}h)`));
    return fragments;
}

/**
 * Split intelligent d'une opération en fragments si nécessaire
 */
export function splitOperationForSlot(operation, machine, startWeek, startYear, startDay, startHour) {
    const fragments = [];
    let remainingDuration = operation.dureeTotal || operation.duration;
    let currentWeek = startWeek;
    let currentYear = startYear;
    let currentDay = startDay;
    let currentHour = startHour;

    console.log(`[SPLIT] Checking if split needed for ${operation.type || 'operation'} (${remainingDuration}h) starting at ${currentDay} ${decimalToTimeString(currentHour)}`);

    while (remainingDuration > 0.01) {
        const schedule = getScheduleForDay(currentDay);

        // Verifier si on chevauche une zone bloquee
        let fragmentEnd = currentHour + remainingDuration;
        const blockedZones = getBlockedZonesForDay(currentDay);

        for (const zone of blockedZones) {
            if (currentHour < zone.start && fragmentEnd > zone.start) {
                const durationBeforeZone = zone.start - currentHour;
                console.log(`[SPLIT] ⚠️ Operation crosses ${zone.name} → splitting before zone (${durationBeforeZone}h)`);

                fragments.push({
                    duration: durationBeforeZone,
                    machine: machine,
                    week: currentWeek,
                    year: currentYear,
                    day: currentDay,
                    startHour: currentHour,
                    endHour: zone.start,
                    type: operation.type || operation.operationType
                });

                remainingDuration -= durationBeforeZone;
                currentHour = zone.end;
                fragmentEnd = calculateEndTimeWithBreaks(currentHour, remainingDuration, currentDay);
            }
        }

        // Vérifier si l'opération dépasse la fin de journée
        if (fragmentEnd > schedule.overtimeEnd) {
            const durationUntilEOD = schedule.overtimeEnd - currentHour;
            console.log(`[SPLIT] ⚠️ Operation exceeds end of day → splitting at EOD (${durationUntilEOD}h)`);

            fragments.push({
                duration: durationUntilEOD,
                machine: machine,
                week: currentWeek,
                year: currentYear,
                day: currentDay,
                startHour: currentHour,
                endHour: schedule.overtimeEnd,
                type: operation.type || operation.operationType
            });

            remainingDuration -= durationUntilEOD;

            // Passer au jour suivant
            const nextDay = getNextWorkDay(currentDay, currentWeek, currentYear);
            if (!nextDay) {
                console.log(`[SPLIT] ✗ Cannot continue to next day`);
                break;
            }

            currentWeek = nextDay.week;
            currentYear = nextDay.year;
            currentDay = nextDay.day;
            currentHour = getScheduleForDay(currentDay).start;
            console.log(`[SPLIT] Continuing on next day: ${currentDay} week ${currentWeek} at ${decimalToTimeString(currentHour)}`);
        } else {
            // Pas de split nécessaire
            fragments.push({
                duration: remainingDuration,
                machine: machine,
                week: currentWeek,
                year: currentYear,
                day: currentDay,
                startHour: currentHour,
                endHour: currentHour + remainingDuration,
                type: operation.type || operation.operationType
            });

            remainingDuration = 0;
        }
    }

    console.log(`[SPLIT] Result: ${fragments.length} fragment(s):`, fragments.map(f => `${f.day} ${decimalToTimeString(f.startHour)}-${decimalToTimeString(f.endHour)}`));
    return fragments;
}

// ===================================
// Displacement with Cascade
// ===================================

/**
 * Déplace une opération et toutes les opérations suivantes en cascade
 */
export function displaceOperationWithCascade(conflict, destinationSlot, now) {
    const allDisplacements = [];
    const commande = conflict.commande;

    console.log(`[CASCADE] Displacing ${conflict.operation.type} of order ${commande.id} and following operations...`);

    // 1. Déplacer l'opération principale
    const mainDisplacement = {
        commandeId: commande.id,
        operationType: conflict.operation.type,
        oldSlot: {
            machine: conflict.slot.machine,
            week: conflict.slot.semaine,
            year: conflict.slot.annee,
            day: conflict.slot.jour,
            startTime: conflict.slot.heureDebut,
            endTime: conflict.slot.heureFin
        },
        newSlot: {
            machine: destinationSlot.machine,
            week: destinationSlot.week,
            year: destinationSlot.year,
            day: destinationSlot.day,
            startTime: decimalToTimeString(destinationSlot.startHour),
            endTime: decimalToTimeString(destinationSlot.endHour)
        },
        operation: conflict.operation,
        slot: conflict.slot
    };

    allDisplacements.push(mainDisplacement);

    // 2. Déplacer les opérations suivantes en cascade
    const followingOps = getFollowingOperations(commande, conflict.operation);

    if (followingOps.length > 0) {
        console.log(`[CASCADE] Found ${followingOps.length} following operations to cascade:`, followingOps.map(op => op.type));

        let currentEndWeek = destinationSlot.week;
        let currentEndYear = destinationSlot.year;
        let currentEndDay = destinationSlot.day;
        let currentEndHour = destinationSlot.endHour;

        for (const followingOp of followingOps) {
            if (!followingOp.slots || followingOp.slots.length === 0) {
                console.log(`[CASCADE] ⚠️ Following operation ${followingOp.type} has no slots, skipping cascade`);
                continue;
            }

            const currentSlot = followingOp.slots[0];
            const opDuration = followingOp.dureeTotal;
            const opMachines = getMachinesForOp(followingOp.type);

            console.log(`[CASCADE] Searching best slot for ${followingOp.type} across ${opMachines.length} machines...`);

            let bestSlot = null;
            for (const machine of opMachines) {
                const candidateSlot = findNextAvailableSlotForDisplacement(
                    machine,
                    opDuration,
                    currentEndDay,
                    currentEndWeek,
                    currentEndYear,
                    currentEndHour,
                    true
                );

                if (candidateSlot) {
                    console.log(`[CASCADE]   - Machine ${machine}: ${candidateSlot.day} ${decimalToTimeString(candidateSlot.startHour)}`);

                    if (!bestSlot) {
                        bestSlot = candidateSlot;
                    } else {
                        bestSlot = compareSlotsForSequencing(
                            candidateSlot,
                            bestSlot,
                            currentEndWeek,
                            currentEndYear,
                            currentEndDay,
                            currentEndHour
                        );
                    }
                }
            }

            if (!bestSlot) {
                console.log(`[CASCADE] ✗ Cannot find slot for following operation ${followingOp.type}, cascade failed`);
                return null;
            }

            console.log(`[CASCADE] ✓ Best slot for ${followingOp.type}: Machine ${bestSlot.machine}, ${bestSlot.day} ${decimalToTimeString(bestSlot.startHour)}-${decimalToTimeString(bestSlot.endHour)}`);

            // SPLIT INTELLIGENT
            const opFragments = splitOperationForSlot(
                followingOp,
                bestSlot.machine,
                bestSlot.week,
                bestSlot.year,
                bestSlot.day,
                bestSlot.startHour
            );

            for (let fragIdx = 0; fragIdx < opFragments.length; fragIdx++) {
                const frag = opFragments[fragIdx];

                allDisplacements.push({
                    commandeId: commande.id,
                    operationType: followingOp.type,
                    oldSlot: {
                        machine: currentSlot.machine,
                        week: currentSlot.semaine,
                        year: currentSlot.annee,
                        day: currentSlot.jour,
                        startTime: currentSlot.heureDebut,
                        endTime: currentSlot.heureFin
                    },
                    newSlot: {
                        machine: frag.machine,
                        week: frag.week,
                        year: frag.year,
                        day: frag.day,
                        startTime: decimalToTimeString(frag.startHour),
                        endTime: decimalToTimeString(frag.endHour)
                    },
                    operation: followingOp,
                    slot: currentSlot,
                    fragmentIndex: fragIdx,
                    totalFragments: opFragments.length
                });
            }

            // Mettre à jour pour l'opération suivante
            const lastFragment = opFragments[opFragments.length - 1];
            currentEndWeek = lastFragment.week;
            currentEndYear = lastFragment.year;
            currentEndDay = lastFragment.day;
            currentEndHour = lastFragment.endHour;
        }
    }

    return allDisplacements;
}

/**
 * Essaie de déplacer tous les conflits (avec cascade des opérations liées)
 */
export function tryDisplaceConflicts(conflicts, machine, dayName, weekNum, yearNum, afterHour, mode, crThreshold, now) {
    const result = {
        success: false,
        displacements: [],
        totalDisplacement: 0
    };

    for (const conflict of conflicts) {
        // Calculer CR avant
        const scoreDataBefore = calculateDisplaceabilityScore(
            conflict.operation,
            conflict.commande,
            now
        );

        // Chercher créneau de destination
        const opDuration = conflict.slotEnd - conflict.slotStart;
        const destinationSlot = findNextAvailableSlotForDisplacement(
            machine,
            opDuration,
            dayName,
            weekNum,
            yearNum,
            afterHour,
            true
        );

        if (!destinationSlot) {
            console.log(`[DISPLACE] ✗ No destination slot for ${conflict.commandeId} ${conflict.operation.type}`);
            return result;
        }

        // Ajouter la machine au destinationSlot
        destinationSlot.machine = machine;

        // DÉPLACEMENT EN CASCADE
        const cascadeDisplacements = displaceOperationWithCascade(conflict, destinationSlot, now);

        if (!cascadeDisplacements) {
            console.log(`[DISPLACE] ✗ Cascade displacement failed for ${conflict.commandeId} ${conflict.operation.type}`);
            return result;
        }

        // Calculer CR après pour TOUS les déplacements en cascade
        let totalDisplacementMinutes = 0;
        for (const disp of cascadeDisplacements) {
            const oldStart = timeToDecimalHours(disp.oldSlot.startTime);
            const newStart = timeToDecimalHours(disp.newSlot.startTime);
            const dispMinutes = (newStart - oldStart) * 60;
            totalDisplacementMinutes += Math.abs(dispMinutes);

            const newDeliveryDate = new Date(conflict.commande.dateLivraison);
            const newRemainingTime = (newDeliveryDate - now) / (1000 * 60 * 60) - (dispMinutes / 60);
            const newCR = newRemainingTime / Math.max(0.1, scoreDataBefore.remainingWork);

            // Vérifier seuil CR
            if (newCR < crThreshold) {
                if (mode === 'FORCE') {
                    console.log(`[DISPLACE] ⚠️ FORCE mode: accepting risky displacement (CR ${newCR.toFixed(2)} < ${crThreshold})`);
                } else {
                    console.log(`[DISPLACE] ✗ CR too low after cascade displacement: ${newCR.toFixed(2)} < ${crThreshold}`);
                    return result;
                }
            }

            disp.displacement = dispMinutes;
            disp.crBefore = scoreDataBefore.criticalRatio;
            disp.crAfter = newCR;
            disp.slack = scoreDataBefore.slack;
            disp.criticalRatio = newCR;
            disp.score = scoreDataBefore.score;
            disp.status = newCR < crThreshold ? 'RISQUE' : 'OK';
        }

        result.displacements.push(...cascadeDisplacements);
        result.totalDisplacement += totalDisplacementMinutes;
    }

    result.success = true;
    return result;
}

// ===================================
// Cascade Reschedule
// ===================================

/**
 * Cascade Reschedule: Automatically moves subsequent operations if chronological order is broken
 * RÈGLE: Cascade UNIQUEMENT si Cisaillage est modifié
 */
export function replanifierOperationsSuivantes(cmd, modifiedOp) {
    // Ne cascader que si l'opération modifiée est Cisaillage
    if (modifiedOp.type !== 'Cisaillage') {
        return;
    }

    const priority = ['Cisaillage', 'Poinçonnage', 'Pliage'];
    const startIdx = priority.indexOf(modifiedOp.type);

    if (startIdx === -1 || startIdx === priority.length - 1) return;

    let previousOp = modifiedOp;

    for (let i = startIdx + 1; i < priority.length; i++) {
        const currentType = priority[i];
        const currentOp = cmd.operations.find(o => o.type === currentType);

        if (!currentOp || !currentOp.slots || currentOp.slots.length === 0) {
            previousOp = currentOp || previousOp;
            continue;
        }

        // 1. Get End Time of Previous Op
        const prevSlots = [...previousOp.slots];
        if (prevSlots.length === 0) continue;

        prevSlots.sort((a,b) => {
            if (a.semaine !== b.semaine) return a.semaine - b.semaine;
            const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
            if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
            return a.heureFin.localeCompare(b.heureFin);
        });
        const lastPrevSlot = prevSlots[prevSlots.length - 1];

        // 2. Get Start Time of Current Op
        const currentSlots = [...currentOp.slots];
        currentSlots.sort((a,b) => {
            if (a.semaine !== b.semaine) return a.semaine - b.semaine;
            const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
            if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
            return a.heureDebut.localeCompare(b.heureDebut);
        });
        const firstCurrentSlot = currentSlots[0];

        // 3. Check Conflict
        let isConflict = false;
        const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];

        if (lastPrevSlot.semaine > firstCurrentSlot.semaine) isConflict = true;
        else if (lastPrevSlot.semaine === firstCurrentSlot.semaine) {
            const prevDayIdx = days.indexOf(lastPrevSlot.jour);
            const currDayIdx = days.indexOf(firstCurrentSlot.jour);

            if (prevDayIdx > currDayIdx) isConflict = true;
            else if (prevDayIdx === currDayIdx) {
                const prevEndParts = lastPrevSlot.heureFin.split(':');
                const currStartParts = firstCurrentSlot.heureDebut.split(':');
                const prevEndDec = parseInt(prevEndParts[0]) + parseInt(prevEndParts[1])/60;
                const currStartDec = parseInt(currStartParts[0]) + parseInt(currStartParts[1])/60;

                if (prevEndDec > currStartDec) isConflict = true;
            }
        }

        // 4. Resolve Conflict: Replan
        if (isConflict) {
            console.log(`Cascade: Décalage nécessaire pour ${currentType} (Conflit avec ${previousOp.type})`);

            currentOp.slots = [];
            currentOp.statut = "Non placée";

            const constraint = {
                week: lastPrevSlot.semaine,
                dayIndex: days.indexOf(lastPrevSlot.jour),
                timeStr: lastPrevSlot.heureFin
            };

            let machines = [];
            if (currentType === 'Cisaillage') machines = State.MACHINES.cisailles;
            else if (currentType === 'Poinçonnage') machines = State.MACHINES.poinconneuses;
            else if (currentType === 'Pliage') machines = State.MACHINES.plieuses;

            let remainingDuration = currentOp.dureeTotal;

            while (remainingDuration > 0.01) {
                const bestSlot = findBestMachineSlot(currentOp, cmd, machines, remainingDuration, constraint);

                if (!bestSlot) {
                    Toast.warning(`⚠️ Impossible de replacer ${currentType} automatiquement.`);
                    break;
                }

                const placedDuration = bestSlot.usableDuration;

                const startParts = bestSlot.startTime.split(':');
                const startDec = parseInt(startParts[0]) + parseInt(startParts[1])/60;
                const endDec = startDec + placedDuration;
                const endH = Math.floor(endDec);
                const endM = Math.round((endDec - endH) * 60);
                const endTime = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;

                currentOp.slots.push({
                    id: generateSlotId(currentOp.id, currentOp.slots),
                    machine: bestSlot.machine,
                    duree: placedDuration,
                    semaine: bestSlot.week,
                    jour: bestSlot.day,
                    heureDebut: bestSlot.startTime,
                    heureFin: endTime,
                    dateDebut: getDateFromWeekDay(bestSlot.week, bestSlot.day, bestSlot.startTime, bestSlot.year).toISOString(),
                    dateFin: getDateFromWeekDay(bestSlot.week, bestSlot.day, endTime, bestSlot.year).toISOString()
                });

                remainingDuration -= placedDuration;
            }

            if (currentOp.slots.length > 0) {
                currentOp.statut = "Planifiée";
                Toast.info(`Décalage auto : ${currentType}`);
            }
        }

        previousOp = currentOp;
    }
}

// ===================================
// Auto Placement
// ===================================

/**
 * Automatically place an order
 * Support du placement parallèle Poinçonnage/Pliage
 */
export async function placerAutomatiquement(commandeId) {
    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) return;

    // 🔒 VALIDATION CRITIQUE
    const orderValidation = validateOperationOrder(cmd);
    if (!orderValidation.valid) {
        alert('⛔ ORDRE DE PRODUCTION INVALIDE\n\n' + orderValidation.message);
        return;
    }

    // Vérifier si la commande a Poinçonnage ET Pliage (tous deux non placés)
    const poinconnageOp = cmd.operations.find(op => op.type === 'Poinçonnage' && (!op.slots || op.slots.length === 0));
    const pliageOp = cmd.operations.find(op => op.type === 'Pliage' && (!op.slots || op.slots.length === 0));

    let placeInParallel = false;

    if (poinconnageOp && pliageOp) {
        placeInParallel = confirm(
            'Cette commande contient Poinçonnage et Pliage.\n\n' +
            'Voulez-vous les placer en parallèle (même créneau horaire) ?\n\n' +
            '• OK = Placement en parallèle\n' +
            '• Annuler = Placement séquentiel (Poinçonnage puis Pliage)'
        );
    }

    // 🕒 RUSH HOUR LOGIC
    let globalMinStart = null;
    const now = new Date();

    const currentWeek = getWeekNumber(now);
    let currentDayIndex = now.getDay() - 1;
    if (currentDayIndex === -1) currentDayIndex = 6;

    const currentHour = now.getHours() + now.getMinutes() / 60;

    console.log(`📅 DEBUG Placement Auto: Date actuelle = ${now.toLocaleDateString('fr-FR')}, Semaine ${currentWeek}, Jour index ${currentDayIndex}, Heure ${currentHour.toFixed(2)}`);

    const isRushHour = (currentHour >= 9 && currentHour < 10);

    if (currentDayIndex >= 0 && currentDayIndex < 5) {
        if (isRushHour) {
            globalMinStart = { week: currentWeek, dayIndex: currentDayIndex, timeStr: "00:00" };
            console.log("🚀 Rush Hour Mode (Morning): Prioritizing Today (filling gaps from start of day)!");
            Toast.info("Mode Matin : Optimisation du planning journée");
        } else {
            const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
            globalMinStart = { week: currentWeek, dayIndex: currentDayIndex, timeStr: timeStr };
            console.log(`🕒 Standard Mode: Starting search from ${timeStr}`);
        }
    } else {
        globalMinStart = { week: currentWeek + 1, dayIndex: 0, timeStr: "00:00" };
        console.log("📅 Week-end : Démarrage de la recherche lundi prochain");
    }

    // Constraint après Cisaillage pour le placement parallèle
    let constraintAfterCisaillage = null;

    for (const operation of cmd.operations) {
        if (operation.slots.length > 0) continue;

        let availableMachines = [];
        if (operation.type === 'Cisaillage') availableMachines = State.MACHINES.cisailles;
        else if (operation.type === 'Poinçonnage') availableMachines = State.MACHINES.poinconneuses;
        else if (operation.type === 'Pliage') availableMachines = State.MACHINES.plieuses;

        let remainingDuration = operation.dureeTotal;
        let placementFailed = false;
        let assignedMachine = null;
        let nextStartConstraint = null;

        let parallelStartConstraint = null;
        if (placeInParallel && (operation.type === 'Poinçonnage' || operation.type === 'Pliage')) {
            parallelStartConstraint = constraintAfterCisaillage || globalMinStart;
            console.log(`🔀 Mode parallèle: ${operation.type} démarre à S${parallelStartConstraint.week} ${DAYS_OF_WEEK[parallelStartConstraint.dayIndex]} ${parallelStartConstraint.timeStr}`);
        }

        while (remainingDuration > 0.01) {
            let machineList = availableMachines;
            let searchConstraint = parallelStartConstraint || globalMinStart;

            if (assignedMachine) {
                machineList = [assignedMachine];
                searchConstraint = nextStartConstraint;
                console.log(`🔗 Continuité sur ${assignedMachine}, recherche à partir de S${searchConstraint.week} ${DAYS_OF_WEEK[searchConstraint.dayIndex]} ${searchConstraint.timeStr}`);
            }

            const bestSlot = findBestMachineSlot(operation, cmd, machineList, remainingDuration, searchConstraint);

            if (!bestSlot) {
                console.warn(`⚠️ Impossible de placer une partie de l'opération ${operation.type} (${remainingDuration}h) de la commande ${cmd.id}`);
                alert(`⚠️ Impossible de placer ${operation.type} (reste ${formatHours(remainingDuration)}). Les opérations suivantes ne seront pas planifiées.`);
                placementFailed = true;
                break;
            }

            if (!assignedMachine) {
                assignedMachine = bestSlot.machine;
                console.log(`Machine assignée pour ${operation.type}: ${assignedMachine}`);
            }

            let placedDuration = bestSlot.usableDuration;
            let useOvertime = false;

            const startParts = bestSlot.startTime.split(':');
            const startHourFloat = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;

            if (placedDuration < remainingDuration) {
                const normalEndHour = bestSlot.day === 'Vendredi' ? 12 : 16.5;
                const overtimeEndHour = bestSlot.day === 'Vendredi' ? 14 : 18;
                const maxOvertimeHours = overtimeEndHour - normalEndHour;

                const currentEndHourFloat = startHourFloat + placedDuration;

                if (currentEndHourFloat >= normalEndHour - 0.1 && remainingDuration - placedDuration > 0.1) {
                    const overtimeNeeded = Math.min(remainingDuration - placedDuration, maxOvertimeHours);

                    const currentOvertimeUsed = State.overtimeTracker.byMachine[assignedMachine]?.hours || 0;
                    const weeklyOvertimeUsed = State.overtimeTracker.totalHoursUsed || 0;

                    const canUseOvertime = (
                        currentOvertimeUsed + overtimeNeeded <= State.CAPACITY_CONFIG.overtime.maxDailyHours &&
                        weeklyOvertimeUsed + overtimeNeeded <= State.CAPACITY_CONFIG.overtime.maxWeeklyHours
                    );

                    if (canUseOvertime && overtimeNeeded > 0.25) {
                        const confirmResult = await showOvertimeConfirmDialog({
                            type: operation.type,
                            machine: assignedMachine,
                            day: bestSlot.day,
                            normalDuration: placedDuration,
                            overtimeDuration: overtimeNeeded,
                            totalDuration: placedDuration + overtimeNeeded
                        });

                        if (confirmResult === 'accept') {
                            useOvertime = true;
                            placedDuration += overtimeNeeded;

                            if (!State.overtimeTracker.byMachine[assignedMachine]) {
                                State.overtimeTracker.byMachine[assignedMachine] = { hours: 0 };
                            }
                            State.overtimeTracker.byMachine[assignedMachine].hours += overtimeNeeded;
                            State.overtimeTracker.totalHoursUsed += overtimeNeeded;

                            console.log(`⏰ Heures supplémentaires utilisées: ${formatHours(overtimeNeeded)} sur ${assignedMachine}`);
                        } else {
                            console.log(`❌ Heures supplémentaires refusées, continue demain`);
                        }
                    } else if (!canUseOvertime) {
                        console.log(`⚠️ Limite d'heures supplémentaires atteinte, continue demain`);
                    }
                }
            }

            // Calculate end time
            const endHourFloat = startHourFloat + placedDuration;
            const endHour = Math.floor(endHourFloat);
            const endMinute = Math.round((endHourFloat - endHour) * 60);
            const endTime = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;

            const startDate = getDateFromWeekDay(bestSlot.week, bestSlot.day, bestSlot.startTime, bestSlot.year);
            const endDate = getDateFromWeekDay(bestSlot.week, bestSlot.day, endTime, bestSlot.year);

            operation.slots.push({
                id: generateSlotId(operation.id, operation.slots),
                machine: bestSlot.machine,
                duree: placedDuration,
                semaine: bestSlot.week,
                jour: bestSlot.day,
                heureDebut: bestSlot.startTime,
                heureFin: endTime,
                dateDebut: startDate.toISOString().split('.')[0],
                dateFin: endDate.toISOString().split('.')[0]
            });

            console.log(`✅ Placé ${operation.type} (partie ${formatHours(placedDuration)}) sur ${bestSlot.machine} - S${bestSlot.week} ${bestSlot.day} ${bestSlot.startTime}`);

            remainingDuration -= placedDuration;

            if (remainingDuration > 0.01) {
                const dayIndex = DAYS_OF_WEEK.indexOf(bestSlot.day);
                const endHourFloat2 = startHourFloat + placedDuration;

                const dayEndHour = bestSlot.day === 'Vendredi' ? (useOvertime ? 14 : 12) : (useOvertime ? 18 : 16.5);

                if (endHourFloat2 >= dayEndHour - 0.1) {
                    let nextDayIndex = dayIndex + 1;
                    let nextWeek = bestSlot.week;

                    if (nextDayIndex >= DAYS_OF_WEEK.length) {
                        nextDayIndex = 0;
                        nextWeek = bestSlot.week + 1;
                        if (nextWeek > 52) {
                            nextWeek = 1;
                        }
                    }

                    nextStartConstraint = {
                        week: nextWeek,
                        dayIndex: nextDayIndex,
                        timeStr: "07:30"
                    };

                    console.log(`➡️  ${formatHours(remainingDuration)} restant, continue ${DAYS_OF_WEEK[nextDayIndex]} S${nextWeek} 07:30`);
                } else {
                    nextStartConstraint = {
                        week: bestSlot.week,
                        dayIndex: dayIndex,
                        timeStr: endTime
                    };

                    console.log(`➡️  ${formatHours(remainingDuration)} restant, continue après ${endTime}`);
                }
            }
        }

        if (placementFailed) {
            break;
        }

        operation.statut = "Planifiée";

        // Sauvegarder la contrainte après Cisaillage pour le placement parallèle
        if (operation.type === 'Cisaillage' && placeInParallel) {
            if (operation.slots.length > 0) {
                const lastSlot = [...operation.slots].sort((a, b) => {
                    if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                    const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
                    if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                    return a.heureFin.localeCompare(b.heureFin);
                }).pop();

                constraintAfterCisaillage = {
                    week: lastSlot.semaine,
                    dayIndex: DAYS_OF_WEEK.indexOf(lastSlot.jour),
                    timeStr: lastSlot.heureFin
                };
                console.log(`📌 Contrainte après Cisaillage sauvegardée: S${constraintAfterCisaillage.week} ${lastSlot.jour} ${constraintAfterCisaillage.timeStr}`);
            }
        }
    }

    // Update command status
    const allPlaced = cmd.operations.every(op => op.slots.length > 0);
    if (allPlaced) {
        cmd.statut = "Planifiée";
        Toast.success(`Commande ${commandeId} placée avec succès`);
    } else {
        alert(`⚠️ Commande ${commandeId} partiellement placée. Certaines opérations n'ont pas pu être placées.`);
    }

    // historyManager not available here — will be handled in init or caller
    saveData(commandeId);

    // Re-render
    refresh();
}

// ===================================
// Window exports (needed by onclick handlers in HTML)
// ===================================
window.placerAutomatiquement = placerAutomatiquement;
window.replanifierOperationsSuivantes = replanifierOperationsSuivantes;
window.splitAtNormalHoursEnd = splitAtNormalHoursEnd;
window.splitOperationForSlot = splitOperationForSlot;


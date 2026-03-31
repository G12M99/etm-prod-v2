/**
 * @module ui-day
 * @description Rendu DOM de la Vue Journ\u00e9e (timeline horaire par machine).
 * @requires state.js, utils.js, scheduling.js
 */

import { State, getMachineTypeClass } from './state.js';
import {
    formatDate, formatHours, escapeHtml, getWeekDateRange,
    getDateFromWeekDay, getWeekNumber, getISOWeekYear,
    decimalToTimeString, timeToDecimalHours, timeStringToDecimal, DAYS_OF_WEEK, Toast
} from './utils.js';
import {
    getPlacedOrders, calculerCapaciteJour,
    getGlobalScheduleRangeForDay, getScheduleForDay,
    getBlockedZonesForDay, getExpandedSystemEvents
} from './scheduling.js';
import { initDragAndDrop } from './drag-drop.js';

/**
 * Render the day/week timeline view.
 * Writes into #planningContainer.
 */
export function renderVueJournee() {
    const container = document.getElementById('planningContainer');
    const weekRange = getWeekDateRange(State.semaineSelectionnee, State.anneeSelectionnee);

    let html = '<div class="vue-journee">';

    // Header with back button and navigation
    html += `
        <div class="journee-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
            <button class="btn btn-secondary" id="btnBackToWeek">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M12 4l-8 6 8 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Retour 3 Semaines
            </button>

            <div style="display:flex; align-items:center; gap:20px;">
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(-1)">&#10094; Pr\u00e9c\u00e9dente</button>
                <h2 style="margin:0;">Semaine ${State.semaineSelectionnee} <small>${State.anneeSelectionnee}</small> <span style="font-size:0.7em; font-weight:normal; color:var(--color-text-secondary);">(${weekRange.start}-${weekRange.end} ${weekRange.month})</span></h2>
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(1)">Suivante &#10095;</button>
            </div>

            <div class="search-box" style="display:flex; align-items:center; gap:8px;">
                <input
                    type="text"
                    id="searchOperations"
                    placeholder="Commande ou client..."
                    style="padding:8px 12px; border:2px solid #ddd; border-radius:8px; font-size:14px; min-width:220px; transition: all 0.2s;"
                    onfocus="this.style.borderColor='var(--color-primary)'; this.style.boxShadow='0 0 0 3px rgba(37, 99, 235, 0.1)'"
                    onblur="this.style.borderColor='#ddd'; this.style.boxShadow='none'"
                >
                <button class="btn btn-sm btn-secondary" id="btnClearSearch" title="Effacer la recherche" style="display:none;">\u2715</button>
            </div>
        </div>
    `;

    // Day headers generator
    const generateDayHeaders = () => {
        let headersHtml = '<div class="day-headers">';
        headersHtml += '<div class="day-header-cell machine-col">Machine</div>';
        DAYS_OF_WEEK.forEach(day => {
            const dateObj = getDateFromWeekDay(State.semaineSelectionnee, day, '00:00', State.anneeSelectionnee);
            const dayNum = dateObj.getDate().toString().padStart(2, '0');
            const monthNum = (dateObj.getMonth() + 1).toString().padStart(2, '0');
            const formattedDate = `${dayNum}/${monthNum}`;

            headersHtml += `
                <div class="day-header-cell day-col ${day === 'Vendredi' ? 'friday' : ''}">
                    <div class="day-name">${day} <span style="font-weight: normal; opacity: 0.8; font-size: 0.9em;">${formattedDate}</span></div>
                </div>
            `;
        });
        headersHtml += '</div>';
        return headersHtml;
    };

    // Day headers (shown once in normal mode, repeated per machine in print mode)
    if (!State.isPrintMode) {
        html += generateDayHeaders();
    }

    // Rows for each machine
    State.ALL_MACHINES.forEach(machine => {
        const rowsToPrint = State.isPrintMode ? ['print-row-top', 'print-row-bottom'] : [''];

        rowsToPrint.forEach((printClass, rowIndex) => {
            if (State.isPrintMode) {
                html += generateDayHeaders();
            }

            html += `<div class="journee-row ${printClass}">`;

            const machineSuffix = State.isPrintMode ? (rowIndex === 0 ? ' - MATIN' : ' - APR\u00c8S-MIDI') : '';
            html += `<div class="machine-cell"><div class="machine-name">${escapeHtml(machine)}${machineSuffix}</div></div>`;

            // Day cells with hourly time slots
            DAYS_OF_WEEK.forEach(day => {
                const capacityInfo = calculerCapaciteJour(machine, day, State.semaineSelectionnee, State.anneeSelectionnee);
                const capacityClass = capacityInfo.capacityClass;
                const isOverCapacity = capacityInfo.isOvertime;

                const dateObj = getDateFromWeekDay(State.semaineSelectionnee, day, '00:00', State.anneeSelectionnee);
                const dayNum = dateObj.getDate().toString().padStart(2, '0');
                const monthNum = (dateObj.getMonth() + 1).toString().padStart(2, '0');
                const formattedDate = `${dayNum}/${monthNum}`;

                // Timeline hours: dynamic based on multi-shift schedule
                const globalSchedule = getGlobalScheduleRangeForDay(day);
                const startHourTimeline = globalSchedule.globalStart;
                const endHourTimeline = globalSchedule.globalEnd;
                const daySchedule = getScheduleForDay(day);

                html += `
                    <div class="day-cell ${day === 'Vendredi' ? 'friday' : ''} ${getMachineTypeClass(machine)}"
                         data-machine="${escapeHtml(machine)}"
                         data-day="${day}"
                         data-week="${State.semaineSelectionnee}">

                        <!-- Top Stats Header -->
                        <div class="day-stat-header">
                            <div class="stat-row">
                                <span style="font-size: 0.9em; opacity: 0.7;">${day} ${formattedDate}</span>
                                <span>Charge: ${Math.round(capacityInfo.pourcentage)}%</span>
                            </div>
                            <div class="stat-row">
                                <span class="${isOverCapacity ? 'text-danger' : ''}">
                                    ${Math.round(capacityInfo.heuresUtilisees * 10) / 10}h / ${capacityInfo.capaciteJour}h
                                </span>
                                <span>${isOverCapacity ? ' HEURES SUP' : ''}</span>
                            </div>
                            <div class="stat-progress">
                                <div class="stat-progress-bar ${capacityClass}" style="width: ${Math.min(100, Math.round(capacityInfo.pourcentage))}%"></div>
                            </div>
                        </div>

                        <div class="day-timeline">
                `;

                // Get slots for this machine/day
                const placedOrders = getPlacedOrders();
                const slots = [];

                placedOrders.forEach(cmd => {
                    cmd.operations.forEach(op => {
                        op.slots.forEach(slot => {
                            if (slot.machine === machine && slot.jour === day && slot.semaine === State.semaineSelectionnee) {
                                const slotYear = getISOWeekYear(slot.dateDebut);
                                if (slotYear !== State.anneeSelectionnee) return;

                                slots.push({
                                    ...slot,
                                    commandeId: cmd.id,
                                    client: cmd.client,
                                    refCdeClient: cmd.refCdeClient || '',
                                    operationType: op.type,
                                    commandeRef: cmd,
                                    operationRef: op,
                                    overtime: slot.overtime || false
                                });
                            }
                        });
                    });
                });

                slots.sort((a, b) => a.heureDebut.localeCompare(b.heureDebut));

                // Timeline container with absolute positioning
                html += '<div class="timeline-container">';

                // Time grid (background)
                html += '<div class="time-grid">';
                for (let h = startHourTimeline; h < endHourTimeline; h += 0.5) {
                    const hour = Math.floor(h);
                    const minute = (h % 1 === 0.5) ? '30' : '00';
                    const timeSlot = `${hour.toString().padStart(2, '0')}:${minute}`;
                    const isHalf = (h % 1 === 0.5);

                    html += `
                        <div class="time-slot drop-zone ${isHalf ? 'half-hour' : 'full-hour'}"
                             data-machine="${escapeHtml(machine)}"
                             data-day="${day}"
                             data-week="${State.semaineSelectionnee}"
                             data-hour="${h}"
                             data-time="${timeSlot}">
                            <div class="time-label">${timeSlot}</div>
                        </div>
                    `;
                }
                html += '</div>';

                // Operations overlay
                html += '<div class="operations-overlay">';

                // 0. System Events
                getExpandedSystemEvents()
                    .filter(e => {
                        if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== day || e.week !== State.semaineSelectionnee) return false;
                        const eventYear = e.year || getISOWeekYear(e.dateStr);
                        return eventYear === State.anneeSelectionnee;
                    })
                    .forEach(e => {
                        const startDec = timeToDecimalHours(e.startTime);
                        const endDec = timeToDecimalHours(e.endTime);
                        const topPos = Math.round((startDec - startHourTimeline) * 60);
                        const heightPos = Math.round((endDec - startDec) * 60);

                        const bgColor = e.type === 'fermeture' ? '#f8d7da' : '#fff3cd';
                        const textColor = e.type === 'fermeture' ? '#721c24' : '#856404';
                        const label = e.type === 'fermeture' ? 'FERMETURE' : 'MAINTENANCE';

                        html += `
                            <div class="system-event-block"
                                 style="position: absolute; top: ${topPos}px; left: 0; right: 0; height: ${heightPos}px;
                                        background: ${bgColor}; color: ${textColor}; border: 1px solid ${textColor};
                                        z-index: 25; display: flex; flex-direction: column; align-items: center; justify-content: center;
                                        font-weight: bold; font-size: 0.75em; text-align: center; pointer-events: none; opacity: 0.9;">
                                <div>${label}</div>
                                <div style="font-weight: normal; font-size: 0.9em;">${escapeHtml(e.reason || '')}</div>
                            </div>
                        `;
                    });

                // 1. Blocked zones (breaks + inter-shift gaps)
                const blockedZonesForRender = getBlockedZonesForDay(day);
                blockedZonesForRender.forEach(zone => {
                    const topZone = (zone.start - startHourTimeline) * 60;
                    const heightZone = (zone.end - zone.start) * 60;

                    if (zone.type === 'break') {
                        html += `<div class="lunch-break" style="top: ${topZone}px; height: ${heightZone}px;"
                                 title="${escapeHtml(zone.name)} (${decimalToTimeString(zone.start)} - ${decimalToTimeString(zone.end)})"></div>`;
                    } else if (zone.type === 'inter-shift-gap') {
                        html += `<div class="inter-shift-gap" style="top: ${topZone}px; height: ${heightZone}px;"
                                 title="${escapeHtml(zone.name)} (${decimalToTimeString(zone.start)} - ${decimalToTimeString(zone.end)})"></div>`;
                    }
                });

                // 2. Overtime Separator
                if (State.scheduleConfig.shifts && State.scheduleConfig.shifts.length > 0) {
                    globalSchedule.shifts.forEach(shift => {
                        const shiftConfig = State.scheduleConfig.shifts.find(s => s.id === shift.shiftId);
                        if (shiftConfig && shiftConfig.schedules && shiftConfig.schedules[day]) {
                            const normalEnd = timeStringToDecimal(shiftConfig.schedules[day].end);
                            const separatorTop = (normalEnd - startHourTimeline) * 60;
                            html += `<div class="overtime-separator" style="top: ${separatorTop}px;"
                                     title="Fin ${escapeHtml(shift.shiftName)}"></div>`;
                        }
                    });
                } else {
                    // Fallback (old system)
                    const separatorTime = daySchedule.standardEnd;
                    const separatorTop = (separatorTime - startHourTimeline) * 60;
                    html += `<div class="overtime-separator" style="top: ${separatorTop}px;"></div>`;
                }

                // 3. Current Time Line (Red Line)
                const today = new Date();
                const currentWeekNum = getWeekNumber(today);
                const dayMap = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
                const currentDayName = dayMap[today.getDay()];

                if (State.semaineSelectionnee === currentWeekNum && day === currentDayName) {
                    const nowHour = today.getHours();
                    const nowMin = today.getMinutes();
                    const nowDecimal = nowHour + (nowMin / 60);
                    if (nowDecimal >= startHourTimeline && nowDecimal <= (endHourTimeline + 2)) {
                        const topPos = (nowDecimal - startHourTimeline) * 60;
                        html += `<div class="current-time-line" style="top: ${topPos}px;" title="Il est ${nowHour}h${nowMin}"></div>`;
                    }
                }

                // 4. Operation slots
                slots.forEach(slot => {
                    const startHour = parseInt(slot.heureDebut.split(':')[0]);
                    const startMinute = parseInt(slot.heureDebut.split(':')[1]);
                    const startDecimal = startHour + (startMinute / 60);

                    const endHourParts = slot.heureFin.split(':');
                    const endDecimal = parseInt(endHourParts[0]) + parseInt(endHourParts[1]) / 60;

                    const crossedZones = blockedZonesForRender.filter(zone =>
                        startDecimal < zone.end && endDecimal > zone.start
                    );

                    const renderSlotDiv = (sTime, eTime, isSplitPart = false) => {
                        const startOffsetHours = sTime - startHourTimeline;
                        const topPosition = Math.round(startOffsetHours * 60);
                        const heightInPixels = Math.round((eTime - sTime) * 60);

                        const typeClass = slot.operationType.toLowerCase().replace('\u00e7', 'c').replace('\u00e9', 'e');
                        const slotId = `${slot.semaine}_${slot.jour}_${slot.heureDebut}`;
                        const extraClass = slot.overtime ? 'overtime' : '';

                        return `
                            <div class="operation-slot ${typeClass} ${extraClass} draggable"
                                 draggable="true"
                                 data-commande-id="${slot.commandeId}"
                                 data-client="${escapeHtml(slot.client)}"
                                 data-operation-type="${slot.operationType}"
                                 data-slot-id="${slotId}"
                                 data-operation='${JSON.stringify({ commandeId: slot.commandeId, operationType: slot.operationType, slotId: slotId }).replace(/'/g, "&#39;")}'
                                 style="position: absolute; top: ${topPosition}px; left: 5px; right: 5px; height: ${heightInPixels}px; min-height: ${heightInPixels}px; z-index: ${slot.overtime ? 20 : 10};">

                                ${slot.overtime ? '<div class="overtime-indicator"></div>' : ''}

                                <div class="slot-top-row" style="display: flex; justify-content: space-between; align-items: center; width: 100%; font-size: 0.85em;">
                                    <span class="slot-time" style="font-weight: bold;">${slot.heureDebut}-${slot.heureFin}</span>
                                    <span class="slot-client" style="font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 5px; flex: 1; text-align: right;">${escapeHtml(slot.client)}</span>
                                </div>
                                ${slot.refCdeClient ? `<div class="slot-ref" style="font-size: 1.1em; font-weight: 800; color: #fff; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(slot.refCdeClient)}</div>` : ''}
                                <div class="slot-label" style="text-align: center; width: 100%; font-weight: 800; font-size: 1.1em; margin-top: 2px;">${slot.commandeId.substring(5)}</div>
                            </div>
                        `;
                    };

                    if (crossedZones.length > 0) {
                        let currentPos = startDecimal;
                        for (const zone of crossedZones) {
                            if (currentPos < zone.start) {
                                html += renderSlotDiv(currentPos, zone.start, true);
                            }
                            currentPos = zone.end;
                        }
                        if (currentPos < endDecimal) {
                            html += renderSlotDiv(currentPos, endDecimal, true);
                        }
                    } else {
                        html += renderSlotDiv(startDecimal, endDecimal);
                    }
                });

                html += '</div>'; // Close operations-overlay
                html += '</div>'; // Close timeline-container

                html += `
                        </div>
                    </div>
                `;
            }); // Close DAYS_OF_WEEK.forEach

            html += '</div>'; // Close journee-row
        }); // Close rowsToPrint.forEach
    }); // Close ALL_MACHINES.forEach

    html += '</div>';
    container.innerHTML = html;

    // Event listeners
    document.getElementById('btnBackToWeek')?.addEventListener('click', () => {
        // TODO: importer toggleVue depuis ui-list.js (éviter import circulaire)
        window.toggleVue?.('semaine');
    });

    // Search functionality
    const searchInput = document.getElementById('searchOperations');
    const clearSearchBtn = document.getElementById('btnClearSearch');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim().toLowerCase();

            clearSearchBtn.style.display = query ? 'inline-block' : 'none';

            document.querySelectorAll('.operation-slot').forEach(op => {
                op.classList.remove('search-highlight', 'search-dimmed');
            });

            if (query) {
                let foundCount = 0;
                document.querySelectorAll('.operation-slot').forEach(op => {
                    const commandeId = op.getAttribute('data-commande-id') || '';
                    const client = op.getAttribute('data-client') || '';

                    if (commandeId.toLowerCase().includes(query) || client.toLowerCase().includes(query)) {
                        op.classList.add('search-highlight');
                        foundCount++;
                    } else {
                        op.classList.add('search-dimmed');
                    }
                });

                if (foundCount === 0) {
                    Toast.info(`Aucune op\u00e9ration trouv\u00e9e pour "${query}"`);
                }
            }
        });

        clearSearchBtn?.addEventListener('click', () => {
            searchInput.value = '';
            searchInput.dispatchEvent(new Event('input'));
            searchInput.focus();
        });
    }

    initDragAndDrop();
}

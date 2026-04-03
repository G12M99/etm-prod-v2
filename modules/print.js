/**
 * @module print
 * @description Modale de configuration d'impression et impression du planning.
 * @requires state.js, utils.js, ui-list.js, ui-day.js, system-events.js
 */

import { State } from './state.js';
import { getWeekNumber, getWeekDateRange, getDateFromWeekDay, escapeHtml, getUrgencyLevel, DAYS_OF_WEEK } from './utils.js';
import { getExpandedSystemEvents } from './system-events.js';

// ===================================
// Show print config modal
// ===================================

/**
 * Ouvre la modale de configuration d'impression.
 * Peuple le select de semaines (courante -1 à +4).
 */
export function showPrintConfig() {
    const modal = document.getElementById('modalPrintConfig');
    const select = document.getElementById('printWeekSelect');

    select.innerHTML = '';
    const currentW = getWeekNumber(new Date());
    const currentYear = new Date().getFullYear();

    for (let i = -1; i <= 4; i++) {
        let w = currentW + i;
        let year = currentYear;

        if (w > 52) {
            w = w - 52;
            year++;
        } else if (w < 1) {
            w = w + 52;
            year--;
        }

        const range = getWeekDateRange(w, year);
        const option = document.createElement('option');
        option.value = `${w}|${year}`;
        option.text = `Semaine ${w} ${year} (${range.start}-${range.end} ${range.month})`;
        if (w === State.semaineSelectionnee && year === State.anneeSelectionnee) option.selected = true;
        select.appendChild(option);
    }

    modal.classList.add('active');
}

// ===================================
// Handle print
// ===================================

/**
 * Applique la semaine choisie et lance l'impression atelier.
 */
export function handlePrint() {
    const selectedValue = document.getElementById('printWeekSelect').value;
    const [week, year] = selectedValue.split('|').map(v => parseInt(v));

    document.getElementById('modalPrintConfig').classList.remove('active');
    handlePrintAtelier(week, year);
}

// ===================================
// Atelier print: 1 page per machine per day
// ===================================

/**
 * Collect all slots for a given week, grouped by day then machine.
 * Returns Map<dayName, Map<machineName, slot[]>>
 */
function collectSlotsForWeek(week, year) {
    const result = new Map();
    DAYS_OF_WEEK.forEach(day => result.set(day, new Map()));

    for (const cmd of State.commandes) {
        for (const op of (cmd.operations || [])) {
            for (const slot of (op.slots || [])) {
                if (slot.semaine !== week) continue;
                // Check year via dateDebut if available
                if (slot.dateDebut) {
                    const slotYear = new Date(slot.dateDebut).getFullYear();
                    if (slotYear !== year) continue;
                }
                const day = slot.jour;
                if (!result.has(day)) continue;

                const dayMap = result.get(day);
                if (!dayMap.has(slot.machine)) dayMap.set(slot.machine, []);
                dayMap.get(slot.machine).push({
                    heureDebut: slot.heureDebut,
                    heureFin: slot.heureFin,
                    duree: slot.duree,
                    commandeId: cmd.id,
                    client: cmd.client || '',
                    dateLivraison: cmd.dateLivraison,
                    operationType: op.type,
                    overtime: slot.overtime || false
                });
            }
        }
    }

    return result;
}

/**
 * Get system events (maintenance/fermeture) for a specific day and machine.
 */
function getSystemEventsForDayMachine(week, year, dayName, machine) {
    const events = getExpandedSystemEvents();
    return events.filter(ev => {
        if (ev.week !== week || ev.year !== year || ev.day !== dayName) return false;
        if (ev.machines && ev.machines.length > 0 && !ev.machines.includes(machine)) return false;
        return true;
    });
}

/**
 * Get the full date for a given week/day as a Date object.
 */
function getDayDate(week, year, dayName) {
    return getDateFromWeekDay(week, dayName, '00:00', year);
}

/**
 * Format a Date to "Lundi 7 avril 2025".
 */
function formatFullDate(date) {
    return date.toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

/**
 * Parse "HH:MM" to minutes since midnight.
 */
function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

/**
 * Format minutes duration to "Xh YYmin".
 */
function formatDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}min`;
    if (m === 0) return `${h}h`;
    return `${h}h${m.toString().padStart(2, '0')}`;
}

/**
 * Build the print HTML for atelier format and trigger window.print().
 */
function handlePrintAtelier(week, year) {
    const slotsByDay = collectSlotsForWeek(week, year);
    const pages = [];
    let pageIndex = 0;

    // Iterate days, then machines (all machines of day J, then day J+1...)
    for (const day of DAYS_OF_WEEK) {
        const dayMap = slotsByDay.get(day);
        const dayDate = getDayDate(week, year, day);
        const fullDate = formatFullDate(dayDate);

        // Sort machines in the order of ALL_MACHINES
        const machinesWithSlots = State.ALL_MACHINES.filter(m => dayMap.has(m) && dayMap.get(m).length > 0);

        for (const machine of machinesWithSlots) {
            pageIndex++;
            const slots = dayMap.get(machine);

            // Sort by start time
            slots.sort((a, b) => timeToMinutes(a.heureDebut) - timeToMinutes(b.heureDebut));

            // Lunch break for gap calculation
            const lunchStart = State.LUNCH_BREAK ? timeToMinutes(State.LUNCH_BREAK.start) : null;
            const lunchEnd = State.LUNCH_BREAK ? timeToMinutes(State.LUNCH_BREAK.end) : null;

            // Get system events for this machine/day
            const sysEvents = getSystemEventsForDayMachine(week, year, day, machine);

            // Build rows: operations + gaps >= 15min
            const rows = [];
            let totalWorkedMinutes = 0;

            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                const startMin = timeToMinutes(slot.heureDebut);
                const endMin = timeToMinutes(slot.heureFin);
                const durationMin = endMin - startMin;

                // Check gap before this slot
                if (i > 0) {
                    const prevEnd = timeToMinutes(slots[i - 1].heureFin);
                    let gapMin = startMin - prevEnd;

                    // Subtract lunch break from gap if it falls within
                    if (lunchStart !== null && lunchEnd !== null) {
                        const overlapStart = Math.max(prevEnd, lunchStart);
                        const overlapEnd = Math.min(startMin, lunchEnd);
                        if (overlapEnd > overlapStart) {
                            gapMin -= (overlapEnd - overlapStart);
                        }
                    }

                    if (gapMin >= 15) {
                        rows.push({ type: 'gap', duration: gapMin });
                    }
                }

                const isUrgent = slot.dateLivraison && getUrgencyLevel(slot.dateLivraison) === 'urgente';

                rows.push({
                    type: 'operation',
                    heureDebut: slot.heureDebut,
                    heureFin: slot.heureFin,
                    duration: durationMin,
                    commandeId: slot.commandeId,
                    client: slot.client,
                    isUrgent,
                    overtime: slot.overtime
                });

                totalWorkedMinutes += durationMin;
            }

            // System events rows
            const sysRows = sysEvents.map(ev => ({
                type: 'system',
                label: ev.type === 'fermeture' ? 'FERMETURE' : 'MAINTENANCE',
                startTime: ev.startTime,
                endTime: ev.endTime,
                reason: ev.reason || ''
            }));

            const totalWorkedStr = formatDuration(totalWorkedMinutes);

            // Generate page HTML
            let html = `
            <div class="print-page">
                <div class="print-page-header">
                    <div class="print-machine-name">${escapeHtml(machine)}</div>
                    <div class="print-date-info">
                        <span class="print-full-date">${escapeHtml(fullDate)}</span>
                        <span class="print-week-num">Semaine ${week}</span>
                    </div>
                </div>`;

            // System events banner if any
            if (sysRows.length > 0) {
                html += `<div class="print-sys-events">`;
                for (const sev of sysRows) {
                    html += `<div class="print-sys-event">⚠ ${escapeHtml(sev.label)} : ${escapeHtml(sev.startTime)} - ${escapeHtml(sev.endTime)}${sev.reason ? ' — ' + escapeHtml(sev.reason) : ''}</div>`;
                }
                html += `</div>`;
            }

            // Table
            html += `
                <table class="print-table">
                    <thead>
                        <tr>
                            <th style="width:15%">Début</th>
                            <th style="width:15%">Fin</th>
                            <th style="width:12%">Durée</th>
                            <th style="width:28%">N° Commande</th>
                            <th style="width:30%">Client</th>
                        </tr>
                    </thead>
                    <tbody>`;

            for (const row of rows) {
                if (row.type === 'gap') {
                    html += `
                        <tr class="print-row-gap">
                            <td colspan="5">── Disponible ${formatDuration(row.duration)} ──</td>
                        </tr>`;
                } else {
                    const urgentClass = row.isUrgent ? ' print-row-urgent' : '';
                    const urgentBadge = row.isUrgent ? '⚡ URGENT — ' : '';
                    html += `
                        <tr class="print-row-op${urgentClass}">
                            <td>${escapeHtml(row.heureDebut)}</td>
                            <td>${escapeHtml(row.heureFin)}</td>
                            <td>${formatDuration(row.duration)}</td>
                            <td>${urgentBadge}${escapeHtml(row.commandeId)}</td>
                            <td>${escapeHtml(row.client)}</td>
                        </tr>`;
                }
            }

            if (rows.length === 0) {
                html += `<tr><td colspan="5" style="text-align:center; font-style:italic; padding:20px;">Aucune opération planifiée</td></tr>`;
            }

            html += `
                    </tbody>
                </table>
                <div class="print-page-footer">
                    <span class="print-total">Total travaillé : ${totalWorkedStr}</span>
                    <span class="print-page-num">Page ${pageIndex}</span>
                </div>
            </div>`;

            pages.push(html);
        }
    }

    if (pages.length === 0) {
        alert('Aucune opération planifiée pour cette semaine.');
        return;
    }

    // Update total page count
    const totalPages = pages.length;
    const fullHtml = pages.map((p, i) =>
        p.replace(`Page ${i + 1}</span>`, `Page ${i + 1} / ${totalPages}</span>`)
    ).join('');

    // Inject into print container
    let container = document.getElementById('printAtelierContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'printAtelierContainer';
        document.body.appendChild(container);
    }
    container.innerHTML = fullHtml;
    document.body.classList.add('print-atelier-mode');

    // Inject portrait @page override
    const pageStyle = document.createElement('style');
    pageStyle.id = 'printAtelierPageStyle';
    pageStyle.textContent = '@page { size: A4 portrait; margin: 15mm; }';
    document.head.appendChild(pageStyle);

    // Print
    setTimeout(() => {
        window.print();
        // Cleanup after print
        setTimeout(() => {
            document.body.classList.remove('print-atelier-mode');
            container.innerHTML = '';
            pageStyle.remove();
        }, 200);
    }, 300);
}

// ===================================
// Init handlers
// ===================================

/**
 * Initialise les event listeners pour l'impression.
 */
export function initPrintHandlers() {
    document.getElementById('btnPrintPlanning')?.addEventListener('click', showPrintConfig);

    document.getElementById('btnCancelPrint')?.addEventListener('click', () => {
        document.getElementById('modalPrintConfig').classList.remove('active');
    });

    document.getElementById('btnConfirmPrint')?.addEventListener('click', handlePrint);
}

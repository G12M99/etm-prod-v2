/**
 * @module ui-week
 * @description Rendu DOM de la Vue Semaine (grille 3 semaines x machines).
 * @requires state.js, utils.js, scheduling.js
 */

import { State, getMachineTypeClass } from './state.js';
import {
    formatDate, formatHours, escapeHtml, getWeekDateRange,
    getDateFromWeekDay, getWeekNumber, getISOWeekYear,
    decimalToTimeString, timeToDecimalHours, getUrgencyLevel, DAYS_OF_WEEK
} from './utils.js';
import {
    getPlacedOrders, getCommandesAffecteesNonPlacees,
    calculerCapaciteMachine, calculerCapaciteSemaineGlobale,
    getCapacityColorClass, getExpandedSystemEvents
} from './scheduling.js';
import { handleWeekCellDrop, handleDesaffectationDragStart, handleDesaffectationDragEnd } from './drag-drop.js';

/**
 * Render the 3-week overview grid.
 * Writes into #planningContainer.
 */
export function renderVueSemaine() {
    const container = document.getElementById('planningContainer');

    // Calculate the 3 weeks to display
    const weeksToDisplay = [];
    let tempWeek = State.semaineSelectionnee;
    let tempYear = State.anneeSelectionnee;

    for (let i = 0; i < 3; i++) {
        weeksToDisplay.push({ week: tempWeek, year: tempYear });
        tempWeek++;
        if (tempWeek > 52) {
            tempWeek = 1;
            tempYear++;
        }
    }

    let html = '<div class="vue-semaine">';

    // Navigation Header
    html += `
        <div class="semaine-nav-header" style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:#f8f9fa; border-bottom:1px solid #dee2e6; margin-bottom:10px;">
            <div>
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(-1)">&#10094; Pr\u00e9c\u00e9dent</button>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-weight:bold; font-size:1.1em;">Planning ${State.anneeSelectionnee}</span>
                <input type="date" class="form-control" style="width:auto; padding:2px 5px;"
                       onchange="goToWeekFromDate(this.value)"
                       title="Aller \u00e0 une date sp\u00e9cifique">
            </div>
            <div>
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(1)">Suivant &#10095;</button>
            </div>
        </div>
    `;

    // Grid Header
    html += '<div class="semaine-header">';
    html += '<div class="semaine-header-cell machine-col">Machine</div>';

    weeksToDisplay.forEach((item, index) => {
        const weekRange = getWeekDateRange(item.week, item.year);
        const weekSeparatorClass = index > 0 ? 'week-separator' : '';
        const isCurrent = (item.week === getWeekNumber(new Date()) && item.year === new Date().getFullYear());
        const activeClass = isCurrent ? 'text-primary' : '';

        html += `<div class="semaine-header-cell week-col ${weekSeparatorClass} ${activeClass}">
                    S${item.week} <small>${item.year}</small><br>
                    <span style="font-size:0.8em; font-weight:normal;">${weekRange.start}-${weekRange.end} ${weekRange.month}</span>
                 </div>`;
    });
    html += '</div>';

    // === ROW "A placer" : assigned but unplaced commands ===
    html += '<div class="semaine-row semaine-row-aplacer">';
    html += '<div class="machine-cell"><div class="machine-name">\ud83d\udccb \u00c0 placer</div></div>';

    weeksToDisplay.forEach((item, index) => {
        const weekSeparatorClass = index > 0 ? 'week-separator' : '';
        const commandesAffectees = getCommandesAffecteesNonPlacees(item.week, item.year);

        const capaciteGlobale = calculerCapaciteSemaineGlobale(item.week, item.year);
        const capacityClass = getCapacityColorClass(capaciteGlobale.pourcentage);

        html += `<div class="week-cell week-cell-aplacer drop-zone-semaine ${weekSeparatorClass}" data-week="${item.week}" data-year="${item.year}">`;

        // Global capacity gauge
        html += `
            <div class="week-capacity-global">
                <div class="capacity-bar-global">
                    <div class="capacity-fill ${capacityClass}" style="width: ${Math.min(100, capaciteGlobale.pourcentage)}%"></div>
                </div>
                <span class="capacity-label-global" title="Plac\u00e9es: ${formatHours(capaciteGlobale.heuresPlacees)} | \u00c0 placer: ${formatHours(capaciteGlobale.heuresNonPlacees)} | Capacit\u00e9: ${formatHours(capaciteGlobale.capaciteTotale)}">
                    ${formatHours(capaciteGlobale.heuresAffectees)} / ${formatHours(capaciteGlobale.capaciteTotale)} (${capaciteGlobale.pourcentage}%)
                </span>
            </div>
        `;

        // Badges for assigned commands
        html += '<div class="aplacer-badges">';
        if (commandesAffectees.length === 0) {
            html += '<span class="no-commands-hint">Aucune commande</span>';
        } else {
            commandesAffectees.forEach(cmd => {
                const urgencyLevel = getUrgencyLevel(cmd.dateLivraison);
                const opsRestantes = cmd.operations.filter(o => !o.slots || o.slots.length === 0).length;
                const desaffectData = JSON.stringify({ commandeId: cmd.id, isDesaffectation: true });
                html += `
                    <span class="command-badge command-badge-aplacer ${urgencyLevel}"
                          draggable="true"
                          data-commande-desaffectation='${desaffectData}'
                          title="${escapeHtml(cmd.client)} - Livraison: ${formatDate(cmd.dateLivraison)} (Glisser vers sidebar pour d\u00e9saffecter)">
                        <span class="badge-id">${cmd.id.substring(5)}</span>
                        <span class="badge-ops">${opsRestantes} ops</span>
                    </span>
                `;
            });
        }
        html += '</div>';
        html += '</div>';
    });

    html += '</div>';

    // Rows for each machine
    State.ALL_MACHINES.forEach(machine => {
        html += '<div class="semaine-row">';

        html += `
            <div class="machine-cell">
                <div class="machine-name">${escapeHtml(machine)}</div>
            </div>
        `;

        weeksToDisplay.forEach((item, index) => {
            const placedOrders = getPlacedOrders();
            const commandsInWeek = placedOrders.filter(cmd =>
                cmd.operations.some(op =>
                    op.slots.some(slot => {
                        if (slot.machine !== machine || slot.semaine !== item.week) return false;
                        const slotYear = getISOWeekYear(slot.dateDebut);
                        return slotYear === item.year;
                    })
                )
            );

            const weekSeparatorClass = index > 0 ? 'week-separator' : '';
            const capacity = calculerCapaciteMachine(machine, item.week, item.year);
            const weekCapacityClass = getCapacityColorClass(capacity.pourcentage);

            html += `<div class="week-cell drop-zone-semaine ${weekSeparatorClass}" data-machine="${escapeHtml(machine)}" data-week="${item.week}" data-year="${item.year}">`;

            // Capacity gauge
            html += `
                <div class="week-capacity-gauge">
                    <div class="capacity-bar-mini">
                        <div class="capacity-fill ${weekCapacityClass}" style="width: ${Math.min(100, capacity.pourcentage)}%"></div>
                    </div>
                    <span class="capacity-label-mini">${formatHours(capacity.heuresUtilisees)} (${capacity.pourcentage}%)</span>
                </div>
            `;

            commandsInWeek.forEach(cmd => {
                html += `
                    <span class="command-badge">
                        <span class="badge-id">${cmd.id.substring(5)}</span>
                        <span class="badge-client">${escapeHtml(cmd.client)}</span>
                    </span>
                `;
            });

            // System Events
            const expandedEvents = getExpandedSystemEvents();
            const weekEvents = expandedEvents.filter(e => {
                if ((e.machine !== machine && e.machine !== 'ALL') || e.week !== item.week) return false;
                const eventYear = e.year || getISOWeekYear(e.dateStr);
                return eventYear === item.year;
            });

            weekEvents.forEach(e => {
                const label = e.type === 'fermeture' ? 'FERM\u00c9' : 'MAINT';
                const style = e.type === 'fermeture'
                    ? 'background:#f8d7da; color:#721c24; border:1px solid #f5c6cb;'
                    : 'background:#fff3cd; color:#856404; border:1px solid #ffeeba;';

                html += `
                    <span class="command-badge system-event-badge" style="${style} display:block; margin-top:2px; font-weight:bold;">
                        <span class="badge-id" style="width:100%; text-align:center;">${label}</span>
                        <span class="badge-client" style="width:100%; text-align:center;">${e.day.substring(0, 3)} ${e.startTime}-${e.endTime}</span>
                    </span>
                `;
            });

            html += '</div>';
        });

        html += '</div>';
    });

    html += '</div>';
    container.innerHTML = html;

    // Click handlers on week cells → switch to day view
    document.querySelectorAll('.week-cell').forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (e.target.closest('.dragging')) return;

            const week = parseInt(e.currentTarget.getAttribute('data-week'));
            const year = parseInt(e.currentTarget.getAttribute('data-year'));

            State.semaineSelectionnee = week;
            State.anneeSelectionnee = year;

            // TODO: importer toggleVue depuis ui-list.js (éviter import circulaire)
            window.toggleVue?.('journee');
        });
    });

    // Drag & drop handlers for week affectation
    document.querySelectorAll('.drop-zone-semaine').forEach(cell => {
        cell.addEventListener('dragover', (e) => {
            if (State.draggedOperation && State.draggedOperation.isCommandeAffectation) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                e.currentTarget.classList.add('drag-over');
            }
        });
        cell.addEventListener('dragleave', (e) => {
            e.currentTarget.classList.remove('drag-over');
        });
        cell.addEventListener('drop', handleWeekCellDrop);
    });

    // Dragstart/dragend for "À placer" badges
    document.querySelectorAll('.command-badge-aplacer[draggable="true"]').forEach(badge => {
        badge.addEventListener('dragstart', handleDesaffectationDragStart);
        badge.addEventListener('dragend', handleDesaffectationDragEnd);
    });
}

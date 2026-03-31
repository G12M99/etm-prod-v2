/**
 * @module print
 * @description Modale de configuration d'impression et impression du planning.
 * @requires state.js, utils.js, ui-list.js, ui-day.js
 */

import { State } from './state.js';
import { getWeekNumber, getWeekDateRange } from './utils.js';
import { toggleVue } from './ui-list.js';
import { renderVueJournee } from './ui-day.js';

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
 * Applique la semaine choisie, passe en mode impression, appelle window.print().
 */
export function handlePrint() {
    const selectedValue = document.getElementById('printWeekSelect').value;
    const [week, year] = selectedValue.split('|').map(v => parseInt(v));
    const format = document.querySelector('input[name="printFormat"]:checked').value;

    // 1. Switch View with correct week and year
    State.semaineSelectionnee = week;
    State.anneeSelectionnee = year;

    // 2. Enable print mode for dual-row rendering (only for journee view)
    if (format === 'journee') {
        State.isPrintMode = true;
    }

    toggleVue(format); // 'semaine' or 'journee'

    // 3. Wait for render then Print
    setTimeout(() => {
        document.getElementById('modalPrintConfig').classList.remove('active');
        window.print();

        // 4. Disable print mode and re-render after printing
        setTimeout(() => {
            State.isPrintMode = false;
            if (format === 'journee') {
                renderVueJournee();
            }
        }, 100);
    }, 500);
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

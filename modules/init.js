/**
 * @module init
 * @description Bootstrap de l'application : initialisation dans
 *              l'ordre, appel des init() de chaque module.
 * @requires state.js, db.js, ui-list.js
 */

import { State, historyManager } from './state.js';
import { initSupabase, loadCommandes, loadMachines, loadSchedule, loadSystemEvents, saveAllDirtyCommandesDebounced } from './db.js';
import { toggleVue, updateCurrentTime, refresh, changeWeek } from './ui-list.js';
import { initializeSidebarSearch } from './ui-sidebar.js';
import './auto-place.js'; // Registers window.placerAutomatiquement etc.
import { initUrgentHandlers } from './urgent.js';
import { initSystemEventsHandlers } from './system-events.js';
import { initMachineManagerHandlers } from './machines.js';
import { initScheduleManagerHandlers, reloadScheduleArrays } from './schedule.js';
import { initPlanifierSemiAutoHandlers } from './semi-auto.js';
import { initRealtime, initSyncHandlers } from './realtime.js';
import { initPrintHandlers } from './print.js';
import './conflicts.js'; // Registers window.closeConflictModal, window.resolveConflict

// ===================================
// Event Handlers (view buttons, modal close, keyboard shortcuts)
// ===================================

function initEventHandlers() {
    // View toggle buttons
    document.getElementById('btnVueSemaine')?.addEventListener('click', () => toggleVue('semaine'));
    document.getElementById('btnVueJournee')?.addEventListener('click', () => toggleVue('journee'));
    document.getElementById('btnVueListe')?.addEventListener('click', () => toggleVue('liste'));

    // Week navigation
    document.getElementById('btnPrevWeek')?.addEventListener('click', () => changeWeek(-1));
    document.getElementById('btnNextWeek')?.addEventListener('click', () => changeWeek(1));

    // Modal close buttons (generic)
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.getAttribute('data-close-modal');
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.remove('active');
        });
    });

    // Close modal Order Details
    document.getElementById('closeModalOrderDetails')?.addEventListener('click', () => {
        document.getElementById('modalOrderDetails')?.classList.remove('active');
    });

    // Keyboard shortcuts: Ctrl+Z undo, Ctrl+Y redo
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            historyManager.undo();
        } else if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            historyManager.redo();
        }
    });
}

// ===================================
// Main init
// ===================================

async function init() {
    try {
        console.log('[init] Starting ETM PROD V3...');

        // 1. Init Supabase client
        initSupabase();

        // 2. Load config (machines, schedule, system events) in parallel
        await Promise.all([loadMachines(), loadSchedule(), loadSystemEvents()]);

        // 2b. Rebuild schedule arrays from loaded config
        reloadScheduleArrays();

        // 3. Load commandes (depends on machines being loaded)
        await loadCommandes();

        // 4. Wire HistoryManager restore callback (avoids circular imports)
        historyManager.setRestoreCallback(() => {
            refresh();
            saveAllDirtyCommandesDebounced();
        });

        // 5. Render initial view
        toggleVue('semaine');

        // 6. Initialize all handlers
        initEventHandlers();
        initializeSidebarSearch();
        initUrgentHandlers();
        initSystemEventsHandlers();
        initMachineManagerHandlers();
        initScheduleManagerHandlers();
        initPlanifierSemiAutoHandlers();
        initRealtime();
        initSyncHandlers();
        initPrintHandlers();

        // 7. Start clock
        updateCurrentTime();
        setInterval(updateCurrentTime, 60000);

        console.log('[init] ETM PROD V3 ready.');
    } catch (err) {
        console.error('[init] Initialization error:', err);
    }
}

init();

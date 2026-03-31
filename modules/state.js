/**
 * @module state
 * @description État global centralisé de l'application ETM PROD V3.
 * @requires config.js (MACHINES_CONFIG, SCHEDULE_DEFAULT_CONFIG exposés en global)
 * @requires utils.js (Toast)
 */

import { Toast } from './utils.js';

// --- Helpers d'initialisation (semaine ISO courante) ---

function getInitialWeek() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getInitialYear() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    return d.getFullYear();
}

// --- État global ---

export const State = {

    // ===== Navigation / Vue =====
    vueActive: 'semaine',
    semaineSelectionnee: getInitialWeek(),
    anneeSelectionnee: getInitialYear(),

    // ===== Données métier =====
    commandes: [],
    systemEvents: [],

    // ===== Configuration machines =====
    machinesConfig: JSON.parse(JSON.stringify(window.MACHINES_CONFIG || {})),
    MACHINES: { cisailles: [], poinconneuses: [], plieuses: [] },
    ALL_MACHINES: [],

    // ===== Configuration horaires =====
    scheduleConfig: JSON.parse(JSON.stringify(window.SCHEDULE_DEFAULT_CONFIG || {})),
    HOURS_PER_DAY: {
        'Lundi': 8.5,
        'Mardi': 8.5,
        'Mercredi': 8.5,
        'Jeudi': 8.5,
        'Vendredi': 5
    },
    TOTAL_HOURS_PER_WEEK: 39,
    LUNCH_BREAK: { start: '12:30', end: '13:00', duration: 0.5 },

    // ===== UI / Drag & drop =====
    draggedOperation: null,
    currentSearchQuery: '',
    isPrintMode: false,
    hideCompletedStatuses: true,

    // ===== Supabase / Realtime =====
    supabaseClient: null,
    CLIENT_SESSION_ID: sessionStorage.getItem('etm_client_id') || (() => {
        const id = 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('etm_client_id', id);
        return id;
    })(),
    REALTIME_IGNORE_WINDOW_MS: 5000,
    _recentlyModifiedRecords: new Map(),

    // ===== Dirty tracking =====
    _dirtyCommandeIds: new Set(),

    // ===== Constantes métier =====
    DAYS_OF_WEEK: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'],

    DUREE_PAR_KG: {
        'Cisaillage': 0.02,
        'Poinçonnage': 0.015,
        'Pliage': 0.025
    },

    CAPACITY_CONFIG: {
        normal: {
            weeklyHours: 39,
            dailyHours: {
                'Lundi': 8.5,
                'Mardi': 8.5,
                'Mercredi': 8.5,
                'Jeudi': 8.5,
                'Vendredi': 5
            },
            threshold: {
                ok: 75,
                warning: 95,
                danger: 100
            }
        },
        overbooking: {
            enabled: true,
            maxPercentage: 105,
            requiresApproval: true,
            visualIndicator: 'critical',
            conditions: {
                minDaysAdvance: 0,
                maxConsecutiveDays: 2,
                weekendWork: false
            }
        },
        overtime: {
            availableSlots: [
                { days: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi'], range: '16:30-18:00', maxHours: 1.5 },
                { days: ['Vendredi'], range: '12:00-14:00', maxHours: 2 }
            ],
            maxWeeklyHours: 10,
            maxDailyHours: 2
        }
    },

    FREEZE_CONFIG: {
        currentDay: true,
        nextDay: 'partial',
        freezeHorizon: 24,
        overridePassword: false,
        overrideWarning: "⚠️ ATTENTION : Modification de la journée en cours.\nCela peut perturber la production actuelle.\n\nContinuer quand même ?"
    },

    RESCHEDULE_WINDOW: {
        maxDays: 3,
        maxMachines: 'same-type',
        respectChronology: true
    },

    // ===== Overtime tracking =====
    overtimeTracker: {
        currentWeek: 0,
        totalHoursUsed: 0,
        byMachine: {},
        byDay: {},
        history: [],
        limits: { weeklyMax: 10, dailyMax: 2 }
    }
};

// --- Fonctions utilitaires liées à State ---

/**
 * Recharge les tableaux MACHINES et ALL_MACHINES depuis machinesConfig
 */
export function reloadMachineArrays() {
    State.MACHINES.cisailles = (State.machinesConfig.cisaillage || []).filter(m => m.active).map(m => m.name);
    State.MACHINES.poinconneuses = (State.machinesConfig.poinconnage || []).filter(m => m.active).map(m => m.name);
    State.MACHINES.plieuses = (State.machinesConfig.pliage || []).filter(m => m.active).map(m => m.name);
    State.ALL_MACHINES = [...State.MACHINES.cisailles, ...State.MACHINES.poinconneuses, ...State.MACHINES.plieuses];
}

/**
 * Détermine le type de machine basé sur son nom
 * @param {string} machineName
 * @returns {string|null} 'cisaillage', 'poinconnage', 'pliage', ou null
 */
export function getMachineType(machineName) {
    if (State.MACHINES.cisailles.includes(machineName)) return 'cisaillage';
    if (State.MACHINES.poinconneuses.includes(machineName)) return 'poinconnage';
    if (State.MACHINES.plieuses.includes(machineName)) return 'pliage';
    return null;
}

/**
 * Retourne la classe CSS appropriée pour une machine
 * @param {string} machineName
 * @returns {string}
 */
export function getMachineTypeClass(machineName) {
    const type = getMachineType(machineName);
    return type ? `machine-type-${type}` : '';
}

/**
 * Marque une commande comme modifiée (dirty) pour la prochaine sync Supabase.
 * @param {string} commandeId
 */
export function markCommandeDirty(commandeId) {
    if (commandeId) State._dirtyCommandeIds.add(commandeId);
}

/**
 * Marque toutes les commandes comme dirty.
 */
export function markAllCommandesDirty() {
    State.commandes.forEach(c => { if (c.id) State._dirtyCommandeIds.add(c.id); });
}

/**
 * Marque un enregistrement comme récemment modifié localement
 * (pour ignorer notre propre événement Realtime).
 * @param {string} recordId
 */
export function markRecordAsModified(recordId) {
    State._recentlyModifiedRecords.set(recordId, Date.now());
    setTimeout(() => State._recentlyModifiedRecords.delete(recordId), State.REALTIME_IGNORE_WINDOW_MS + 1000);
}

/**
 * Vérifie si un événement Realtime provient de notre propre session.
 * @param {string} recordId
 * @returns {boolean}
 */
export function isOurOwnRealtimeEvent(recordId) {
    const modifiedAt = State._recentlyModifiedRecords.get(recordId);
    if (!modifiedAt) return false;
    return (Date.now() - modifiedAt) < State.REALTIME_IGNORE_WINDOW_MS;
}

// Initialiser les tableaux machines au chargement du module
reloadMachineArrays();

// ===================================
// HistoryManager (Undo/Redo)
// ===================================

class HistoryManager {
    constructor() {
        this.history = [];
        this.currentIndex = -1;
        this.maxHistory = 50;
        this.isNavigating = false;
        this._onRestore = null; // Set by init.js to avoid circular imports
    }

    /**
     * Register a callback to execute after state restoration (refresh + save).
     * @param {Function} fn
     */
    setRestoreCallback(fn) {
        this._onRestore = fn;
    }

    saveState(actionName) {
        if (this.isNavigating) return;

        const state = JSON.parse(JSON.stringify(State.commandes));

        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push({ state: state, action: actionName, timestamp: new Date() });

        if (this.history.length > this.maxHistory) {
            this.history.shift();
        } else {
            this.currentIndex++;
        }

        console.log(`State Saved: ${actionName} (Index: ${this.currentIndex})`);
        this.updateUI();
    }

    checkStorageHealth() {
        const used = new Blob(Object.values(localStorage)).size;
        const max = 5 * 1024 * 1024;
        const percentUsed = (used / max * 100).toFixed(1);

        console.log(`Stockage: ${percentUsed}% (${(used/1024).toFixed(1)} KB / 5 MB)`);

        if (percentUsed > 80) {
            Toast.warning(`Espace de stockage critique : ${percentUsed}%`);
        }

        return { used, max, percentUsed };
    }

    undo() {
        if (this.currentIndex > 0) {
            this.isNavigating = true;
            this.currentIndex--;
            this.restoreState(this.history[this.currentIndex]);
            this.isNavigating = false;
            Toast.info(`Annuler : ${this.history[this.currentIndex + 1].action}`);
        } else {
            console.log('End of undo history');
        }
    }

    redo() {
        if (this.currentIndex < this.history.length - 1) {
            this.isNavigating = true;
            this.currentIndex++;
            this.restoreState(this.history[this.currentIndex]);
            this.isNavigating = false;
            Toast.info(`Rétablir : ${this.history[this.currentIndex].action}`);
        } else {
            console.log('End of redo history');
        }
    }

    restoreState(snapshot) {
        State.commandes = JSON.parse(JSON.stringify(snapshot.state));
        markAllCommandesDirty();
        if (this._onRestore) this._onRestore();
    }

    updateUI() {
        // Could enable/disable undo/redo buttons if we had them
    }
}

export const historyManager = new HistoryManager();

// Expose globally for HTML onclick handlers
window.historyManager = historyManager;

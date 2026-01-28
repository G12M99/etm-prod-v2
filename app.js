// ===================================
// ETM PROD V2 - Application Logic
// ===================================

// Configuration des machines - Clone mutable de la configuration
const MACHINES_STORAGE_KEY = 'etm_machines_config';
let machinesConfig = JSON.parse(JSON.stringify(MACHINES_CONFIG));

// Configuration des horaires - Clone mutable de la configuration
const SCHEDULE_STORAGE_KEY = 'etm_schedule_config';
let scheduleConfig = JSON.parse(JSON.stringify(SCHEDULE_DEFAULT_CONFIG));

// ===================================
// Configuration Supabase
// ===================================
const SUPABASE_URL = 'https://veyqcnoaiqotikpjfgjq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wa6y4sYvbvKtzSFBzw7lBg_CYdxXr1P';
let supabaseClient = null;

// Client ID unique par session (pour éviter les boucles Realtime)
const CLIENT_SESSION_ID = sessionStorage.getItem('etm_client_id') || (() => {
    const id = 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('etm_client_id', id);
    return id;
})();

// Tracking des modifications récentes (pour ignorer nos propres events Realtime)
const _recentlyModifiedRecords = new Map(); // recordId -> timestamp
const REALTIME_IGNORE_WINDOW_MS = 5000; // Ignorer les events dans les 5s suivant notre modif

function markRecordAsModified(recordId) {
    _recentlyModifiedRecords.set(recordId, Date.now());
    // Nettoyage automatique après le délai
    setTimeout(() => _recentlyModifiedRecords.delete(recordId), REALTIME_IGNORE_WINDOW_MS + 1000);
}

function isOurOwnRealtimeEvent(recordId) {
    const modifiedAt = _recentlyModifiedRecords.get(recordId);
    if (!modifiedAt) return false;
    return (Date.now() - modifiedAt) < REALTIME_IGNORE_WINDOW_MS;
}

// Initialiser Supabase (appelé au démarrage)
function initSupabase() {
    try {
        if (window.supabase) {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            console.log('✅ Supabase client initialisé');
            return true;
        } else {
            console.warn('⚠️ Supabase SDK non chargé, mode localStorage uniquement');
            return false;
        }
    } catch (e) {
        console.error('❌ Erreur initialisation Supabase:', e);
        return false;
    }
}

// Variables de compatibilité avec le code existant
let MACHINES = {
    cisailles: machinesConfig.cisaillage.filter(m => m.active).map(m => m.name),
    poinconneuses: machinesConfig.poinconnage.filter(m => m.active).map(m => m.name),
    plieuses: machinesConfig.pliage.filter(m => m.active).map(m => m.name)
};

let ALL_MACHINES = [...MACHINES.cisailles, ...MACHINES.poinconneuses, ...MACHINES.plieuses];

/**
 * Recharge les tableaux MACHINES et ALL_MACHINES depuis machinesConfig
 */
function reloadMachineArrays() {
    MACHINES.cisailles = machinesConfig.cisaillage.filter(m => m.active).map(m => m.name);
    MACHINES.poinconneuses = machinesConfig.poinconnage.filter(m => m.active).map(m => m.name);
    MACHINES.plieuses = machinesConfig.pliage.filter(m => m.active).map(m => m.name);
    ALL_MACHINES = [...MACHINES.cisailles, ...MACHINES.poinconneuses, ...MACHINES.plieuses];
}

/**
 * Détermine le type de machine basé sur son nom
 * @param {string} machineName - Le nom de la machine
 * @returns {string|null} 'cisaillage', 'poinconnage', 'pliage', ou null
 */
function getMachineType(machineName) {
    if (MACHINES.cisailles.includes(machineName)) {
        return 'cisaillage';
    }
    if (MACHINES.poinconneuses.includes(machineName)) {
        return 'poinconnage';
    }
    if (MACHINES.plieuses.includes(machineName)) {
        return 'pliage';
    }
    return null;
}

/**
 * Retourne la classe CSS appropriée pour une machine
 * @param {string} machineName - Le nom de la machine
 * @returns {string} La classe CSS (ex: 'machine-type-cisaillage')
 */
function getMachineTypeClass(machineName) {
    const type = getMachineType(machineName);
    return type ? `machine-type-${type}` : '';
}

// Variables d'horaires dynamiques (calculees depuis scheduleConfig)
let HOURS_PER_DAY = {
    'Lundi': 8.5,
    'Mardi': 8.5,
    'Mercredi': 8.5,
    'Jeudi': 8.5,
    'Vendredi': 5
};

const DAYS_OF_WEEK = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
let TOTAL_HOURS_PER_WEEK = 39;

// --- NEW CONFIGURATION V2.1 (Urgent/Overbooking) ---

const CAPACITY_CONFIG = {
    normal: {
        weeklyHours: 39,
        dailyHours: HOURS_PER_DAY,
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
};

const FREEZE_CONFIG = {
    currentDay: true,
    nextDay: 'partial',
    freezeHorizon: 24,
    overridePassword: false,
    overrideWarning: "⚠️ ATTENTION : Modification de la journée en cours.\nCela peut perturber la production actuelle.\n\nContinuer quand même ?"
};

const RESCHEDULE_WINDOW = {
    maxDays: 3,
    maxMachines: 'same-type',
    respectChronology: true
};

const overtimeTracker = {
    currentWeek: 50,
    totalHoursUsed: 0,
    byMachine: {},
    byDay: {},
    history: [],
    limits: {
        weeklyMax: 10,
        dailyMax: 2
    }
};

// Initialize overtime trackers
ALL_MACHINES.forEach(machine => {
    overtimeTracker.byMachine[machine] = { hours: 0 };
});
DAYS_OF_WEEK.forEach(day => {
    overtimeTracker.byDay[day] = 0;
});

// Lunch break configuration (Monday-Thursday only) - dynamique
let LUNCH_BREAK = {
    start: '12:30',
    end: '13:00',
    duration: 0.5  // 30 minutes
};

// Calcul de durée par poids de matériau
const DUREE_PAR_KG = {
    'Cisaillage': 0.02,    // 0.02h par kg (ex: 100kg = 2h)
    'Poinçonnage': 0.015,  // 0.015h par kg
    'Pliage': 0.025        // 0.025h par kg
};

// Current time simulation (Now Real Time by default)
let currentTime = new Date(); // Uses system time by default

// View state
let vueActive = 'semaine'; // 'semaine' ou 'journee'
let semaineSelectionnee = 50;
let anneeSelectionnee = 2025; // New state for year navigation

// Navigation Functions
function changeWeek(offset) {
    semaineSelectionnee += offset;
    
    // Handle Year Rollover (Simplified 52-week logic)
    if (semaineSelectionnee > 52) {
        semaineSelectionnee = 1;
        anneeSelectionnee++;
    } else if (semaineSelectionnee < 1) {
        semaineSelectionnee = 52;
        anneeSelectionnee--;
    }
    refresh();
}

function goToWeekFromDate(dateStr) {
    if (!dateStr) return;
    const date = new Date(dateStr);
    semaineSelectionnee = getWeekNumber(date);
    anneeSelectionnee = date.getFullYear();
    
    // Correction if week 1 is in December
    if (semaineSelectionnee === 1 && date.getMonth() === 11) {
        anneeSelectionnee++;
    }
    // Correction if week 52/53 is in January
    if (semaineSelectionnee >= 52 && date.getMonth() === 0) {
        anneeSelectionnee--;
    }
    
    refresh();
}

// Expose
window.changeWeek = changeWeek;
window.goToWeekFromDate = goToWeekFromDate;

// Drag and drop state
let draggedOperation = null;

// Global orders array (loaded from CSV)
let commandes = [];

// Print mode flag
let isPrintMode = false;

// Sidebar search query
let currentSearchQuery = '';

// System Events (Maintenance/Closures)
let systemEvents = [];

// Migration automatique des noms de machines
function migrateMachineNames() {
    const MIGRATION_MAP = {
        'Poinçonneuse A': 'Poinçonneuse M',
        'Poinçonneuse B': 'Poinçonneuse T'
    };

    let migrationCount = 0;

    commandes.forEach(commande => {
        if (!commande.operations) return;

        commande.operations.forEach(operation => {
            if (!operation.slots) return;

            operation.slots.forEach(slot => {
                if (MIGRATION_MAP[slot.machine]) {
                    console.log(`Migration: ${slot.machine} → ${MIGRATION_MAP[slot.machine]} (commande ${commande.id})`);
                    slot.machine = MIGRATION_MAP[slot.machine];
                    migrationCount++;
                }
            });
        });
    });

    if (migrationCount > 0) {
        console.log(`✅ Migration terminée: ${migrationCount} slots mis à jour`);
        return true;
    }
    return false;
}

// ===================================
// Migration des champs Override de temps
// ===================================
function migrateOperationOverrideFields() {
    let migrationCount = 0;

    commandes.forEach(commande => {
        if (!commande.operations) return;

        commande.operations.forEach(operation => {
            // Ajouter les champs manquants avec valeurs par défaut
            if (operation.dureeOriginal === undefined) {
                operation.dureeOriginal = operation.dureeTotal;
                migrationCount++;
            }
            if (operation.dureeOverride === undefined) {
                operation.dureeOverride = null;
            }
            if (operation.overrideTimestamp === undefined) {
                operation.overrideTimestamp = null;
            }
        });
    });

    if (migrationCount > 0) {
        console.log(`✅ Migration override fields: ${migrationCount} opérations mises à jour`);
        return true;
    }
    return false;
}

// ===================================
// Migration du champ semaineAffectee (Workflow 2 étapes)
// ===================================

/**
 * Migration des commandes existantes pour ajouter le champ semaineAffectee
 * Les commandes avec des opérations déjà placées seront affectées à leur semaine
 * Les commandes sans slots auront semaineAffectee = null
 */
function migrateCommandesSemaineAffectee() {
    let migratedCount = 0;

    commandes.forEach(cmd => {
        // Si le champ existe déjà, ne pas migrer
        if (cmd.semaineAffectee !== undefined) return;

        // Vérifier si des opérations sont déjà placées
        const hasPlacedSlots = cmd.operations?.some(op =>
            op.slots && op.slots.length > 0
        );

        if (hasPlacedSlots) {
            // Trouver le premier slot pour déterminer la semaine
            const allSlots = cmd.operations
                .flatMap(op => op.slots || [])
                .filter(slot => slot.semaine && slot.dateDebut);

            if (allSlots.length > 0) {
                // Trier par date pour avoir le premier
                allSlots.sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut));
                const firstSlot = allSlots[0];

                // Extraire l'année depuis dateDebut ou anneeSelectionnee
                const slotDate = new Date(firstSlot.dateDebut);
                const year = slotDate.getFullYear();
                const week = firstSlot.semaine;

                cmd.semaineAffectee = `${year}-W${String(week).padStart(2, '0')}`;
            } else {
                cmd.semaineAffectee = null;
            }
        } else {
            // Pas de slots → commande non affectée
            cmd.semaineAffectee = null;
        }

        migratedCount++;
    });

    if (migratedCount > 0) {
        console.log(`✅ Migration semaineAffectee: ${migratedCount} commandes mises à jour`);
        return true;
    }
    return false;
}


// ===================================
// CSV Parsing Functions
// ===================================

/**
 * Génère un ID de slot déterministe basé sur l'opération + index
 * @param {string} operationId - ID de l'opération (ex: CC26-0019_cisaillage)
 * @param {Array} existingSlots - Slots déjà existants pour compter l'index
 * @returns {string} - ID du slot (ex: CC26-0019_cisaillage_slot_1)
 */
function generateSlotId(operationId, existingSlots) {
    const index = (existingSlots ? existingSlots.length : 0) + 1;
    return `${operationId}_slot_${index}`;
}

/**
 * Convert HH:MM:SS time format (or Date object, or Excel serial number) to decimal hours
 */
function timeToDecimalHours(timeStr) {
    if (timeStr === null || timeStr === undefined || timeStr === '') return 0;

    // Handle Google Sheet Date objects (often returned for times)
    if (timeStr instanceof Date) {
        // If it's a full date, we just want the time part relative to midnight?
        // Or is it a duration? Google Sheets passes "1899-12-30T..." for durations.
        // We extract Hours + Minutes + Seconds.
        return timeStr.getHours() + (timeStr.getMinutes() / 60) + (timeStr.getSeconds() / 3600);
    }

    // Handle string format "HH:MM:SS"
    if (typeof timeStr === 'string') {
        const parts = timeStr.trim().split(':');
        if (parts.length === 0) return 0;
        const hours = parseInt(parts[0]) || 0;
        const minutes = parseInt(parts[1]) || 0;
        const seconds = parseInt(parts[2]) || 0;
        return hours + (minutes / 60) + (seconds / 3600);
    }

    // Handle Excel Serial Number (e.g. 0.5 = 12:00, 1.0 = 24h)
    // If it's a number < 24, it might be hours already? No, safer to assume serial day fraction for Google Sheets.
    // BUT sometimes user puts "2" for 2 hours.
    // Heuristic: If < 1, treat as day fraction. If >= 1, treat as hours?
    // Let's assume day fraction which is standard for "Time" format.
    // Wait, 19:47:30 as serial is ~0.82.
    if (typeof timeStr === 'number') {
        // If it's a small float, likely a day fraction
        if (timeStr < 1) {
            return timeStr * 24;
        }
        // If it looks like hours (e.g. 3.5), return as is
        return timeStr;
    }

    return 0;
}

/**
 * Parse CSV data and return array of rows - LEGACY (DISABLED)
 */
function fetchAndParseCSV() {
    console.warn('⚠️ CSV parsing disabled - Using Supabase only');
    return [];
    
    /* LEGACY CODE - DISABLED
    try {
        const lines = localCsvData.trim().split('\n');
        const headers = lines[0].split(';').map(h => h.trim());
        const rows = [];

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            
            const values = lines[i].split(';');
            const row = {};
            
            headers.forEach((header, index) => {
                row[header] = values[index] ? values[index].trim() : '';
            });
            rows.push(row);
        }
        return rows;
    } catch (error) {
        console.error('❌ Error parsing CSV:', error);
        return [];
    }
    */
}

/**
 * Helper function to get a value from a row by trying multiple possible key names
 * Handles encoding issues with accented characters
 */
function getRowValue(row, possibleKeys, defaultValue = '') {
    // First try direct key match
    for (const key of possibleKeys) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
            return row[key];
        }
    }
    // Fallback: search by normalized key (without accents)
    const normalizedKeys = Object.keys(row).map(k => ({
        original: k,
        normalized: k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    }));
    for (const key of possibleKeys) {
        const normalizedSearch = key.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const match = normalizedKeys.find(nk => nk.normalized === normalizedSearch);
        if (match && row[match.original]) {
            return row[match.original];
        }
    }
    return defaultValue;
}

/**
 * Map Google Sheet row (Simplified Format) to order object
 * Input Columns: Fin de Prod, Code cde, STATUT, Client, Poids, CISAILLE, POINCON, PLIAGE
 */
function mapGoogleSheetRowToOrder(row) {
    // 1. Map basic fields
    const order = {
        id: row['Code cde'] || 'N/A',
        client: row['Client'] || 'Inconnu',
        dateLivraison: row['Fin de Prod'] || '', // Date parsing might be needed if format varies
        statut: row['STATUT'] || 'Non placée',
        materiau: 'Inconnu', // Not in new sheet, default value
        poids: parseInt(row['Poids']) || 0,
        refCdeClient: getRowValue(row, ['Réf cde client', 'Ref cde client', 'Ref_Cde_Client'], ''),
        ressource: 'Polyvalent', // Default
        operations: []
    };

    // 2. Create Operations based on columns CISAILLE, POINCON, PLIAGE
    const opTypes = [
        { key: 'CISAILLE', type: 'Cisaillage' },
        { key: 'POINCON', type: 'Poinçonnage' },
        { key: 'PLIAGE', type: 'Pliage' }
    ];

    opTypes.forEach(opConfig => {
        const durationStr = row[opConfig.key];
        const duration = timeToDecimalHours(durationStr);

        // Only add operation if duration > 0
        if (duration > 0) {
            // ID déterministe basé sur orderId + type normalisé
            const typeNormalized = opConfig.type.toLowerCase()
                .replace('ç', 'c')
                .replace('é', 'e')
                .replace(/[^a-z]/g, '');
            const operationId = `${order.id}_${typeNormalized}`;

            order.operations.push({
                id: operationId,              // ID stable pour upsert Supabase
                type: opConfig.type,
                dureeTotal: duration,
                dureeOriginal: duration,      // Temps original GSheet
                dureeOverride: null,          // Modification utilisateur (null = pas de modif)
                overrideTimestamp: null,      // Date de la modification
                progressionReelle: 0, // No progress data in sheet
                statut: 'Non placée', // Default to unplaced since no slot data
                slots: [] // No slot data in this simplified sheet
            });
        }
    });

    // 3. Status Mapping normalization
    // Ensure status matches app conventions (En cours, Planifiée, etc.)
    // If "Livré" or "Terminée", they might be filtered out later, but map them correctly.
    if (order.statut.toLowerCase() === 'en cours') order.statut = 'En cours';
    if (order.statut.toLowerCase() === 'planifiée') order.statut = 'Planifiée';
    if (order.statut.toLowerCase() === 'en prépa') order.statut = 'En prépa';

    return order;
}

/**
 * Map CSV row to order object (Legacy - kept for reference or fallback)
 */
function mapSheetRowToOrder(row) {
    const order = {
        id: row['N° Commande'],
        client: row['Client'],
        dateLivraison: row['Date Livraison'],
        statut: row['Statut'],
        materiau: row['Matériau'],
        poids: parseInt(row['Poids (kg)']) || 0,
        ressource: row['Ressource'],
        operations: []
    };

    // Map 3 operations
    for (let i = 1; i <= 3; i++) {
        const opType = row[`Op ${i} Type`];
        if (!opType) continue;

        const dureeValue = timeToDecimalHours(row[`Op ${i} Durée`]);

        // ID déterministe basé sur orderId + type normalisé
        const typeNormalized = opType.toLowerCase()
            .replace('ç', 'c')
            .replace('é', 'e')
            .replace(/[^a-z]/g, '');
        const operationId = `${order.id}_${typeNormalized}`;

        const operation = {
            id: operationId,                  // ID stable pour upsert Supabase
            type: opType,
            dureeTotal: dureeValue,
            dureeOriginal: dureeValue,        // Temps original GSheet
            dureeOverride: null,              // Modification utilisateur
            overrideTimestamp: null,          // Date de la modification
            progressionReelle: parseInt(row[`Op ${i} Progression`]) || 0,
            statut: row[`Op ${i} Statut`] || 'Non placée',
            slots: []
        };

        // Add slot if machine is specified
        const machine = row[`Op ${i} Machine`];
        if (machine && machine.trim() !== '') {
            const semaine = parseInt(row[`Op ${i} Semaine`]) || 0;
            const jour = row[`Op ${i} Jour`] || '';
            const heureDebut = row[`Op ${i} Heure Début`] || '09:00';

            if (semaine > 0 && jour !== '') {
                const duree = operation.dureeTotal;
                const startHour = parseInt(heureDebut.split(':')[0]);
                const startMinute = parseInt(heureDebut.split(':')[1]) || 0;
                const endHourFloat = startHour + startMinute / 60 + duree;
                const endHour = Math.floor(endHourFloat);
                const endMinute = Math.round((endHourFloat - endHour) * 60);
                const heureFin = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;

                const dateDebut = getDateFromWeekDay(semaine, jour, heureDebut);
                const dateFin = getDateFromWeekDay(semaine, jour, heureFin);

                operation.slots.push({
                    id: generateSlotId(operation.id, operation.slots),
                    machine: machine,
                    duree: duree,
                    semaine: semaine,
                    jour: jour,
                    heureDebut: heureDebut,
                    heureFin: heureFin,
                    dateDebut: dateDebut.toISOString().split('.')[0],
                    dateFin: dateFin.toISOString().split('.')[0]
                });
            }
        }

        order.operations.push(operation);
    }

    return order;
}

// ===================================
// ⏪ UNDO/REDO SYSTEM
// ===================================

class HistoryManager {
    constructor() {
        this.history = [];
        this.currentIndex = -1;
        this.maxHistory = 50; // Limit memory usage
        this.isNavigating = false;
    }

    // Save current state
    saveState(actionName) {
        if (this.isNavigating) return;

        // Create deep copy of commandes
        const state = JSON.parse(JSON.stringify(commandes));

        // If we are in the middle of history, cut off the future
        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push({ state: state, action: actionName, timestamp: new Date() });
        
        // Limit size
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        } else {
            this.currentIndex++;
        }

        console.log(`💾 State Saved: ${actionName} (Index: ${this.currentIndex})`);
        this.updateUI();
    }
    // Vérifie l'espace utilisé et alerte si > 80%
     checkStorageHealth() {
        const used = new Blob(Object.values(localStorage)).size;
        const max = 5 * 1024 * 1024; // 5MB
        const percentUsed = (used / max * 100).toFixed(1);
        
        console.log(`💾 Stockage: ${percentUsed}% (${(used/1024).toFixed(1)} KB / 5 MB)`);
        
        if (percentUsed > 80) {
            Toast.warning(`⚠️ Espace de stockage critique : ${percentUsed}%`);
        }
        
        return { used, max, percentUsed };
    }
    // Undo
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

    // Redo
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

    // Restore state to app
    restoreState(snapshot) {
        commandes = JSON.parse(JSON.stringify(snapshot.state));
        refresh(); // Re-render everything
        markAllCommandesDirty();
        if (typeof syncManager !== 'undefined') syncManager.saveLocalData(); // Persist
    }
    
    // Update UI (optional buttons?)
    updateUI() {
        // Could enable/disable undo/redo buttons if we had them
    }
}

const historyManager = new HistoryManager();

// ===================================
// Data Loading (Supabase est la source primaire)
// ===================================

const SYNC_METADATA_KEY = 'etm_sync_metadata';

// ===================================
// Legacy Demo Data (kept for reference)
// ===================================

const commandesDemo = [
    // COMMANDES PLACÉES
    {
        id: "CC25-1001",
        client: "SPEBI",
        dateLivraison: "2025-12-20",
        statut: "En cours",
        materiau: "Aluminium",
        poids: 150, // kg
        ressource: "Polyvalent",
        operations: [
            {
                type: "Cisaillage",
                dureeTotal: 3, // Calculé: 150kg * 0.02h/kg = 3h
                slots: [
                    {
                        machine: "Cisaille A",
                        duree: 3,
                        semaine: 50,
                        jour: "Lundi",
                        heureDebut: "09:00",
                        heureFin: "12:00",
                        dateDebut: "2025-12-08T08:00:00",
                        dateFin: "2025-12-08T11:00:00"
                    }
                ],
                progressionReelle: 75,
                statut: "En cours"
            },
            {
                type: "Poinçonnage",
                dureeTotal: 2.25, // 150kg * 0.015h/kg = 2.25h
                slots: [
                    {
                        machine: "Poinçonneuse A",
                        duree: 2.25,
                        semaine: 50,
                        jour: "Mardi",
                        heureDebut: "09:00",
                        heureFin: "11:15",
                        dateDebut: "2025-12-09T08:00:00",
                        dateFin: "2025-12-09T10:15:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            },
            {
                type: "Pliage",
                dureeTotal: 3.75, // 150kg * 0.025h/kg = 3.75h
                slots: [
                    {
                        machine: "Plieuse Lo",
                        duree: 3.75,
                        semaine: 50,
                        jour: "Mercredi",
                        heureDebut: "09:00",
                        heureFin: "12:45",
                        dateDebut: "2025-12-10T08:00:00",
                        dateFin: "2025-12-10T11:45:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            }
        ]
    },
    {
        id: "CC25-1002",
        client: "BOUVET",
        dateLivraison: "2025-12-18",
        statut: "En cours",
        materiau: "Galvanisé",
        poids: 200,
        ressource: "Polyvalent",
        operations: [
            {
                type: "Cisaillage",
                dureeTotal: 4, // 200kg * 0.02h/kg = 4h
                slots: [
                    {
                        machine: "Cisaille A",
                        duree: 2,
                        semaine: 50,
                        jour: "Lundi",
                        heureDebut: "12:00",
                        heureFin: "14:00",
                        dateDebut: "2025-12-08T11:00:00",
                        dateFin: "2025-12-08T13:00:00"
                    },
                    {
                        machine: "Cisaille A",
                        duree: 2,
                        semaine: 50,
                        jour: "Lundi",
                        heureDebut: "14:00",
                        heureFin: "16:00",
                        dateDebut: "2025-12-08T13:00:00",
                        dateFin: "2025-12-08T15:00:00"
                    }
                ],
                progressionReelle: 100,
                statut: "En cours"
            },
            {
                type: "Poinçonnage",
                dureeTotal: 3, // 200kg * 0.015h/kg = 3h
                slots: [
                    {
                        machine: "Poinçonneuse B",
                        duree: 3,
                        semaine: 50,
                        jour: "Mardi",
                        heureDebut: "09:00",
                        heureFin: "12:00",
                        dateDebut: "2025-12-09T08:00:00",
                        dateFin: "2025-12-09T11:00:00"
                    }
                ],
                progressionReelle: 100,
                statut: "En cours"
            },
            {
                type: "Pliage",
                dureeTotal: 5, // 200kg * 0.025h/kg = 5h
                slots: [
                    {
                        machine: "Plieuse Mik",
                        duree: 5,
                        semaine: 51,
                        jour: "Lundi",
                        heureDebut: "09:00",
                        heureFin: "14:00",
                        dateDebut: "2025-12-15T08:00:00",
                        dateFin: "2025-12-15T13:00:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            }
        ]
    },
    {
        id: "CC25-1003",
        client: "ALPAC",
        dateLivraison: "2025-12-25",
        statut: "En cours",
        materiau: "Aluminium",
        poids: 180,
        ressource: "Apprenti",
        operations: [
            {
                type: "Cisaillage",
                dureeTotal: 3.6, // 180kg * 0.02h/kg = 3.6h
                slots: [
                    {
                        machine: "Cisaille B",
                        duree: 3.6,
                        semaine: 50,
                        jour: "Mercredi",
                        heureDebut: "09:00",
                        heureFin: "12:36",
                        dateDebut: "2025-12-11T09:00:00",
                        dateFin: "2025-12-11T12:36:00"
                    }
                ],
                progressionReelle: 50,
                statut: "En cours"
            },
            {
                type: "Poinçonnage",
                dureeTotal: 2.7, // 180kg * 0.015h/kg = 2.7h
                slots: [
                    {
                        machine: "Poinçonneuse A",
                        duree: 2.7,
                        semaine: 50,
                        jour: "Jeudi",
                        heureDebut: "09:00",
                        heureFin: "11:42",
                        dateDebut: "2025-12-12T09:00:00",
                        dateFin: "2025-12-12T11:42:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            },
            {
                type: "Pliage",
                dureeTotal: 4.5, // 180kg * 0.025h/kg = 4.5h
                slots: [
                    {
                        machine: "Plieuse Lo",
                        duree: 4.5,
                        semaine: 50,
                        jour: "Vendredi",
                        heureDebut: "09:00",
                        heureFin: "13:30",
                        dateDebut: "2025-12-13T09:00:00",
                        dateFin: "2025-12-13T13:30:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            }
        ]
    },
    {
        id: "CC25-1004",
        client: "SOPREMA",
        dateLivraison: "2025-12-27",
        statut: "Planifiée",
        materiau: "Galvanisé",
        poids: 120,
        ressource: "Polyvalent",
        operations: [
            {
                type: "Cisaillage",
                dureeTotal: 2.4, // 120kg * 0.02h/kg = 2.4h
                slots: [
                    {
                        machine: "Cisaille B",
                        duree: 2.4,
                        semaine: 51,
                        jour: "Mardi",
                        heureDebut: "09:00",
                        heureFin: "11:24",
                        dateDebut: "2025-12-17T09:00:00",
                        dateFin: "2025-12-17T11:24:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            },
            {
                type: "Poinçonnage",
                dureeTotal: 1.8, // 120kg * 0.015h/kg = 1.8h
                slots: [
                    {
                        machine: "Poinçonneuse B",
                        duree: 1.8,
                        semaine: 51,
                        jour: "Mercredi",
                        heureDebut: "09:00",
                        heureFin: "10:48",
                        dateDebut: "2025-12-18T09:00:00",
                        dateFin: "2025-12-18T10:48:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            },
            {
                type: "Pliage",
                dureeTotal: 3, // 120kg * 0.025h/kg = 3h
                slots: [
                    {
                        machine: "Plieuse Mik",
                        duree: 3,
                        semaine: 51,
                        jour: "Jeudi",
                        heureDebut: "09:00",
                        heureFin: "12:00",
                        dateDebut: "2025-12-19T09:00:00",
                        dateFin: "2025-12-19T12:00:00"
                    }
                ],
                progressionReelle: 0,
                statut: "Planifiée"
            }
        ]
    },

    // COMMANDES NON PLACÉES
    {
        id: "CC25-1012",
        client: "SPEBI",
        dateLivraison: "2025-12-25",
        statut: "Non placée",
        materiau: "Aluminium",
        poids: 250,
        ressource: "Polyvalent",
        operations: [
            {
                type: "Cisaillage",
                dureeTotal: 5, // 250kg * 0.02h/kg = 5h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            },
            {
                type: "Poinçonnage",
                dureeTotal: 3.75, // 250kg * 0.015h/kg = 3.75h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            },
            {
                type: "Pliage",
                dureeTotal: 6.25, // 250kg * 0.025h/kg = 6.25h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            }
        ]
    },
    {
        id: "CC25-1013",
        client: "ALPAC",
        dateLivraison: "2025-12-20",
        statut: "Non placée",
        materiau: "Galvanisé",
        poids: 100,
        ressource: "Apprenti",
        operations: [
            {
                type: "Cisaillage",
                dureeTotal: 2, // 100kg * 0.02h/kg = 2h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            },
            {
                type: "Poinçonnage",
                dureeTotal: 1.5, // 100kg * 0.015h/kg = 1.5h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            },
            {
                type: "Pliage",
                dureeTotal: 2.5, // 100kg * 0.025h/kg = 2.5h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            }
        ]
    },
    {
        id: "CC25-1014",
        client: "GCC HABITAT",
        dateLivraison: "2025-12-15", // URGENT!
        statut: "Non placée",
        materiau: "Aluminium",
        poids: 300,
        ressource: "Polyvalent",
        operations: [
            {
                type: "Cisaillage",
                dureeTotal: 6, // 300kg * 0.02h/kg = 6h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            },
            {
                type: "Poinçonnage",
                dureeTotal: 4.5, // 300kg * 0.015h/kg = 4.5h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            },
            {
                type: "Pliage",
                dureeTotal: 7.5, // 300kg * 0.025h/kg = 7.5h
                slots: [],
                progressionReelle: 0,
                statut: "Non placée"
            }
        ]
    },

    // Commandes terminées/livrées (masquées)
    {
        id: "CC25-0999",
        client: "GCC HABITAT",
        dateLivraison: "2025-12-05",
        statut: "Livrée",
        materiau: "Galvanisé",
        poids: 150,
        ressource: "Polyvalent",
        operations: []
    },
    {
        id: "CC25-1000",
        client: "SPEBI",
        dateLivraison: "2025-12-08",
        statut: "Terminée",
        materiau: "Aluminium",
        poids: 200,
        ressource: "Polyvalent",
        operations: []
    }
];

// ===================================
// Utility Functions
// ===================================

/**
 * Calculate operation duration based on material weight
 */
function calculerDureeOperation(type, poids) {
    return Math.round((poids * DUREE_PAR_KG[type]) * 100) / 100; // Arrondi à 2 décimales
}

/**
 * Get week number from date
 */
function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Get ISO Week Year (handles week 1 starting in previous year, etc.)
 */
function getISOWeekYear(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    return d.getFullYear();
}

/**
 * Get date range for a week number
 */
function getWeekDateRange(weekNumber, year) {
    // Use provided year, or global state, or current year
    const targetYear = year || (typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : new Date().getFullYear());
    
    const simple = new Date(targetYear, 0, 1 + (weekNumber - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = simple;
    if (dow <= 4)
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    const startDate = ISOweekStart;
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 4);

    return {
        start: startDate.getDate(),
        end: endDate.getDate(),
        month: startDate.toLocaleDateString('fr-FR', { month: 'short' })
    };
}

/**
 * Filter active orders (case-insensitive)
 */
function getActiveOrders() {
    return commandes.filter(cmd => {
        const status = cmd.statut.toLowerCase().trim();
        return status !== "terminée" && status !== "livrée";
    });
}

/**
 * Get placed orders (with at least one slot)
 * Includes "En prépa" orders with at least one operation placed
 */
function getPlacedOrders() {
    return getActiveOrders().filter(cmd => {
        const status = cmd.statut.toLowerCase().trim();

        // Include "En cours" and "Planifiée"
        if (status === "en cours" || status === "planifiée") {
            return true;
        }

        // Include "En prépa" if at least one operation has slots
        if (status === "en prépa") {
            return cmd.operations.some(op => op.slots && op.slots.length > 0);
        }

        return false;
    });
}

/**
 * Get unplaced orders
 * Includes "En prépa" orders with at least one operation NOT placed
 */
function getUnplacedOrders() {
    return commandes.filter(cmd => {
        // If explicitly "Terminée" or "Livrée", ignore
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;

        // Otherwise, check if ANY operation is unplaced
        // This covers 'Non placée', 'En cours', and even 'Planifiée' (if we want to be safe, though Planifiée usually means all placed)
        return cmd.operations.some(op => !op.slots || op.slots.length === 0);
    });
}

// ===================================
// Filtrage pour Workflow 2 étapes
// ===================================

/**
 * Récupère les commandes non affectées à une semaine
 * Utilisée dans la sidebar de la vue semaine
 * @returns {Array} Commandes avec semaineAffectee === null
 */
function getCommandesNonAffectees() {
    return commandes.filter(cmd => {
        // Exclure les terminées/livrées
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;

        // Inclure seulement celles sans affectation de semaine
        return cmd.semaineAffectee === null || cmd.semaineAffectee === undefined;
    });
}

/**
 * Récupère les opérations non placées d'une semaine spécifique
 * Utilisée dans la sidebar de la vue journée
 * @param {number} semaine - Numéro de semaine (1-52)
 * @param {number} annee - Année
 * @returns {Array} Objets {commande, operation} des opérations non placées de cette semaine
 */
function getOperationsAffecteesSemaine(semaine, annee) {
    const targetWeekStr = `${annee}-W${String(semaine).padStart(2, '0')}`;
    const result = [];

    commandes.forEach(cmd => {
        // Vérifier l'affectation semaine
        if (cmd.semaineAffectee !== targetWeekStr) return;

        // Exclure les terminées/livrées
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return;

        // Collecter les opérations non placées
        cmd.operations.forEach(op => {
            if (!op.slots || op.slots.length === 0) {
                result.push({
                    commande: cmd,
                    operation: op
                });
            }
        });
    });

    return result;
}

/**
 * Récupère les commandes affectées à une semaine mais pas encore entièrement placées
 * Utilisée pour afficher les commandes dans la ligne "À placer" de la vue semaine
 * @param {number} semaine - Numéro de semaine (1-52)
 * @param {number} annee - Année
 * @returns {Array} Commandes affectées avec au moins une opération non placée
 */
function getCommandesAffecteesNonPlacees(semaine, annee) {
    const targetWeekStr = `${annee}-W${String(semaine).padStart(2, '0')}`;

    return commandes.filter(cmd => {
        // Doit être affectée à cette semaine
        if (cmd.semaineAffectee !== targetWeekStr) return false;

        // Exclure les terminées/livrées
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;

        // Si pas d'opérations, considérer comme "à placer" (bug sync Supabase)
        if (!cmd.operations || cmd.operations.length === 0) {
            return true;
        }

        // Doit avoir AU MOINS UNE opération non placée
        return cmd.operations.some(op => !op.slots || op.slots.length === 0);
    });
}

/**
 * Calculate machine capacity for a week
 */
function calculerCapaciteMachine(machine, semaine, annee = null) {
    const targetYear = annee || (typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : new Date().getFullYear());
    const placedOrders = getPlacedOrders();
    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            // Filter by machine, week and year
            if (slot.machine !== machine || slot.semaine !== semaine) return false;

            // 🔒 CRITICAL: Filter by year to avoid showing operations from different years
            const slotYear = getISOWeekYear(slot.dateDebut);
            return slotYear === targetYear;
        });

    const heuresUtilisees = slots.reduce((sum, slot) => sum + slot.duree, 0);
    const pourcentage = Math.round((heuresUtilisees / TOTAL_HOURS_PER_WEEK) * 100);

    return { heuresUtilisees, pourcentage };
}

/**
 * Calculate machine capacity for a specific day
 */
function calculerCapaciteJour(machine, jour, semaine, annee = null) {
    const targetYear = annee || (typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : new Date().getFullYear());
    const placedOrders = getPlacedOrders();
    const capaciteJour = HOURS_PER_DAY[jour];

    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            if (slot.machine !== machine || slot.jour !== jour || slot.semaine !== semaine) return false;

            // 🔒 CRITICAL: Filter by year to avoid showing operations from different years
            const slotYear = getISOWeekYear(slot.dateDebut);
            return slotYear === targetYear;
        });

    const heuresUtilisees = slots.reduce((sum, slot) => sum + slot.duree, 0);
    const pourcentage = Math.round((heuresUtilisees / capaciteJour) * 100);

    // Déterminer classe de capacité
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
 * Get capacity color class
 */
function getCapacityColorClass(pourcentage) {
    if (pourcentage >= 96) return 'capacity-danger';
    if (pourcentage >= 76) return 'capacity-warning';
    return 'capacity-ok';
}

/**
 * Calcule la capacité globale de la semaine (toutes machines confondues)
 * Inclut les opérations placées ET les opérations affectées mais non placées
 * @param {number} semaine - Numéro de semaine
 * @param {number} annee - Année
 * @returns {Object} { heuresAffectees, heuresPlacees, capaciteTotale, pourcentage }
 */
function calculerCapaciteSemaineGlobale(semaine, annee) {
    const targetWeekStr = `${annee}-W${String(semaine).padStart(2, '0')}`;

    // Capacité totale = toutes les machines * heures par semaine
    const capaciteTotale = TOTAL_HOURS_PER_WEEK * ALL_MACHINES.length;

    // 1. Heures des opérations PLACÉES sur cette semaine
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

    // 2. Heures des opérations AFFECTÉES mais NON PLACÉES
    const commandesAffectees = commandes.filter(cmd => {
        if (cmd.semaineAffectee !== targetWeekStr) return false;
        if (cmd.statut === 'Terminée' || cmd.statut === 'Livrée') return false;
        return true;
    });

    const heuresNonPlacees = commandesAffectees
        .flatMap(cmd => cmd.operations)
        .filter(op => !op.slots || op.slots.length === 0)
        .reduce((sum, op) => sum + (op.dureeOverride || op.dureeTotal || 0), 0);

    // Total affecté = placées + non placées
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

/**
 * Find first available time gap in a day for an operation
 * Takes into account lunch break (12:30-13:00 Mon-Thu)
 * @param {string} minTimeStr - Optional minimum start time (HH:MM)
 * @returns {string|null} Start time (HH:MM) or null if no gap found
 */
/**
 * Helper: Calculate End Time accounting for ALL blocked zones (breaks + inter-shift gaps)
 * Remplace l'ancienne calculateEndTimeWithLunch
 */
function calculateEndTimeWithBreaks(startDec, duration, day) {
    const blockedZones = getBlockedZonesForDay(day);
    if (blockedZones.length === 0) return startDec + duration;

    let currentPos = startDec;
    let remaining = duration;

    for (const zone of blockedZones) {
        if (remaining <= 0.001) break;
        if (currentPos >= zone.end) continue;

        // Si on demarre dans une zone bloquee, sauter a la fin
        if (currentPos >= zone.start && currentPos < zone.end) {
            currentPos = zone.end;
            continue;
        }

        // Temps disponible avant la zone
        const availableBefore = zone.start - currentPos;
        if (remaining <= availableBefore) {
            return currentPos + remaining;
        }

        // On traverse la zone
        remaining -= availableBefore;
        currentPos = zone.end;
    }

    return currentPos + remaining;
}

// Alias pour retrocompatibilite
const calculateEndTimeWithLunch = calculateEndTimeWithBreaks;

/**
 * Détecte si une opération déborde sur les heures supplémentaires
 * @param {number} startDec - Heure de début en décimal (ex: 15.5 = 15:30)
 * @param {number} duration - Durée de l'opération en heures
 * @param {string} day - Jour de la semaine
 * @returns {object} Informations sur le débordement
 */
function detectOvertimeOverflow(startDec, duration, day) {
    const schedule = getScheduleForDay(day);
    const normalEnd = schedule.standardEnd; // 16.5 ou 12.0
    const operationEnd = calculateEndTimeWithLunch(startDec, duration, day);

    if (operationEnd <= normalEnd) {
        return { overflows: false, normalEnd, operationEnd };
    }

    const overtimeNeeded = operationEnd - normalEnd;
    const overtimeEnd = schedule.overtimeEnd; // 18.0 ou 14.0

    return {
        overflows: true,
        normalEnd: normalEnd,
        operationEnd: operationEnd,
        overtimeNeeded: overtimeNeeded,
        canFitWithOvertime: operationEnd <= overtimeEnd,
        exceedsDay: operationEnd > overtimeEnd
    };
}

function findFirstAvailableGap(machine, jour, semaine, durationNeeded, minTimeStr = null, allowOvertime = false, year = null) {
    const targetYear = year || (typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : new Date().getFullYear());
    const placedOrders = getPlacedOrders();

    // 1. Get Occupied Machine Slots (Operations + Maintenance/Closures)
    const machineSlots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            if (slot.machine !== machine || slot.jour !== jour || slot.semaine !== semaine) return false;

            // 🔒 CRITICAL: Filter by year to avoid showing operations from different years
            const slotYear = getISOWeekYear(slot.dateDebut);
            return slotYear === targetYear;
        })
        .map(slot => ({
            start: timeToDecimalHours(slot.heureDebut),
            end: timeToDecimalHours(slot.heureFin)
        }));

    // Add System Events (Maintenance or Factory Closures) - utilise les événements expansés pour supporter v2
    getExpandedSystemEvents()
        .filter(e => {
            if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== jour || e.week !== semaine) return false;

            // Filter by year to avoid showing events from different years
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

    // 2. Define Day Boundaries
    const dayStart = jour === 'Vendredi' ? 7 : 7.5;
    let dayEnd;
    if (jour === 'Vendredi') {
        dayEnd = allowOvertime ? 14 : 12;
    } else {
        dayEnd = allowOvertime ? 18 : 16.5;
    }

    // 3. Determine Search Start
    let currentSearch = dayStart;
    if (minTimeStr) {
        const parts = minTimeStr.split(':');
        currentSearch = Math.max(currentSearch, parseInt(parts[0]) + parseInt(parts[1]) / 60);
    }

    // Recuperer toutes les zones bloquees (pauses + gaps inter-equipes)
    const blockedZones = getBlockedZonesForDay(jour);

    // 4. Iterate to find a slot
    // We treat machineSlots as obstacles. We jump over them.

    // Optimization: Merge contiguous machine slots to simplify jumping
    // (Optional but good for performance)

    while (currentSearch + durationNeeded <= dayEnd + 0.001) { // 0.001 epsilon

        // A. Handle blocked zones (pauses, inter-shift gaps) for Start Time
        for (const zone of blockedZones) {
            // Cannot start INSIDE a blocked zone
            if (currentSearch >= zone.start && currentSearch < zone.end) {
                currentSearch = zone.end;
            }
            // Check "Small Op" Rule: If < 30min and would touch a zone, push to after
            if (durationNeeded < 0.5 && currentSearch < zone.start &&
                currentSearch + durationNeeded > zone.start) {
                currentSearch = zone.end;
            }
        }

        // B. Calculate Required End Time (including all blocked zones)
        const requiredEnd = calculateEndTimeWithBreaks(currentSearch, durationNeeded, jour);

        // C. Check Day Limit
        if (requiredEnd > dayEnd + 0.001) {
            return null; // Won't fit in the day
        }

        // D. Check Collision with Machine Slots
        // We check if the interval [currentSearch, requiredEnd] overlaps with any slot
        // Note: Slot Ends are exclusive? Usually yes.
        // Overlap: (StartA < EndB) and (EndA > StartB)
        
        const collisionSlot = machineSlots.find(slot => 
            currentSearch < slot.end - 0.001 && requiredEnd > slot.start + 0.001
        );

        if (collisionSlot) {
            // Collides! Jump to the end of this obstacle and retry
            currentSearch = Math.max(currentSearch, collisionSlot.end);
        } else {
            // No collision -> Found it!
            return formatDecimalTime(currentSearch);
        }
    }

    return null;
}

/**
 * Get machines sorted by load (least loaded first) for optimal distribution
 * @param {Array} machinesList - List of machines to sort
 * @param {Number} targetWeek - Week number to calculate load for
 * @param {Number} targetYear - Year for the target week
 * @returns {Array} Machines sorted by load (ascending)
 */
function getMachinesByLoadOrder(machinesList, targetWeek, targetYear = null) {
    const year = targetYear || (typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : new Date().getFullYear());

    // Calculate total load for each machine across all weeks up to targetWeek
    const machineLoads = machinesList.map(machine => {
        let totalLoad = 0;

        // Calculate load for weeks 50 to targetWeek
        // Note: This is a simplified approach assuming same year for all weeks
        for (let week = 50; week <= targetWeek; week++) {
            const weekCapacity = calculerCapaciteMachine(machine, week, year);
            totalLoad += weekCapacity.heuresUtilisees;
        }

        return {
            machine: machine,
            totalLoad: totalLoad,
            weekCapacity: calculerCapaciteMachine(machine, targetWeek, year)
        };
    });

    // Sort by total load (ascending) - least loaded first
    machineLoads.sort((a, b) => a.totalLoad - b.totalLoad);

    // Return sorted machine names
    return machineLoads.map(m => m.machine);
}

/**
 * Find the next available gap and return its start and max duration
 */
function findNextGap(machine, jour, semaine, minTimeStr = null, year = anneeSelectionnee) {
    const placedOrders = getPlacedOrders();

    console.log(`   🔎 findNextGap: ${machine} ${jour} S${semaine}, ${placedOrders.length} commandes placées`);

    // Get all slots for this machine/day/week/YEAR
    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => {
            if (slot.machine !== machine) return false;
            if (slot.jour !== jour) return false;
            if (slot.semaine !== semaine) return false;

            // Check Year
            const slotYear = new Date(slot.dateDebut).getFullYear();
            return slotYear === year;
        })
        .sort((a, b) => a.heureDebut.localeCompare(b.heureDebut));

    if (slots.length > 0) {
        console.log(`      Créneaux occupés détectés: ${slots.map(s => `${s.heureDebut}-${s.heureFin}`).join(', ')}`);
    }

    // Define time boundaries
    const startHour = jour === 'Vendredi' ? 7 : 7.5;
    const endHour = jour === 'Vendredi' ? 12 : 16.5;
    const totalMinutes = (endHour - startHour) * 60;

    // Create a timeline of busy periods
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

    // Add System Events (Maintenance or Factory Closures) - utilise les événements expansés pour supporter v2
    getExpandedSystemEvents()
        .filter(e => {
            if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== jour || e.week !== semaine) return false;

            // Filter by year to avoid showing events from different years
            const eventYear = e.year || getISOWeekYear(e.dateStr);
            return eventYear === year;
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
        const lunchStartParts = LUNCH_BREAK.start.split(':');
        const lunchEndParts = LUNCH_BREAK.end.split(':');
        const lunchStartHour = parseInt(lunchStartParts[0]) + parseInt(lunchStartParts[1]) / 60;
        const lunchEndHour = parseInt(lunchEndParts[0]) + parseInt(lunchEndParts[1]) / 60;
        busyPeriods.push({ 
            start: (lunchStartHour - startHour) * 60, 
            end: (lunchEndHour - startHour) * 60 
        });
        busyPeriods.sort((a, b) => a.start - b.start);
    }

    let currentTime = 0; // Start at beginning of work day

    // Adjust start time
    if (minTimeStr) {
        const minParts = minTimeStr.split(':');
        const minHourDecimal = parseInt(minParts[0]) + parseInt(minParts[1]) / 60;
        const startOffset = (minHourDecimal - startHour) * 60;
        currentTime = Math.max(0, startOffset);
    }

    // Find first gap > 0 (or at least 1 min to be useful)
    for (const busy of busyPeriods) {
        const gapSize = busy.start - currentTime;
        if (gapSize >= 1) { // At least 1 minute
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

    // Check gap at the end
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
 * Find best machine for an operation based on load and availability
 * @param {number} durationNeeded - Duration we are trying to place (can be partial)
 * @param {Object} globalMinStart - { week: number, dayIndex: number, timeStr: string } constraint
 * @returns {Object|null} {machine, week, day, startTime, usableDuration} or null
 */
function findBestMachineSlot(operation, cmd, machinesList, durationNeeded = null, globalMinStart = null) {
    if (durationNeeded === null) durationNeeded = operation.dureeTotal;

    // 🔒 CONSTRAINT: Same Machine Priority
    // If operation has already started, FORCE same machine
    if (operation.slots && operation.slots.length > 0) {
        const assignedMachine = operation.slots[0].machine;
        // Verify this machine is valid for this type (should be)
        if (machinesList.includes(assignedMachine)) {
            machinesList = [assignedMachine];
        }
    }

    const candidates = [];
    let rejectedCount = 0;

    // Scan all possible slots (Dynamic Horizon: Current Week + 3 weeks)
    const currentWeekStart = getWeekNumber(new Date());
    const currentYearStart = new Date().getFullYear();

    console.log(`🔍 DEBUG findBestMachineSlot: Recherche pour ${operation.type}, durée ${durationNeeded}h, semaine courante ${currentWeekStart}`);
    if (globalMinStart) {
        console.log(`   ⏰ globalMinStart = S${globalMinStart.week} ${DAYS_OF_WEEK[globalMinStart.dayIndex]} ${globalMinStart.timeStr}`);
    }

    // We scan 4 weeks (0 to 3 offset)
    for (let i = 0; i < 4; i++) {
        let targetWeek = currentWeekStart + i;
        let targetYear = currentYearStart;

        // Handle Rollover (52 -> 1)
        if (targetWeek > 52) {
            targetWeek -= 52;
            targetYear++;
        }

        // 🔒 Global Date Filter (Week)
        if (globalMinStart) {
            let globalOffset = globalMinStart.week - currentWeekStart;
            if (globalOffset < 0) globalOffset += 52; // Wrapped

            // Check if globalMinStart implies a year change that we haven't reached?
            // Simplified: just check if loop index < offset
            if (i < globalOffset) {
                console.log(`   ⏭️  SKIP Semaine ${targetWeek} (i=${i} < globalOffset=${globalOffset})`);
                continue;
            }
        }

        console.log(`   🔎 Scanning Semaine ${targetWeek} (année ${targetYear})`);

        // Get machines sorted by load for this target week
        const sortedMachines = getMachinesByLoadOrder(machinesList, targetWeek, targetYear);

        for (let dayIdx = 0; dayIdx < DAYS_OF_WEEK.length; dayIdx++) {
            // 🔒 Global Date Filter (Day)
            let globalOffset = 0;
            if (globalMinStart) {
                globalOffset = globalMinStart.week - currentWeekStart;
                if (globalOffset < 0) globalOffset += 52;
            }

            if (globalMinStart && i === globalOffset && dayIdx < globalMinStart.dayIndex) {
                console.log(`      ⏭️  SKIP ${DAYS_OF_WEEK[dayIdx]} S${targetWeek} (dayIdx=${dayIdx} < globalMinStart.dayIndex=${globalMinStart.dayIndex})`);
                continue;
            }

            const day = DAYS_OF_WEEK[dayIdx];
            const week = targetWeek;

            console.log(`      🗓️  Testing ${day} S${week}...`);

            for (let machine of sortedMachines) {
                let minTimeStr = null;

                // 🔒 Global Time Filter (Time)
                if (globalMinStart && i === globalOffset && dayIdx === globalMinStart.dayIndex) {
                    minTimeStr = globalMinStart.timeStr;
                    console.log(`         ⏰ Apply time constraint: >= ${minTimeStr}`);
                }
                
                // 1. Check Previous Operation (Standard Chronology)
                const opIndex = cmd.operations.indexOf(operation);
                if (opIndex > 0) {
                    const prevOp = cmd.operations[opIndex - 1];
                    if (prevOp.slots && prevOp.slots.length > 0) {
                        const lastSlot = prevOp.slots[prevOp.slots.length - 1];
                        
                        // Compare Date Objects directly for safety
                        const prevEnd = new Date(lastSlot.dateFin);
                        // Current Day Start (approx)
                        const currDayStart = getDateFromWeekDay(week, day, "00:00");
                        // We need correct year for getDateFromWeekDay... it uses global or param?
                        // I updated it to use global. I should probably ensure it uses targetYear.
                        // Let's use manual date constr for comparison to be safe.
                        
                        // Actually, simplified check:
                        // If prev op ends AFTER this day starts, we might have a constraint
                        // If prev op ends AFTER this day ENDS, skip day.
                        
                        // To allow year-safe check, we need specific dates for 'targetWeek/targetYear'.
                        // Let's rely on standard logic but refined:
                        
                        // If lastSlot.semaine > week (and same year), skip.
                        // But year might differ.
                        // Let's skip complex date math here and rely on findNextGap returning a valid gap, 
                        // then `canPlaceOperation` doing the strict check.
                        
                        // Optimization:
                        if (lastSlot.semaine === week && lastSlot.jour === day) {
                             if (!minTimeStr || timeToDecimalHours(lastSlot.heureFin) > timeToDecimalHours(minTimeStr)) {
                                 minTimeStr = lastSlot.heureFin;
                             }
                        }
                    }
                }

                // LOOP: Search for ANY valid gap in this day
                let currentSearchTimeStr = minTimeStr;

                while (true) {
                    // Find NEXT available gap (any size > 1min) starting from currentSearchTimeStr
                    // PASS YEAR
                    const gap = findNextGap(machine, day, week, currentSearchTimeStr, targetYear);

                    if (!gap) {
                        console.log(`         ❌ Pas de gap trouvé sur ${machine}`);
                        break; // No more gaps this day -> Next machine
                    }

                    console.log(`         ✅ Gap trouvé sur ${machine}: ${gap.startTime} (${gap.duration.toFixed(2)}h disponible)`);

                    // Calculate Gap End Time for next iteration
                    const startH = parseInt(gap.startTime.split(':')[0]);
                    const startM = parseInt(gap.startTime.split(':')[1]);
                    const startDec = startH + startM / 60;
                    const endDec = startDec + gap.duration;
                    const endH = Math.floor(endDec);
                    const endM = Math.round((endDec - endH) * 60);
                    const gapEndTimeStr = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;

                    // Validate chronological order (Strict check)
                    const validation = canPlaceOperation(cmd, operation, week, day, gap.startTime, targetYear);
                    if (!validation.valid) {
                        rejectedCount++;
                        console.log(`         🚫 Rejeté pour raison chronologique: ${validation.message}`);
                        // Try next gap in same day starting after this one
                        currentSearchTimeStr = gapEndTimeStr;
                        continue;
                    }

                    // Determine how much we can place
                    const usableDuration = Math.min(gap.duration, durationNeeded);

                    // Skip tiny gaps UNLESS the operation itself is tiny
                    // If operation is 10min (0.16h), we accept a 0.16h gap.
                    // If operation is 2h, we reject < 15min gaps to avoid fragmentation?
                    // Let's use a soft limit: min 15min OR the full remaining duration if it's small.
                    if (usableDuration < 0.25 && durationNeeded > 0.25) {
                        // Gap too small for a chunk -> Try next gap
                        console.log(`         ⚠️  Gap trop petit (${usableDuration.toFixed(2)}h < 0.25h)`);
                        currentSearchTimeStr = gapEndTimeStr;
                        continue;
                    }

                    console.log(`         🎯 Candidat valide: ${machine} ${day} S${week} ${gap.startTime} (${usableDuration.toFixed(2)}h)`);

                    // Calculate machine load score
                    const machineCapacity = calculerCapaciteMachine(machine, week, targetYear);
                    const loadScore = machineCapacity.heuresUtilisees / TOTAL_HOURS_PER_WEEK;

                    candidates.push({
                        machine: machine,
                        week: week,
                        year: targetYear,  // 🔒 CRITICAL: Include year for multi-year support
                        day: day,
                        startTime: gap.startTime,
                        usableDuration: usableDuration,
                        loadScore: loadScore,
                        weekPriority: i  // Use loop index (0=current week, 1=next week, etc.) instead of week number
                    });
                    
                    // Found a candidate for this machine/day -> Stop searching this machine (Load balancing handles machine selection)
                    break; 
                }
            }
        }
    }

    if (candidates.length === 0) return null;

    console.log(`   📋 ${candidates.length} candidat(s) trouvé(s) au total`);

    // Sort candidates
    candidates.sort((a, b) => {
        // 1. Week Priority (use loop index, not week number!)
        if (a.weekPriority !== b.weekPriority) return a.weekPriority - b.weekPriority;

        // 2. Day Priority
        const dayIndexA = DAYS_OF_WEEK.indexOf(a.day);
        const dayIndexB = DAYS_OF_WEEK.indexOf(b.day);
        if (dayIndexA !== dayIndexB) return dayIndexA - dayIndexB;

        // 3. Time Priority (Earliest start)
        const timeA = timeToDecimalHours(a.startTime);
        const timeB = timeToDecimalHours(b.startTime);
        if (timeA !== timeB) return timeA - timeB;

        // 4. Load (if same time/day/week)
        return a.loadScore - b.loadScore;
    });

    const chosen = candidates[0];
    console.log(`   🏆 Candidat choisi: ${chosen.machine} ${chosen.day} S${chosen.week} ${chosen.startTime} (weekPriority=${chosen.weekPriority})`);

    return chosen;
}

/**
 * Get urgency level for unplaced orders
 */
function getUrgencyLevel(dateLivraison) {
    const livraison = new Date(dateLivraison);
    const diff = Math.ceil((livraison - currentTime) / (1000 * 60 * 60 * 24));

    if (diff <= 5) return 'urgente';
    if (diff <= 10) return 'attention';
    return 'ok';
}

/**
 * Format date to French format
 */
function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

/**
 * Format hours to HH:MM
 */
function formatHours(hours) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h${m > 0 ? m.toString().padStart(2, '0') : ''}`;
}

// ===================================
// SYSTÈME D'OVERRIDE DES TEMPS D'OPÉRATIONS
// ===================================

/**
 * Vérifie si une opération a un override de temps
 */
function hasTimeOverride(operation) {
    return operation.dureeOverride !== null && operation.dureeOverride !== undefined;
}

/**
 * Définit un override de temps pour une opération
 * @param {string} commandeId - ID de la commande
 * @param {string} operationType - Type d'opération (Cisaillage, Poinçonnage, Pliage)
 * @param {number} newDuration - Nouvelle durée en heures décimales
 * @returns {boolean} Succès
 */
function setOperationTimeOverride(commandeId, operationType, newDuration) {
    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        return false;
    }

    const operation = cmd.operations.find(op => op.type === operationType);
    if (!operation) {
        Toast.error('Opération non trouvée');
        return false;
    }

    // Stocker l'original si pas encore fait
    if (operation.dureeOriginal === undefined || operation.dureeOriginal === null) {
        operation.dureeOriginal = operation.dureeTotal;
    }

    // Appliquer l'override
    operation.dureeOverride = newDuration;
    operation.overrideTimestamp = new Date().toISOString();
    operation.dureeTotal = newDuration;

    // Sauvegarder et rafraîchir
    historyManager.saveState(`Override temps ${operationType} ${commandeId}`);
    markCommandeDirty(commandeId);
    syncManager.saveLocalData();
    refresh();

    Toast.success(`Temps ${operationType} modifié: ${formatHours(newDuration)}`);
    return true;
}

/**
 * Réinitialise le temps d'une opération à la valeur originale du Google Sheet
 */
function resetOperationTimeOverride(commandeId, operationType) {
    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) return false;

    const operation = cmd.operations.find(op => op.type === operationType);
    if (!operation || !hasTimeOverride(operation)) return false;

    // Restaurer l'original
    operation.dureeTotal = operation.dureeOriginal;
    operation.dureeOverride = null;
    operation.overrideTimestamp = null;

    historyManager.saveState(`Reset temps ${operationType} ${commandeId}`);
    markCommandeDirty(commandeId);
    syncManager.saveLocalData();
    refresh();

    Toast.info(`Temps ${operationType} réinitialisé: ${formatHours(operation.dureeOriginal)}`);
    return true;
}

/**
 * Affiche le popup d'édition de temps (sidebar)
 */
function showTimeEditPopup(commandeId, operationType, currentDuration, originalDuration, targetElement) {
    // Supprimer popup existant
    closeTimeEditPopup();

    const hasOverride = Math.abs(currentDuration - originalDuration) > 0.001;

    const popup = document.createElement('div');
    popup.className = 'time-edit-popup';
    popup.innerHTML = `
        <div class="time-edit-header">
            <span>Modifier temps ${operationType}</span>
            <button class="btn-close-popup" onclick="closeTimeEditPopup()">&times;</button>
        </div>
        <div class="time-edit-body">
            <div class="time-input-group">
                <label>Heures:</label>
                <input type="number" id="timeEditHours" min="0" max="99" value="${Math.floor(currentDuration)}" />
            </div>
            <div class="time-input-group">
                <label>Minutes:</label>
                <input type="number" id="timeEditMinutes" min="0" max="59" step="5" value="${Math.round((currentDuration % 1) * 60)}" />
            </div>
            ${hasOverride ? `
                <div class="time-original-info">
                    Original GSheet: ${formatHours(originalDuration)}
                </div>
            ` : ''}
        </div>
        <div class="time-edit-actions">
            ${hasOverride ? `
                <button class="btn btn-sm btn-secondary" onclick="resetOperationTimeOverride('${commandeId}', '${operationType}'); closeTimeEditPopup();">
                    Réinitialiser
                </button>
            ` : ''}
            <button class="btn btn-sm btn-primary" onclick="applyTimeEdit('${commandeId}', '${operationType}')">
                Appliquer
            </button>
        </div>
    `;

    // Positionner le popup près de l'élément cliqué
    const rect = targetElement.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
    popup.style.top = `${rect.bottom + 5}px`;
    popup.style.zIndex = '1001';

    document.body.appendChild(popup);

    // Focus sur le champ heures
    document.getElementById('timeEditHours').focus();
    document.getElementById('timeEditHours').select();

    // Fermer au clic extérieur (avec délai pour éviter fermeture immédiate)
    setTimeout(() => {
        document.addEventListener('click', closeTimeEditPopupOnOutsideClick);
    }, 10);
}

function closeTimeEditPopup() {
    const popup = document.querySelector('.time-edit-popup');
    if (popup) popup.remove();
    document.removeEventListener('click', closeTimeEditPopupOnOutsideClick);
}

function closeTimeEditPopupOnOutsideClick(e) {
    const popup = document.querySelector('.time-edit-popup');
    if (popup && !popup.contains(e.target)) {
        closeTimeEditPopup();
    }
}

function applyTimeEdit(commandeId, operationType) {
    const hours = parseInt(document.getElementById('timeEditHours').value) || 0;
    const minutes = parseInt(document.getElementById('timeEditMinutes').value) || 0;
    const newDuration = hours + (minutes / 60);

    if (newDuration <= 0) {
        Toast.warning('La durée doit être supérieure à 0');
        return;
    }

    setOperationTimeOverride(commandeId, operationType, newDuration);
    closeTimeEditPopup();
}

/**
 * Affiche le modal d'édition de temps (depuis modal détail)
 */
function showModalTimeEdit(commandeId, operationType, currentDuration, originalDuration) {
    const hasOverride = Math.abs(currentDuration - originalDuration) > 0.001;

    const overlay = document.createElement('div');
    overlay.className = 'modal-time-edit-overlay';
    overlay.id = 'modalTimeEditOverlay';
    overlay.innerHTML = `
        <div class="modal-time-edit-content">
            <h3>Modifier temps: ${operationType}</h3>
            <div class="form-group">
                <label>Durée (heures décimales):</label>
                <input type="number" id="modalTimeEditValue"
                       step="0.25" min="0.25" max="100"
                       value="${currentDuration.toFixed(2)}" />
            </div>
            <p class="time-preview">
                = <strong id="timePreview">${formatHours(currentDuration)}</strong>
            </p>
            ${hasOverride ? `
                <p class="original-time-info">
                    Temps original Google Sheet: <strong>${formatHours(originalDuration)}</strong>
                </p>
            ` : ''}
            <div class="modal-time-edit-actions">
                <button class="btn btn-secondary" onclick="closeModalTimeEdit()">Annuler</button>
                ${hasOverride ? `
                    <button class="btn btn-warning" onclick="resetAndCloseModalTimeEdit('${commandeId}', '${operationType}')">
                        Réinitialiser
                    </button>
                ` : ''}
                <button class="btn btn-primary" onclick="applyModalTimeEdit('${commandeId}', '${operationType}')">
                    Appliquer
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Live preview
    document.getElementById('modalTimeEditValue').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) || 0;
        document.getElementById('timePreview').textContent = formatHours(val);
    });

    document.getElementById('modalTimeEditValue').focus();
    document.getElementById('modalTimeEditValue').select();
}

function closeModalTimeEdit() {
    const overlay = document.getElementById('modalTimeEditOverlay');
    if (overlay) overlay.remove();
}

function applyModalTimeEdit(commandeId, operationType) {
    const value = parseFloat(document.getElementById('modalTimeEditValue').value);
    if (value <= 0) {
        Toast.warning('La durée doit être supérieure à 0');
        return;
    }
    setOperationTimeOverride(commandeId, operationType, value);
    closeModalTimeEdit();
    // Rafraîchir le modal détail si ouvert
    showCommandeDetails(commandeId);
}

function resetAndCloseModalTimeEdit(commandeId, operationType) {
    resetOperationTimeOverride(commandeId, operationType);
    closeModalTimeEdit();
    showCommandeDetails(commandeId);
}

// Exposer les fonctions globalement
window.hasTimeOverride = hasTimeOverride;
window.setOperationTimeOverride = setOperationTimeOverride;
window.resetOperationTimeOverride = resetOperationTimeOverride;
window.showTimeEditPopup = showTimeEditPopup;
window.closeTimeEditPopup = closeTimeEditPopup;
window.applyTimeEdit = applyTimeEdit;
window.showModalTimeEdit = showModalTimeEdit;
window.closeModalTimeEdit = closeModalTimeEdit;
window.applyModalTimeEdit = applyModalTimeEdit;
window.resetAndCloseModalTimeEdit = resetAndCloseModalTimeEdit;

// ===================================
// 🔒 ORDRE CHRONOLOGIQUE - RÈGLE CRITIQUE
// ===================================
// ORDRE CHRONOLOGIQUE OBLIGATOIRE: Cisaille → Poinçon → Pliage
// Les opérations peuvent être PLACÉES dans n'importe quel ordre
// MAIS dans le planning, Cisaille doit SE TERMINER avant Poinçonnage,
// et Poinçonnage doit SE TERMINER avant Pliage

/**
 * 🔒 RÈGLE: Valide l'ordre des opérations
 * Cisaillage doit être avant Poinçonnage et Pliage
 * Poinçonnage et Pliage peuvent se chevaucher (ordre flexible entre eux)
 * @param {Object} commande - La commande à valider
 * @returns {Object} { valid: boolean, message: string }
 */
function validateOperationOrder(commande) {
    const operations = commande.operations;
    if (!operations || operations.length === 0) return { valid: true, message: '' };

    // Trouver l'index de Cisaillage s'il existe
    const cisaillageIndex = operations.findIndex(op => op.type === 'Cisaillage');

    if (cisaillageIndex !== -1) {
        // Vérifier qu'aucune opération Poinçonnage ou Pliage n'est avant Cisaillage
        for (let i = 0; i < cisaillageIndex; i++) {
            const op = operations[i];
            if (op.type === 'Poinçonnage' || op.type === 'Pliage') {
                return {
                    valid: false,
                    message: `⛔ ORDRE DE PRODUCTION INVALIDE\n\n"${op.type}" ne peut pas être avant "Cisaillage".\n\nCisaillage doit toujours être la première opération.`
                };
            }
        }
    }

    // Poinçonnage et Pliage peuvent être dans n'importe quel ordre entre eux
    return { valid: true, message: '' };
}

/**
 * 🔒 RÈGLE: Vérifie si une opération peut être placée à une date donnée
 * Cisaillage doit SE TERMINER avant Poinçonnage et Pliage
 * Poinçonnage et Pliage peuvent se chevaucher (parallèle autorisé)
 * @param {Object} commande - La commande
 * @param {Object} operation - L'opération à placer
 * @param {number} targetWeek - Semaine cible
 * @param {string} targetDay - Jour cible
 * @param {string} targetStartTime - Heure de début (optionnel, par défaut '09:00')
 * @returns {Object} { valid: boolean, message: string }
 */
function canPlaceOperation(commande, operation, targetWeek, targetDay, targetStartTime = '09:00', targetYear = anneeSelectionnee) {
    const operations = commande.operations;
    const currentType = operation.type;

    // Helper: Vérifie si deux opérations peuvent se chevaucher (parallèle autorisé)
    const isParallelAllowed = (type1, type2) => {
        return (type1 === 'Poinçonnage' || type1 === 'Pliage') &&
               (type2 === 'Poinçonnage' || type2 === 'Pliage');
    };

    // Calculer la date de début cible AVEC L'ANNÉE CIBLE
    const targetStartDate = getDateFromWeekDay(targetWeek, targetDay, targetStartTime, targetYear);

    // Calculer la date de fin approximative (on utilisera la durée de l'opération)
    const targetEndDate = new Date(targetStartDate);
    targetEndDate.setHours(targetEndDate.getHours() + operation.dureeTotal);

    // 🔒 RÈGLE 1: Si Cisaillage est placé et on place Poinçonnage/Pliage, Cisaillage doit être terminé
    if (currentType === 'Poinçonnage' || currentType === 'Pliage') {
        const cisaillageOp = operations.find(op => op.type === 'Cisaillage');

        if (cisaillageOp && cisaillageOp.slots && cisaillageOp.slots.length > 0) {
            // Trouver la date de fin de Cisaillage
            const cisaillageLastSlot = [...cisaillageOp.slots].sort((a,b) => {
                if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
                if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                return a.heureFin.localeCompare(b.heureFin);
            }).pop();

            const cisaillageEndDate = new Date(cisaillageLastSlot.dateFin || getDateFromWeekDay(cisaillageLastSlot.semaine, cisaillageLastSlot.jour, cisaillageLastSlot.heureFin));

            // Comparaison stricte: début actuel doit être >= fin Cisaillage
            if (targetStartDate < cisaillageEndDate) {
                const timeDiff = Math.round((cisaillageEndDate - targetStartDate) / (1000 * 60));
                const endHourFloat = parseInt(cisaillageLastSlot.heureFin.split(':')[0]) + parseInt(cisaillageLastSlot.heureFin.split(':')[1]) / 60;
                const suggestedHour = Math.ceil(endHourFloat);
                const suggestedTime = `${suggestedHour.toString().padStart(2, '0')}:00`;

                return {
                    valid: false,
                    message: `⛔ ORDRE CHRONOLOGIQUE INVALIDE\n\n"${operation.type}" ne peut pas commencer AVANT la fin de "Cisaillage"\n\n📅 Cisaillage se termine:\n   → S${cisaillageLastSlot.semaine} ${cisaillageLastSlot.jour} à ${cisaillageLastSlot.heureFin}\n\n📅 ${operation.type} commence:\n   → S${targetWeek} ${targetDay} à ${targetStartTime}\n\n⏰ Conflit: ${timeDiff} minutes de chevauchement\n\n💡 Solution: Placez "${operation.type}" à partir de ${suggestedTime}`
                };
            }
        }
    }

    // 🔒 RÈGLE 2: Si on place Cisaillage, il doit se terminer avant Poinçonnage ET Pliage
    if (currentType === 'Cisaillage') {
        // Vérifier contre Poinçonnage
        const poinconnageOp = operations.find(op => op.type === 'Poinçonnage');
        if (poinconnageOp && poinconnageOp.slots && poinconnageOp.slots.length > 0) {
            const poinconnageFirstSlot = [...poinconnageOp.slots].sort((a,b) => {
                if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
                if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                return a.heureDebut.localeCompare(b.heureDebut);
            })[0];

            const poinconnageStartDate = new Date(poinconnageFirstSlot.dateDebut || getDateFromWeekDay(poinconnageFirstSlot.semaine, poinconnageFirstSlot.jour, poinconnageFirstSlot.heureDebut));

            if (targetEndDate > poinconnageStartDate) {
                return {
                    valid: false,
                    message: `⛔ ORDRE CHRONOLOGIQUE INVALIDE\n\n"Cisaillage" doit SE TERMINER AVANT le début de "Poinçonnage"\n\n📅 Poinçonnage commence:\n   → S${poinconnageFirstSlot.semaine} ${poinconnageFirstSlot.jour} à ${poinconnageFirstSlot.heureDebut}\n\n💡 Solution: Placez "Cisaillage" plus tôt`
                };
            }
        }

        // Vérifier contre Pliage
        const pliageOp = operations.find(op => op.type === 'Pliage');
        if (pliageOp && pliageOp.slots && pliageOp.slots.length > 0) {
            const pliageFirstSlot = [...pliageOp.slots].sort((a,b) => {
                if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
                if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                return a.heureDebut.localeCompare(b.heureDebut);
            })[0];

            const pliageStartDate = new Date(pliageFirstSlot.dateDebut || getDateFromWeekDay(pliageFirstSlot.semaine, pliageFirstSlot.jour, pliageFirstSlot.heureDebut));

            if (targetEndDate > pliageStartDate) {
                return {
                    valid: false,
                    message: `⛔ ORDRE CHRONOLOGIQUE INVALIDE\n\n"Cisaillage" doit SE TERMINER AVANT le début de "Pliage"\n\n📅 Pliage commence:\n   → S${pliageFirstSlot.semaine} ${pliageFirstSlot.jour} à ${pliageFirstSlot.heureDebut}\n\n💡 Solution: Placez "Cisaillage" plus tôt`
                };
            }
        }
    }

    // NOTE: Poinçonnage et Pliage peuvent se chevaucher - pas de vérification entre eux
    return { valid: true, message: '' };
}

/**
 * Helper: Convertir semaine/jour/heure en Date
 */
function getDateFromWeekDay(weekNumber, dayName, timeStr, year = null) {
    const targetYear = year || (typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : new Date().getFullYear());
    const simple = new Date(targetYear, 0, 1 + (weekNumber - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = new Date(simple);
    if (dow <= 4)
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    const dayIndex = DAYS_OF_WEEK.indexOf(dayName);
    const targetDate = new Date(ISOweekStart);
    targetDate.setDate(ISOweekStart.getDate() + dayIndex);

    const [hours, minutes] = timeStr.split(':');
    targetDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    return targetDate;
}

/**
 * Helper: Obtenir toutes les opérations d'une commande
 */
function getCommandeOperations(commandeId) {
    const cmd = commandesDemo.find(c => c.id === commandeId);
    return cmd ? cmd.operations : [];
}

// ===================================
// UI Rendering - Vue Semaine
// ===================================

/**
 * Render week view with Navigation
 */
function renderVueSemaine() {
    const container = document.getElementById('planningContainer');
    
    // Calculate the 3 weeks to display
    const weeksToDisplay = [];
    let tempWeek = semaineSelectionnee;
    let tempYear = anneeSelectionnee;

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
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(-1)">❮ Précédent</button>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-weight:bold; font-size:1.1em;">Planning ${anneeSelectionnee}</span>
                <input type="date" class="form-control" style="width:auto; padding:2px 5px;" 
                       onchange="goToWeekFromDate(this.value)" 
                       title="Aller à une date spécifique">
            </div>
            <div>
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(1)">Suivant ❯</button>
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

    // === LIGNE "À PLACER" : Commandes affectées mais non encore planifiées ===
    html += '<div class="semaine-row semaine-row-aplacer">';
    html += '<div class="machine-cell"><div class="machine-name">📋 À placer</div></div>';

    weeksToDisplay.forEach((item, index) => {
        const weekSeparatorClass = index > 0 ? 'week-separator' : '';
        const commandesAffectees = getCommandesAffecteesNonPlacees(item.week, item.year);

        // Calculer la capacité globale de la semaine
        const capaciteGlobale = calculerCapaciteSemaineGlobale(item.week, item.year);
        const capacityClass = getCapacityColorClass(capaciteGlobale.pourcentage);

        html += `<div class="week-cell week-cell-aplacer drop-zone-semaine ${weekSeparatorClass}" data-week="${item.week}" data-year="${item.year}">`;

        // Jauge de capacité globale
        html += `
            <div class="week-capacity-global">
                <div class="capacity-bar-global">
                    <div class="capacity-fill ${capacityClass}" style="width: ${Math.min(100, capaciteGlobale.pourcentage)}%"></div>
                </div>
                <span class="capacity-label-global" title="Placées: ${formatHours(capaciteGlobale.heuresPlacees)} | À placer: ${formatHours(capaciteGlobale.heuresNonPlacees)} | Capacité: ${formatHours(capaciteGlobale.capaciteTotale)}">
                    ${formatHours(capaciteGlobale.heuresAffectees)} / ${formatHours(capaciteGlobale.capaciteTotale)} (${capaciteGlobale.pourcentage}%)
                </span>
            </div>
        `;

        // Badges des commandes affectées
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
                          title="${cmd.client} - Livraison: ${formatDate(cmd.dateLivraison)} (Glisser vers sidebar pour désaffecter)">
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
    ALL_MACHINES.forEach(machine => {
        html += '<div class="semaine-row">';

        // Machine name only (capacity is now shown per week cell)
        html += `
            <div class="machine-cell">
                <div class="machine-name">${machine}</div>
            </div>
        `;

        // Week cells
        weeksToDisplay.forEach((item, index) => {
            // Get all commands for this machine/week
            const placedOrders = getPlacedOrders();
            const commandsInWeek = placedOrders.filter(cmd =>
                cmd.operations.some(op =>
                    op.slots.some(slot => {
                        if (slot.machine !== machine || slot.semaine !== item.week) return false;

                        // 🔒 CRITICAL: Filter by year to avoid showing operations from different years
                        const slotYear = getISOWeekYear(slot.dateDebut);
                        return slotYear === item.year;
                    })
                )
            );

            // Add week-separator class to first cell of each week
            const weekSeparatorClass = index > 0 ? 'week-separator' : '';

            // Calculate capacity for this specific week
            const capacity = calculerCapaciteMachine(machine, item.week, item.year);
            const weekCapacityClass = getCapacityColorClass(capacity.pourcentage);

            html += `<div class="week-cell drop-zone-semaine ${weekSeparatorClass}" data-machine="${machine}" data-week="${item.week}" data-year="${item.year}">`;

            // Capacity gauge at top of cell
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
                        <span class="badge-client">${cmd.client}</span>
                    </span>
                `;
            });

            // Display System Events (Maintenance/Closure) - utilise les événements expansés pour supporter v2
            const expandedEvents = getExpandedSystemEvents();
            const weekEvents = expandedEvents.filter(e => {
                if ((e.machine !== machine && e.machine !== 'ALL') || e.week !== item.week) return false;

                // Filter by year to avoid showing events from different years
                const eventYear = e.year || getISOWeekYear(e.dateStr);
                return eventYear === item.year;
            });

            weekEvents.forEach(e => {
                const label = e.type === 'fermeture' ? 'FERMÉ' : 'MAINT';
                const style = e.type === 'fermeture'
                    ? 'background:#f8d7da; color:#721c24; border:1px solid #f5c6cb;'
                    : 'background:#fff3cd; color:#856404; border:1px solid #ffeeba;';

                html += `
                    <span class="command-badge system-event-badge" style="${style} display:block; margin-top:2px; font-weight:bold;">
                        <span class="badge-id" style="width:100%; text-align:center;">${label}</span>
                        <span class="badge-client" style="width:100%; text-align:center;">${e.day.substring(0,3)} ${e.startTime}-${e.endTime}</span>
                    </span>
                `;
            });

            html += '</div>';
        });

        html += '</div>';
    });

    html += '</div>';
    container.innerHTML = html;

    // Add click handlers on week cells
    document.querySelectorAll('.week-cell').forEach(cell => {
        cell.addEventListener('click', (e) => {
            // Ignorer si on vient de faire un drop
            if (e.target.closest('.dragging')) return;

            const week = parseInt(e.currentTarget.getAttribute('data-week'));
            const year = parseInt(e.currentTarget.getAttribute('data-year'));

            // Update both week and year global state
            semaineSelectionnee = week;
            anneeSelectionnee = year;

            toggleVue('journee');
        });
    });

    // Add drag & drop handlers for week cells (affectation commandes)
    document.querySelectorAll('.drop-zone-semaine').forEach(cell => {
        cell.addEventListener('dragover', (e) => {
            // Accepter seulement les commandes (pas les opérations)
            if (draggedOperation && draggedOperation.isCommandeAffectation) {
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
}

// ===================================
// UI Rendering - Vue Journée
// ===================================

/**
 * Render day view
 */
function renderVueJournee() {
    const container = document.getElementById('planningContainer');
    const weekRange = getWeekDateRange(semaineSelectionnee);

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
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(-1)">❮ Précédente</button>
                <h2 style="margin:0;">Semaine ${semaineSelectionnee} <small>${anneeSelectionnee}</small> <span style="font-size:0.7em; font-weight:normal; color:var(--color-text-secondary);">(${weekRange.start}-${weekRange.end} ${weekRange.month})</span></h2>
                <button class="btn btn-sm btn-secondary" onclick="changeWeek(1)">Suivante ❯</button>
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
                <button class="btn btn-sm btn-secondary" id="btnClearSearch" title="Effacer la recherche" style="display:none;">✕</button>
            </div>
        </div>
    `;

    // Function to generate day headers
    const generateDayHeaders = () => {
        let headersHtml = '<div class="day-headers">';
        headersHtml += '<div class="day-header-cell machine-col">Machine</div>';
        DAYS_OF_WEEK.forEach((day, index) => {
            const capacity = HOURS_PER_DAY[day];

            // Calculer la date pour ce jour
            const dateObj = getDateFromWeekDay(semaineSelectionnee, day, "00:00", anneeSelectionnee);
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
    if (!isPrintMode) {
        html += generateDayHeaders();
    }

    // Rows for each machine
    ALL_MACHINES.forEach(machine => {
        // In print mode, create two rows per machine (top half and bottom half)
        const rowsToPrint = isPrintMode ? ['print-row-top', 'print-row-bottom'] : [''];

        rowsToPrint.forEach((printClass, rowIndex) => {
            // In print mode, show headers before each row (matin and après-midi)
            if (isPrintMode) {
                html += generateDayHeaders();
            }

            html += `<div class="journee-row ${printClass}">`;

            const machineSuffix = isPrintMode ? (rowIndex === 0 ? ' - MATIN' : ' - APRÈS-MIDI') : '';
            html += `<div class="machine-cell"><div class="machine-name">${machine}${machineSuffix}</div></div>`;

        // Day cells with hourly time slots
        DAYS_OF_WEEK.forEach(day => {
            const capacityInfo = calculerCapaciteJour(machine, day, semaineSelectionnee, anneeSelectionnee);
            // Use the new capacityClass from the updated function
            const capacityClass = capacityInfo.capacityClass; 
            const isOverCapacity = capacityInfo.isOvertime;
            
            // Calculer la date pour ce jour
            const dateObj = getDateFromWeekDay(semaineSelectionnee, day, "00:00", anneeSelectionnee);
            const dayNum = dateObj.getDate().toString().padStart(2, '0');
            const monthNum = (dateObj.getMonth() + 1).toString().padStart(2, '0');
            const formattedDate = `${dayNum}/${monthNum}`;

            // Timeline hours: dynamique basé sur SCHEDULE_CONFIG (multi-equipes)
            const globalSchedule = getGlobalScheduleRangeForDay(day);
            const startHourTimeline = globalSchedule.globalStart;
            const endHourTimeline = globalSchedule.globalEnd;
            const interShiftGaps = globalSchedule.gaps;
            const daySchedule = getScheduleForDay(day); // Pour compatibilite avec le code existant

            html += `
                <div class="day-cell ${day === 'Vendredi' ? 'friday' : ''} ${getMachineTypeClass(machine)}"
                     data-machine="${machine}"
                     data-day="${day}"
                     data-week="${semaineSelectionnee}">
                     
                    <!-- New Top Stats Header -->
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
                        if (slot.machine === machine && slot.jour === day && slot.semaine === semaineSelectionnee) {
                            // 🔒 CRITICAL: Filter by year to avoid showing operations from different years
                            const slotYear = getISOWeekYear(slot.dateDebut);
                            if (slotYear !== anneeSelectionnee) {
                                return; // Skip this slot, wrong year
                            }

                            slots.push({
                                ...slot,
                                commandeId: cmd.id,
                                client: cmd.client,
                                refCdeClient: cmd.refCdeClient || '',
                                operationType: op.type,
                                commandeRef: cmd,
                                operationRef: op,
                                overtime: slot.overtime || false // Ensure property exists
                            });
                        }
                    });
                });
            });

            // Sort by heureDebut
            slots.sort((a, b) => a.heureDebut.localeCompare(b.heureDebut));

            // Create a container with absolute positioning for the timeline
            html += '<div class="timeline-container">';

            // Create hourly time grid (background)
            html += '<div class="time-grid">';
            
            // Generate time slots based on day (30 min intervals) - dynamique multi-equipes
            for (let h = startHourTimeline; h < endHourTimeline; h += 0.5) {
                const hour = Math.floor(h);
                const minute = (h % 1 === 0.5) ? '30' : '00';
                const timeSlot = `${hour.toString().padStart(2, '0')}:${minute}`;
                const isHalf = (h % 1 === 0.5);

                html += `
                    <div class="time-slot drop-zone ${isHalf ? 'half-hour' : 'full-hour'}"
                         data-machine="${machine}"
                         data-day="${day}"
                         data-week="${semaineSelectionnee}"
                         data-hour="${h}"
                         data-time="${timeSlot}">
                        <div class="time-label">${timeSlot}</div>
                    </div>
                `;
            }
            html += '</div>';

            // Overlay operations with absolute positioning
            html += '<div class="operations-overlay">';

            // 0. Add System Events (Maintenance / Closure) - utilise les événements expansés pour supporter v2
            getExpandedSystemEvents()
                .filter(e => {
                    if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== day || e.week !== semaineSelectionnee) return false;

                    // Filter by year to avoid showing events from different years
                    const eventYear = e.year || getISOWeekYear(e.dateStr);
                    return eventYear === anneeSelectionnee;
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
                            <div style="font-weight: normal; font-size: 0.9em;">${e.reason}</div>
                        </div>
                    `;
                });

            // 1. Add ALL blocked zones visual (pauses dynamiques + gaps inter-equipes)
            const blockedZonesForRender = getBlockedZonesForDay(day);
            blockedZonesForRender.forEach(zone => {
                const topZone = (zone.start - startHourTimeline) * 60;
                const heightZone = (zone.end - zone.start) * 60;

                if (zone.type === 'break') {
                    // Pause (dejeuner, cafe, etc.)
                    html += `<div class="lunch-break" style="top: ${topZone}px; height: ${heightZone}px;"
                             title="${zone.name} (${decimalToTimeString(zone.start)} - ${decimalToTimeString(zone.end)})"></div>`;
                } else if (zone.type === 'inter-shift-gap') {
                    // Gap inter-equipes
                    html += `<div class="inter-shift-gap" style="top: ${topZone}px; height: ${heightZone}px;"
                             title="${zone.name} (${decimalToTimeString(zone.start)} - ${decimalToTimeString(zone.end)})"></div>`;
                }
            });

            // 2. Add Overtime Separator - dynamique basé sur SCHEDULE_CONFIG (multi-equipes)
            globalSchedule.shifts.forEach(shift => {
                // Recuperer la fin normale (sans heures sup) pour cette equipe
                const shiftConfig = scheduleConfig.shifts ? scheduleConfig.shifts.find(s => s.id === shift.shiftId) : null;
                if (shiftConfig && shiftConfig.schedules && shiftConfig.schedules[day]) {
                    const normalEnd = timeStringToDecimal(shiftConfig.schedules[day].end);
                    const separatorTop = (normalEnd - startHourTimeline) * 60;
                    html += `<div class="overtime-separator" style="top: ${separatorTop}px;"
                             title="Fin ${shift.shiftName}"></div>`;
                }
            });
            // Fallback si pas de config shifts (ancien systeme)
            if (!scheduleConfig.shifts || scheduleConfig.shifts.length === 0) {
                const separatorTime = daySchedule.standardEnd;
                const separatorTop = (separatorTime - startHourTimeline) * 60;
                html += `<div class="overtime-separator" style="top: ${separatorTop}px;"></div>`;
            }

            // 🔴 Add Current Time Line (Red Line)
            // Check if this column represents "Today"
            const today = new Date();
            const currentWeekNum = getWeekNumber(today);
            // Map JS day (0=Sun, 1=Mon) to our DAYS_OF_WEEK strings
            const dayMap = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
            const currentDayName = dayMap[today.getDay()];

            if (semaineSelectionnee === currentWeekNum && day === currentDayName) {
                const nowHour = today.getHours();
                const nowMin = today.getMinutes();
                const nowDecimal = nowHour + (nowMin / 60);
                // Extended range for overtime view
                if (nowDecimal >= startHourTimeline && nowDecimal <= (endHourTimeline + 2)) {
                    const topPos = (nowDecimal - startHourTimeline) * 60;
                    html += `<div class="current-time-line" style="top: ${topPos}px;" title="Il est ${nowHour}h${nowMin}"></div>`;
                }
            }

            slots.forEach(slot => {
                const startHour = parseInt(slot.heureDebut.split(':')[0]);
                const startMinute = parseInt(slot.heureDebut.split(':')[1]);
                const startDecimal = startHour + (startMinute / 60);

                const endHourParts = slot.heureFin.split(':');
                const endDecimal = parseInt(endHourParts[0]) + parseInt(endHourParts[1]) / 60;

                // Trouver les zones bloquees que ce slot traverse
                const crossedZones = blockedZonesForRender.filter(zone =>
                    startDecimal < zone.end && endDecimal > zone.start
                );

                const renderSlotDiv = (sTime, eTime, isSplitPart = false) => {
                    const startOffsetHours = sTime - startHourTimeline;
                    const topPosition = Math.round(startOffsetHours * 60);
                    const heightInPixels = Math.round((eTime - sTime) * 60);

                    const typeClass = slot.operationType.toLowerCase().replace('ç', 'c').replace('é', 'e');
                    const slotId = `${slot.semaine}_${slot.jour}_${slot.heureDebut}`;

                    // Add overtime class if flag is true
                    const extraClass = slot.overtime ? 'overtime' : '';

                    return `
                        <div class="operation-slot ${typeClass} ${extraClass} draggable"
                             draggable="true"
                             data-commande-id="${slot.commandeId}"
                             data-client="${slot.client}"
                             data-operation-type="${slot.operationType}"
                             data-slot-id="${slotId}"
                             data-operation='${JSON.stringify({ commandeId: slot.commandeId, operationType: slot.operationType, slotId: slotId }).replace(/'/g, "&#39;")}'
                             style="position: absolute; top: ${topPosition}px; left: 5px; right: 5px; height: ${heightInPixels}px; min-height: ${heightInPixels}px; z-index: ${slot.overtime ? 20 : 10};">

                            ${slot.overtime ? '<div class="overtime-indicator"></div>' : ''}

                            <div class="slot-top-row" style="display: flex; justify-content: space-between; align-items: center; width: 100%; font-size: 0.85em;">
                                <span class="slot-time" style="font-weight: bold;">${slot.heureDebut}-${slot.heureFin}</span>
                                <span class="slot-client" style="font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 5px; flex: 1; text-align: right;">${slot.client}</span>
                            </div>
                            ${slot.refCdeClient ? `<div class="slot-ref" style="font-size: 1.1em; font-weight: 800; color: #fff; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${slot.refCdeClient}</div>` : ''}
                            <div class="slot-label" style="text-align: center; width: 100%; font-weight: 800; font-size: 1.1em; margin-top: 2px;">${slot.commandeId.substring(5)}</div>
                        </div>
                    `;
                };

                if (crossedZones.length > 0) {
                    // Render split parts around blocked zones
                    let currentPos = startDecimal;
                    for (const zone of crossedZones) {
                        // Part before the zone
                        if (currentPos < zone.start) {
                            html += renderSlotDiv(currentPos, zone.start, true);
                        }
                        // Skip the zone
                        currentPos = zone.end;
                    }
                    // Part after all zones
                    if (currentPos < endDecimal) {
                        html += renderSlotDiv(currentPos, endDecimal, true);
                    }
                } else {
                    // Render Normal (no blocked zone crossed)
                    html += renderSlotDiv(startDecimal, endDecimal);
                }
            });
            html += '</div>';

            html += '</div>'; // Close timeline-container

            html += `
                    </div>
                    <!-- Old footer removed -->
                </div>
            `;
        }); // Close DAYS_OF_WEEK.forEach

            html += '</div>'; // Close journee-row
        }); // Close rowsToPrint.forEach
    }); // Close ALL_MACHINES.forEach

    html += '</div>';
    container.innerHTML = html;

    // Add event listeners
    document.getElementById('btnBackToWeek').addEventListener('click', () => {
        toggleVue('semaine');
    });

    // Search functionality
    const searchInput = document.getElementById('searchOperations');
    const clearSearchBtn = document.getElementById('btnClearSearch');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim().toLowerCase();

            // Show/hide clear button
            clearSearchBtn.style.display = query ? 'inline-block' : 'none';

            // Clear previous highlights
            document.querySelectorAll('.operation-slot').forEach(op => {
                op.classList.remove('search-highlight', 'search-dimmed');
            });

            if (query) {
                // Search and highlight
                let foundCount = 0;
                document.querySelectorAll('.operation-slot').forEach(op => {
                    const commandeId = op.getAttribute('data-commande-id') || '';
                    const client = op.getAttribute('data-client') || '';

                    // Check if matches
                    if (commandeId.toLowerCase().includes(query) || client.toLowerCase().includes(query)) {
                        op.classList.add('search-highlight');
                        foundCount++;
                    } else {
                        op.classList.add('search-dimmed');
                    }
                });

                console.log(`🔍 Recherche: "${query}" - ${foundCount} résultat(s)`);

                // Show message if no results
                if (foundCount === 0) {
                    Toast.info(`Aucune opération trouvée pour "${query}"`);
                }
            }
        });

        // Clear search
        clearSearchBtn.addEventListener('click', () => {
            searchInput.value = '';
            searchInput.dispatchEvent(new Event('input'));
            searchInput.focus();
        });
    }

    initDragAndDrop();
}

// ===================================
// UI Rendering - Commandes Non Placées
// ===================================

// ===================================
// Sidebar Workflow 2 étapes
// ===================================

/**
 * Fonction de dispatch pour la sidebar selon la vue active
 * @param {string} searchQuery - Requête de recherche optionnelle
 */
function renderSidebarContent(searchQuery = '') {
    const titleEl = document.querySelector('.sidebar-title');

    if (vueActive === 'semaine') {
        // Vue Semaine: afficher les commandes à affecter
        if (titleEl) titleEl.textContent = 'Commandes à affecter';
        renderSidebarVueSemaine(searchQuery);
    } else if (vueActive === 'journee') {
        // Vue Journée: afficher les opérations de la semaine sélectionnée
        if (titleEl) titleEl.textContent = `Opérations S${semaineSelectionnee}`;
        renderSidebarVueJournee(searchQuery);
    } else {
        // Vue Liste ou autre: vider la sidebar
        if (titleEl) titleEl.textContent = 'Commandes';
        const container = document.getElementById('unplacedOrdersContainer');
        if (container) container.innerHTML = '<p class="no-orders">Sélectionnez une vue pour voir les commandes</p>';
    }
}

/**
 * Sidebar Vue Semaine - Affiche les commandes non affectées (complètes)
 * Drag & Drop vers la grille semaine = affecter à cette semaine
 * @param {string} searchQuery - Requête de recherche optionnelle
 */
function renderSidebarVueSemaine(searchQuery = '') {
    const container = document.getElementById('unplacedOrdersContainer');
    const unaffectedOrders = getCommandesNonAffectees();

    // Trier par urgence (date de livraison)
    unaffectedOrders.sort((a, b) => {
        const dateA = a.dateLivraison ? new Date(a.dateLivraison) : new Date(8640000000000000);
        const dateB = b.dateLivraison ? new Date(b.dateLivraison) : new Date(8640000000000000);
        if (isNaN(dateA.getTime())) return 1;
        if (isNaN(dateB.getTime())) return -1;
        return dateA - dateB;
    });

    // Filtrage recherche
    let filteredOrders = unaffectedOrders;
    if (searchQuery && searchQuery.trim() !== '') {
        filteredOrders = filterCommandesBySearch(unaffectedOrders, searchQuery);
        updateSearchResultCount(filteredOrders.length, unaffectedOrders.length);
    }

    if (unaffectedOrders.length === 0) {
        container.innerHTML = '<p class="no-orders">Toutes les commandes sont affectées à une semaine</p>';
        return;
    }

    if (searchQuery && searchQuery.trim() !== '' && filteredOrders.length === 0) {
        container.innerHTML = `
            <div class="no-search-results">
                <svg viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                    <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>Aucun résultat pour <span class="search-term">"${escapeHtml(searchQuery)}"</span></p>
            </div>
        `;
        return;
    }

    let html = '';

    // Zone de drop pour désaffecter des commandes (glisser depuis "À placer")
    html += `
        <div class="sidebar-dropzone-desaffect" id="dropzoneDesaffect">
            <div class="dropzone-content">
                <span class="dropzone-icon">📤</span>
                <span class="dropzone-text">Glisser ici pour désaffecter</span>
            </div>
        </div>
    `;

    filteredOrders.forEach(cmd => {
        const urgencyLevel = getUrgencyLevel(cmd.dateLivraison);
        const livraison = new Date(cmd.dateLivraison);
        const daysUntil = Math.ceil((livraison - currentTime) / (1000 * 60 * 60 * 24));

        // Calculer le total des heures non placées
        const totalHeures = cmd.operations
            .filter(op => !op.slots || op.slots.length === 0)
            .reduce((sum, op) => sum + op.dureeTotal, 0);

        // Badges des opérations (preview)
        const opsHtml = cmd.operations.map(op => {
            const placed = op.slots && op.slots.length > 0;
            const typeClass = op.type.toLowerCase().replace('ç', 'c');
            return `<span class="op-badge ${typeClass}" style="opacity: ${placed ? '0.5' : '1'}">
                        ${op.type.substring(0, 3)} ${formatHours(op.dureeTotal)}${placed ? ' ✓' : ''}
                    </span>`;
        }).join('');

        html += `
            <div class="commande-card-semaine ${urgencyLevel} draggable-commande"
                 draggable="true"
                 data-commande-id="${cmd.id}"
                 data-commande-affectation='${JSON.stringify({ commandeId: cmd.id, fromSidebar: true }).replace(/'/g, "&#39;")}'>
                <div class="commande-header-semaine">
                    <span class="drag-handle">⋮⋮</span>
                    <span class="commande-id">${cmd.id}</span>
                    <span class="commande-client">${cmd.client}</span>
                </div>
                <div class="commande-info-semaine">
                    <div class="info-row">
                        <span>Ref: ${cmd.refCdeClient || '-'}</span>
                        <span>J-${daysUntil > 0 ? daysUntil : 0}</span>
                    </div>
                    <div class="info-row">
                        <span>Livraison: ${formatDate(cmd.dateLivraison)}</span>
                        <span>Total: ${formatHours(totalHeures)}</span>
                    </div>
                    <div class="operations-preview">
                        ${opsHtml}
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    // Initialiser drag & drop pour commandes
    document.querySelectorAll('.draggable-commande').forEach(card => {
        card.addEventListener('dragstart', handleCommandeDragStart);
        card.addEventListener('dragend', handleDragEnd);
    });
}

/**
 * Sidebar Vue Journée - Affiche les opérations affectées à la semaine courante
 * (anciennement renderCommandesNonPlacees adapté pour le workflow 2 étapes)
 * @param {string} searchQuery - Requête de recherche optionnelle
 */
function renderSidebarVueJournee(searchQuery = '') {
    const container = document.getElementById('unplacedOrdersContainer');
    const operationsData = getOperationsAffecteesSemaine(semaineSelectionnee, anneeSelectionnee);

    // Trier par urgence
    operationsData.sort((a, b) => {
        const dateA = a.commande.dateLivraison ? new Date(a.commande.dateLivraison) : new Date(8640000000000000);
        const dateB = b.commande.dateLivraison ? new Date(b.commande.dateLivraison) : new Date(8640000000000000);
        return dateA - dateB;
    });

    // Filtrage recherche
    let filteredData = operationsData;
    if (searchQuery && searchQuery.trim() !== '') {
        const query = searchQuery.toLowerCase().trim();
        filteredData = operationsData.filter(item =>
            item.commande.id.toLowerCase().includes(query) ||
            item.commande.client.toLowerCase().includes(query)
        );
        updateSearchResultCount(filteredData.length, operationsData.length);
    }

    if (operationsData.length === 0) {
        container.innerHTML = `
            <p class="no-orders">
                Aucune opération affectée à S${semaineSelectionnee}
                <br><small style="color: var(--color-text-secondary);">Affectez des commandes depuis la vue 3 Semaines</small>
            </p>
        `;
        return;
    }

    if (searchQuery && searchQuery.trim() !== '' && filteredData.length === 0) {
        container.innerHTML = `
            <div class="no-search-results">
                <svg viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                    <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>Aucun résultat pour <span class="search-term">"${escapeHtml(searchQuery)}"</span></p>
            </div>
        `;
        return;
    }

    // Regrouper par commande pour l'affichage
    const groupedByCommande = {};
    filteredData.forEach(item => {
        if (!groupedByCommande[item.commande.id]) {
            groupedByCommande[item.commande.id] = {
                commande: item.commande,
                operations: []
            };
        }
        groupedByCommande[item.commande.id].operations.push(item.operation);
    });

    let html = '';

    Object.values(groupedByCommande).forEach(group => {
        const cmd = group.commande;
        const urgencyLevel = getUrgencyLevel(cmd.dateLivraison);
        const daysUntil = Math.ceil((new Date(cmd.dateLivraison) - currentTime) / (1000 * 60 * 60 * 24));

        // Générer le HTML des opérations (draggable)
        let operationsHtml = '';
        group.operations.forEach(op => {
            const typeClass = op.type.toLowerCase().replace('ç', 'c').replace('é', 'e');
            const hasOverride = hasTimeOverride(op);
            const originalDuration = op.dureeOriginal || op.dureeTotal;

            operationsHtml += `
                <div class="operation-item-sidebar ${typeClass} draggable-from-sidebar ${hasOverride ? 'has-override' : ''}"
                     draggable="true"
                     data-commande-id="${cmd.id}"
                     data-operation-type="${op.type}"
                     data-operation-duration="${op.dureeTotal}"
                     data-sidebar-operation='${JSON.stringify({ commandeId: cmd.id, operationType: op.type, duration: op.dureeTotal, fromSidebar: true }).replace(/'/g, "&#39;")}'>
                    <div class="op-icon">⋮⋮</div>
                    <div class="op-info">
                        <div class="op-type">
                            ${op.type}
                            <span style="font-weight:normal; font-size:0.85em; color:#6c757d; margin-left:4px;">
                                (${cmd.client})
                            </span>
                        </div>
                        <div class="op-duration ${hasOverride ? 'overridden' : ''}"
                             onclick="event.stopPropagation(); showTimeEditPopup('${cmd.id}', '${op.type}', ${op.dureeTotal}, ${originalDuration}, this)"
                             title="${hasOverride ? 'Temps modifié (Original: ' + formatHours(originalDuration) + ')' : 'Cliquer pour modifier le temps'}">
                            ${formatHours(op.dureeTotal)}${hasOverride ? '<span class="override-indicator">*</span>' : ''}
                        </div>
                    </div>
                </div>
            `;
        });

        html += `
            <div class="commande-non-placee ${urgencyLevel}">
                <div class="commande-header">
                    <span class="commande-id">${cmd.id}</span>
                    <span class="commande-client">${cmd.client}</span>
                    <button class="btn-desaffecter" onclick="desaffecterCommande('${cmd.id}')" title="Retirer de la semaine ${semaineSelectionnee}">✕</button>
                </div>
                <div class="commande-details">
                    <div class="detail-item">
                        <strong>Ref:</strong> ${cmd.refCdeClient || '-'}
                    </div>
                    <div class="detail-item">
                        <strong>Livraison:</strong> ${formatDate(cmd.dateLivraison)} (J-${daysUntil > 0 ? daysUntil : 0})
                        ${urgencyLevel === 'urgente' ? ' ❌' : urgencyLevel === 'attention' ? ' ⚠️' : ' ✓'}
                    </div>
                    <div class="detail-item">
                        <strong>Opérations à placer:</strong>
                        <div class="operations-list-sidebar">
                            ${operationsHtml}
                        </div>
                    </div>
                </div>
                <div class="commande-actions">
                    <button class="btn btn-sm btn-primary" onclick="placerAutomatiquement('${cmd.id}')">
                        Placer automatiquement
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="openPlanifierSemiAutoModal('${cmd.id}', ${semaineSelectionnee}, ${anneeSelectionnee})">
                        Planifier
                    </button>
                </div>
            </div>
        `;
    });

    if (html === '') {
        container.innerHTML = '<p class="no-orders">Aucune opération à placer</p>';
    } else {
        container.innerHTML = html;

        // Initialiser drag pour opérations
        document.querySelectorAll('.draggable-from-sidebar').forEach(op => {
            op.addEventListener('dragstart', handleSidebarDragStart);
            op.addEventListener('dragend', handleDragEnd);
        });
    }
}

/**
 * Alias de compatibilité - redirige vers renderSidebarContent
 * Conservé pour ne pas casser les appels existants
 * @param {string} searchQuery - Optional search query to filter commands
 */
function renderCommandesNonPlacees(searchQuery = '') {
    renderSidebarContent(searchQuery);
}

/**
 * Filter commands based on search query
 * @param {Array} commands - Array of command objects
 * @param {string} searchQuery - Search term
 * @returns {Array} Filtered commands
 */
function filterCommandesBySearch(commands, searchQuery) {
    if (!searchQuery || searchQuery.trim() === '') {
        return commands;
    }

    const query = searchQuery.toLowerCase().trim();

    return commands.filter(cmd => {
        // Search in command ID
        const matchesId = cmd.id && cmd.id.toLowerCase().includes(query);

        // Search in client name
        const matchesClient = cmd.client && cmd.client.toLowerCase().includes(query);

        return matchesId || matchesClient;
    });
}

/**
 * Update search result count display
 * @param {number} matchCount - Number of matching commands
 * @param {number} totalCount - Total number of commands
 */
function updateSearchResultCount(matchCount, totalCount) {
    const countElement = document.getElementById('searchResultCount');

    if (!countElement) return;

    if (matchCount === totalCount) {
        countElement.style.display = 'none';
    } else {
        countElement.style.display = 'block';
        countElement.textContent = `${matchCount} résultat${matchCount > 1 ? 's' : ''} sur ${totalCount}`;
    }
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Initialize sidebar search functionality
 */
function initializeSidebarSearch() {
    const searchInput = document.getElementById('sidebarSearchInput');
    const clearBtn = document.getElementById('clearSidebarSearch');

    if (!searchInput || !clearBtn) {
        console.warn('Sidebar search elements not found');
        return;
    }

    // Search on input (debounced for performance)
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value;

        // Show/hide clear button
        clearBtn.style.display = query ? 'flex' : 'none';

        // Update global search query
        currentSearchQuery = query;

        // Debounce search for performance
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            renderCommandesNonPlacees(query);
        }, 150); // 150ms debounce
    });

    // Clear search
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        currentSearchQuery = '';
        document.getElementById('searchResultCount').style.display = 'none';
        renderCommandesNonPlacees('');
        searchInput.focus();
    });

    // Clear on Escape key
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            clearBtn.style.display = 'none';
            currentSearchQuery = '';
            document.getElementById('searchResultCount').style.display = 'none';
            renderCommandesNonPlacees('');
        }
    });
}

/**
 * Cascade Reschedule: Automatically moves subsequent operations if chronological order is broken
 * NOUVELLE RÈGLE: Cascade UNIQUEMENT si Cisaillage est modifié
 * Poinçonnage et Pliage peuvent se chevaucher, donc pas de cascade entre eux
 */
function replanifierOperationsSuivantes(cmd, modifiedOp) {
    // Ne cascader que si l'opération modifiée est Cisaillage
    if (modifiedOp.type !== 'Cisaillage') {
        return; // Pas de cascade pour Poinçonnage/Pliage car ils peuvent se chevaucher
    }

    const priority = ['Cisaillage', 'Poinçonnage', 'Pliage'];
    const startIdx = priority.indexOf(modifiedOp.type);

    if (startIdx === -1 || startIdx === priority.length - 1) return; // Last op or unknown

    let previousOp = modifiedOp;

    // Iterate through subsequent operations
    for (let i = startIdx + 1; i < priority.length; i++) {
        const currentType = priority[i];
        const currentOp = cmd.operations.find(o => o.type === currentType);
        
        // Skip if not present or not placed
        if (!currentOp || !currentOp.slots || currentOp.slots.length === 0) {
            previousOp = currentOp || previousOp; // Update ref if exists
            continue;
        }

        // 1. Get End Time of Previous Op (The Constraint)
        // We need the absolute latest end time across all slots of the previous op
        const prevSlots = [...previousOp.slots];
        if (prevSlots.length === 0) continue; // Should not happen if logic flows correctly
        
        prevSlots.sort((a,b) => {
            if (a.semaine !== b.semaine) return a.semaine - b.semaine;
            const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
            if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
            return a.heureFin.localeCompare(b.heureFin);
        });
        const lastPrevSlot = prevSlots[prevSlots.length - 1];

        // 2. Get Start Time of Current Op
        // We need the absolute earliest start time
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
                // Compare times
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
            
            // Unplan completely
            currentOp.slots = [];
            currentOp.statut = "Non placée";

            // Define constraint for new search
            const constraint = {
                week: lastPrevSlot.semaine,
                dayIndex: days.indexOf(lastPrevSlot.jour),
                timeStr: lastPrevSlot.heureFin
            };

            // Get available machines
            let machines = [];
            if (currentType === 'Cisaillage') machines = MACHINES.cisailles;
            else if (currentType === 'Poinçonnage') machines = MACHINES.poinconneuses;
            else if (currentType === 'Pliage') machines = MACHINES.plieuses;

            // Auto-place logic (similar to placerAutomatiquement)
            let remainingDuration = currentOp.dureeTotal;
            
            while (remainingDuration > 0.01) {
                const bestSlot = findBestMachineSlot(currentOp, cmd, machines, remainingDuration, constraint);
                
                if (!bestSlot) {
                    Toast.warning(`⚠️ Impossible de replacer ${currentType} automatiquement.`);
                    break;
                }

                const placedDuration = bestSlot.usableDuration;
                
                // Calculate Times
                const startParts = bestSlot.startTime.split(':');
                const startDec = parseInt(startParts[0]) + parseInt(startParts[1])/60;
                const endDec = startDec + placedDuration;
                const endH = Math.floor(endDec);
                const endM = Math.round((endDec - endH) * 60);
                const endTime = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;
                
                // Add slot
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

        // Update previousOp for next iteration (chain reaction)
        previousOp = currentOp;
    }
}

// ===================================
// Drag and Drop
// ===================================

/**
 * Initialize drag and drop
 */
function initDragAndDrop() {
    // Draggable elements
    document.querySelectorAll('.operation-slot.draggable').forEach(slot => {
        slot.addEventListener('dragstart', handleDragStart);
        slot.addEventListener('dragend', handleDragEnd);
    });

    // Drop zones
    document.querySelectorAll('.drop-zone').forEach(zone => {
        zone.addEventListener('dragover', handleDragOver);
        zone.addEventListener('drop', handleDrop);
        zone.addEventListener('dragleave', handleDragLeave);
    });

    // Sidebar Drop Zone (To unplan)
    const sidebarZone = document.getElementById('unplacedOrdersContainer');
    if (sidebarZone) {
        sidebarZone.addEventListener('dragover', handleDragOver);
        sidebarZone.addEventListener('drop', handleSidebarDrop);
        sidebarZone.addEventListener('dragleave', handleDragLeave);
    }

    // === Workflow 2 étapes: Badges "À placer" draggables pour désaffectation ===
    document.querySelectorAll('.command-badge-aplacer[draggable="true"]').forEach(badge => {
        badge.addEventListener('dragstart', handleDesaffectationDragStart);
        badge.addEventListener('dragend', handleDesaffectationDragEnd);
    });

    // Zone de drop pour désaffectation (dans sidebar vue semaine)
    const desaffectZone = document.getElementById('dropzoneDesaffect');
    if (desaffectZone) {
        desaffectZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('drag-over');
        });
        desaffectZone.addEventListener('dragleave', (e) => {
            e.currentTarget.classList.remove('drag-over');
        });
        desaffectZone.addEventListener('drop', handleDesaffectationDrop);
    }
}

/**
 * Handle drop on sidebar (Unplan operation)
 * Cascade UNIQUEMENT si on retire Cisaillage
 * Poinçonnage et Pliage peuvent être retirés individuellement
 */
function handleSidebarDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active'); // Ensure cleanup

    if (!draggedOperation) return;

    // We only care about operations dragged FROM the planning (not from sidebar itself)
    if (draggedOperation.fromSidebar) return;

    const cmd = commandes.find(c => c.id === draggedOperation.commandeId);
    if (!cmd) return;

    const operation = cmd.operations.find(op => op.type === draggedOperation.operationType);
    if (!operation) return;

    const operationType = operation.type;
    let removedCount = 0;

    // Cascade UNIQUEMENT si on retire Cisaillage
    if (operationType === 'Cisaillage') {
        if (!confirm(`Retirer Cisaillage de la commande ${cmd.id} ?\n\nCela retirera également Poinçonnage et Pliage.`)) {
            return;
        }

        // Retirer toutes les opérations
        cmd.operations.forEach(op => {
            if (op.slots && op.slots.length > 0) {
                // Supprimer les slots de Supabase
                if (op.id && supabaseClient) {
                    syncManager.deleteAllSlotsForOperation(op.id);
                }
                op.slots = [];
                op.statut = "Non placée";
                op.progressionReelle = 0;
                removedCount++;
            }
        });
    } else {
        // Poinçonnage ou Pliage : retirer uniquement cette opération
        if (!confirm(`Retirer ${operationType} de la commande ${cmd.id} ?`)) {
            return;
        }

        // Supprimer les slots de Supabase
        if (operation.id && supabaseClient) {
            syncManager.deleteAllSlotsForOperation(operation.id);
        }
        operation.slots = [];
        operation.statut = "Non placée";
        operation.progressionReelle = 0;
        removedCount = 1;
    }

    // Update main command status
    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
    const anyPlaced = cmd.operations.some(op => op.slots && op.slots.length > 0);

    if (allPlaced) cmd.statut = "Planifiée";
    else if (anyPlaced) cmd.statut = "En cours"; // Partially placed
    else cmd.statut = "Non placée";

    historyManager.saveState(`Unplan ${cmd.id} (${removedCount} ops)`);
    markCommandeDirty(cmd.id);
    syncManager.saveLocalData();
    refresh();
    Toast.info(`${removedCount} opération(s) retirée(s) du planning`);
}

function handleDragStart(e) {
    draggedOperation = JSON.parse(e.target.getAttribute('data-operation'));
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active'); // Enable drop-through
    e.dataTransfer.effectAllowed = 'move';
}

function handleSidebarDragStart(e) {
    draggedOperation = JSON.parse(e.target.getAttribute('data-sidebar-operation'));
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active'); // Enable drop-through
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    document.body.classList.remove('dragging-active'); // Disable drop-through
    document.querySelectorAll('.drop-zone').forEach(zone => {
        zone.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

// ===================================
// Drag & Drop Workflow 2 étapes - Affectation Semaine
// ===================================

/**
 * Handler pour le drag start d'une commande complète (vue semaine)
 * Marque l'opération comme étant une affectation de commande
 */
function handleCommandeDragStart(e) {
    draggedOperation = JSON.parse(e.target.getAttribute('data-commande-affectation'));
    draggedOperation.isCommandeAffectation = true; // Flag distinctif
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active');
    e.dataTransfer.effectAllowed = 'move';
}

/**
 * Handler pour le drop sur une cellule semaine (affectation)
 * Affecte la commande à la semaine cible
 */
function handleWeekCellDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active');

    // Vérifier que c'est bien une affectation de commande
    if (!draggedOperation || !draggedOperation.isCommandeAffectation) {
        // Ce n'est pas une affectation de commande, ignorer
        draggedOperation = null;
        return;
    }

    const targetWeek = parseInt(e.currentTarget.getAttribute('data-week'));
    const targetYear = parseInt(e.currentTarget.getAttribute('data-year'));

    const cmd = commandes.find(c => c.id === draggedOperation.commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        draggedOperation = null;
        return;
    }

    // Formater la semaine affectée au format ISO
    const weekStr = `${targetYear}-W${String(targetWeek).padStart(2, '0')}`;

    // Affecter la commande à cette semaine
    cmd.semaineAffectee = weekStr;

    // Sauvegarder l'état pour undo
    if (typeof historyManager !== 'undefined') {
        historyManager.saveState(`Affectation ${cmd.id} à S${targetWeek}`);
    }

    // Sauvegarder
    markCommandeDirty(cmd.id);
    if (typeof syncManager !== 'undefined') {
        syncManager.saveLocalData();
    }

    // Toast de confirmation
    Toast.success(`Commande ${cmd.id} affectée à la semaine ${targetWeek}`);

    // Rafraîchir l'affichage
    refresh();

    // Reset
    draggedOperation = null;
}

/**
 * Désaffecter une commande de sa semaine
 * Retire aussi tous les slots existants si présents
 * @param {string} commandeId - ID de la commande à désaffecter
 */
function desaffecterCommande(commandeId) {
    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        return;
    }

    // Vérifier s'il y a des slots à retirer
    const hasSlots = cmd.operations.some(op => op.slots && op.slots.length > 0);

    let confirmMsg = `Retirer la commande ${commandeId} de la semaine ?`;
    if (hasSlots) {
        confirmMsg += `\n\nATTENTION: Les opérations déjà placées seront également retirées du planning.`;
    }

    if (!confirm(confirmMsg)) return;

    // Retirer tous les slots des opérations
    cmd.operations.forEach(op => {
        if (op.slots && op.slots.length > 0) {
            op.slots = [];
            op.statut = 'Non placée';
            op.progressionReelle = 0;
        }
    });

    // Retirer l'affectation
    cmd.semaineAffectee = null;

    // Mettre à jour le statut global de la commande
    cmd.statut = 'Non placée';

    // Sauvegarder l'état pour undo
    if (typeof historyManager !== 'undefined') {
        historyManager.saveState(`Désaffectation ${commandeId}`);
    }

    // Sauvegarder
    markCommandeDirty(commandeId);
    if (typeof syncManager !== 'undefined') {
        syncManager.saveLocalData();
    }

    Toast.info(`Commande ${commandeId} retirée de la planification`);
    refresh();
}

// Exposer globalement pour les onclick dans le HTML
window.desaffecterCommande = desaffecterCommande;

/**
 * Handler pour le drag start d'un badge "À placer" (désaffectation)
 */
function handleDesaffectationDragStart(e) {
    const data = JSON.parse(e.target.getAttribute('data-commande-desaffectation'));
    draggedOperation = data;
    e.target.classList.add('dragging');
    document.body.classList.add('dragging-active');
    document.body.classList.add('dragging-desaffectation'); // Flag pour montrer la dropzone
    e.dataTransfer.effectAllowed = 'move';
}

/**
 * Handler pour le drag end d'un badge "À placer"
 */
function handleDesaffectationDragEnd(e) {
    e.target.classList.remove('dragging');
    document.body.classList.remove('dragging-active');
    document.body.classList.remove('dragging-desaffectation');
    document.querySelectorAll('.sidebar-dropzone-desaffect').forEach(zone => {
        zone.classList.remove('drag-over');
    });
}

/**
 * Handler pour le drop sur la zone de désaffectation (sidebar)
 */
function handleDesaffectationDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active');
    document.body.classList.remove('dragging-desaffectation');

    // Vérifier que c'est bien une désaffectation
    if (!draggedOperation || !draggedOperation.isDesaffectation) {
        draggedOperation = null;
        return;
    }

    const commandeId = draggedOperation.commandeId;
    draggedOperation = null;

    // Appeler la fonction de désaffectation (avec confirmation)
    desaffecterCommande(commandeId);
}

/**
 * Check if a specific time slot is available on a machine
 * @param {string} machine - Machine name
 * @param {string} day - Day name
 * @param {number} week - Week number
 * @param {string} startTime - Start time (HH:MM)
 * @param {number} duration - Duration in hours
 * @returns {Object} { valid: boolean, reason: string }
 */
function isMachineAvailable(machine, day, week, startTime, duration) {
    const EPSILON = 0.001; // Tolerance for float comparisons
    const start = timeToDecimalHours(startTime);
    const end = start + duration;

    // Check working hours - dynamique multi-equipes
    const globalSchedule = getGlobalScheduleRangeForDay(day);
    const dayStart = globalSchedule.globalStart;
    const dayEnd = globalSchedule.globalEnd;

    if (start < dayStart - EPSILON) {
        return { valid: false, reason: `L'horaire de début (${startTime}) est avant l'ouverture (${formatDecimalTime(dayStart)}).` };
    }
    if (end > dayEnd + EPSILON) {
        return { valid: false, reason: `L'opération se termine à ${formatDecimalTime(end)}, ce qui dépasse la fermeture (${formatDecimalTime(dayEnd)}).` };
    }

    // Check blocked zones (pauses + gaps inter-equipes)
    const blockedZones = getBlockedZonesForDay(day);
    for (const zone of blockedZones) {
        // If operation is FULLY inside a blocked zone, that's invalid
        if (start >= zone.start && end <= zone.end) {
            return { valid: false, reason: `L'opération ne peut pas être placée entièrement dans "${zone.name}".` };
        }
        // We ALLOW spanning across blocked zones (e.g. 11:00 to 14:00)
        // The split logic will handle it
    }

    // Check existing slots
    const placedOrders = getPlacedOrders();
    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot =>
            slot.machine === machine &&
            slot.jour === day &&
            slot.semaine === week
        );

    for (const slot of slots) {
        const sStart = timeToDecimalHours(slot.heureDebut);
        const sEnd = timeToDecimalHours(slot.heureFin);

        // Check overlap: (Start < SlotEnd) AND (End > SlotStart)
        if (start < sEnd - EPSILON && end > sStart + EPSILON) {
             return { valid: false, reason: `La machine est occupée de ${slot.heureDebut} à ${slot.heureFin} par une autre opération.` };
        }
    }

    return { valid: true, reason: '' };
}

/**
 * Helper to format decimal time (e.g. 16.5 -> 16:30) for messages
 */
function formatDecimalTime(decimalTime) {
    const hours = Math.floor(decimalTime);
    const minutes = Math.round((decimalTime - hours) * 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

async function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    document.body.classList.remove('dragging-active'); // CRITICAL: Ensure class is removed even if re-render happens

    const targetMachine = e.currentTarget.getAttribute('data-machine');
    const targetDay = e.currentTarget.getAttribute('data-day');
    const targetWeek = parseInt(e.currentTarget.getAttribute('data-week'));
    const targetHour = e.currentTarget.getAttribute('data-hour');
    const targetTime = e.currentTarget.getAttribute('data-time');

    if (!draggedOperation) return;

    // 1. Identify Command & Operation
    const cmd = commandes.find(c => c.id === draggedOperation.commandeId);
    if (!cmd) return;
    const operation = cmd.operations.find(op => op.type === draggedOperation.operationType);
    if (!operation) return;

    // CHECK MACHINE COMPATIBILITY
    if (targetMachine) {
        let validMachines = [];
        if (operation.type === 'Cisaillage') validMachines = MACHINES.cisailles;
        else if (operation.type === 'Poinçonnage') validMachines = MACHINES.poinconneuses;
        else if (operation.type === 'Pliage') validMachines = MACHINES.plieuses;
        
        if (!validMachines.includes(targetMachine)) {
             // Need to define restoreAndAlert helper or inline alert if not hoisted yet
             // Since restoreAndAlert is defined at bottom of this function scope, we can't call it before definition if not hoisted?
             // Actually functions declarations are hoisted. But let's check.
             // Wait, restoreAndAlert relies on originalSlots which is defined below.
             // I should move this check AFTER step 2 (Backup).
        }
    }

    // 2. Backup current state (in case of failure)
    const originalSlots = JSON.parse(JSON.stringify(operation.slots));
    const originalStatut = operation.statut;

    // CHECK MACHINE COMPATIBILITY (Moved here to safely use restoreAndAlert)
    if (targetMachine) {
        let validMachines = [];
        if (operation.type === 'Cisaillage') validMachines = MACHINES.cisailles;
        else if (operation.type === 'Poinçonnage') validMachines = MACHINES.poinconneuses;
        else if (operation.type === 'Pliage') validMachines = MACHINES.plieuses;
        
        if (!validMachines.includes(targetMachine)) {
             restoreAndAlert(`Impossible : ${operation.type} ne peut pas être réalisé sur ${targetMachine}.`);
             return;
        }
    }

    // 3. Strategy Selection: Merge vs Split
    // Check if we can fit the WHOLE operation (merge) at the target,
    // or if we must only move the specific chunk (split).

    // Détecter si opération multi-fragments → tentative de fusion
    if (operation.slots.length > 1) {
        console.log(`🔗 Opération multi-fragments détectée (${operation.slots.length} parties) → tentative de fusion`);
    }

    let durationToPlace = operation.dureeTotal;
    let mergeMode = false;

    // 4. Calculate Search Start Time (Snap to Previous)
    let dropDecimal = 7.5; 
    if (targetHour) {
        dropDecimal = parseFloat(targetHour);
    }
    if (targetTime) {
        const parts = targetTime.split(':');
        dropDecimal = parseInt(parts[0]) + parseInt(parts[1]) / 60;
    }

    // NOUVEAU: Valider que le drop n'est pas dans une zone bloquee
    const blockedZone = isTimeInBlockedZone(targetDay, dropDecimal);
    if (blockedZone) {
        alert(`Impossible : ${formatDecimalTime(dropDecimal)} est dans "${blockedZone.name}"`);
        return;
    }

    let searchWeek = targetWeek;
    let searchDay = targetDay;
    let searchYear = typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : new Date().getFullYear();

    // Year rollover correction
    const now = new Date();
    const currentWeekNum = getWeekNumber(now);
    if (currentWeekNum > 40 && searchWeek < 10 && searchYear === now.getFullYear()) {
        searchYear++;
    }

    // B. Strict Global Chronology Constraints
    let chronologyMinDecimal = 0;
    const targetDateStart = getDateFromWeekDay(searchWeek, searchDay, "00:00", searchYear);
    const targetDateEnd = new Date(targetDateStart);
    targetDateEnd.setDate(targetDateEnd.getDate() + 1);

    // Helper: Vérifie si deux opérations peuvent se chevaucher (Poinçonnage/Pliage parallèle)
    const isParallelAllowed = (type1, type2) => {
        return (type1 === 'Poinçonnage' || type1 === 'Pliage') &&
               (type2 === 'Poinçonnage' || type2 === 'Pliage');
    };

    // Check Predecessor - Uniquement Cisaillage impose une contrainte sur Poinçonnage/Pliage
    const cisaillageOp = cmd.operations.find(op => op.type === 'Cisaillage');
    if (cisaillageOp && cisaillageOp.slots && cisaillageOp.slots.length > 0) {
        // Si on déplace Poinçonnage ou Pliage, Cisaillage doit être terminé avant
        if (operation.type === 'Poinçonnage' || operation.type === 'Pliage') {
            const lastSlot = [...cisaillageOp.slots].sort((a,b) => a.dateFin.localeCompare(b.dateFin)).pop();
            const cisaillageEndDate = new Date(lastSlot.dateFin);

            if (cisaillageEndDate.getTime() > targetDateEnd.getTime() - 60000) {
                restoreAndAlert(`⛔ IMPOSSIBLE : Cisaillage termine après ce jour.`);
                return;
            }
            if (cisaillageEndDate.getTime() > targetDateStart.getTime()) {
                chronologyMinDecimal = cisaillageEndDate.getHours() + cisaillageEndDate.getMinutes()/60;
            }
        }
    }

    // Check Successor - Uniquement si on déplace Cisaillage, vérifier contre Poinçonnage ET Pliage
    let successorMaxDecimal = 24;
    if (operation.type === 'Cisaillage') {
        // Trouver le plus tôt entre Poinçonnage et Pliage
        for (const opType of ['Poinçonnage', 'Pliage']) {
            const nextOp = cmd.operations.find(op => op.type === opType);
            if (nextOp && nextOp.slots && nextOp.slots.length > 0) {
                const firstSlot = [...nextOp.slots].sort((a,b) => a.dateDebut.localeCompare(b.dateDebut))[0];
                const nextStartDate = new Date(firstSlot.dateDebut);
                if (nextStartDate.getTime() < targetDateStart.getTime()) {
                    restoreAndAlert(`⛔ IMPOSSIBLE : ${opType} commence avant ce jour.`);
                    return;
                }
                if (nextStartDate.getTime() < targetDateEnd.getTime()) {
                    const nextStartDecimal = nextStartDate.getHours() + nextStartDate.getMinutes()/60;
                    successorMaxDecimal = Math.min(successorMaxDecimal, nextStartDecimal);
                }
            }
        }
    }
    // NOTE: Poinçonnage et Pliage peuvent se chevaucher - pas de contrainte successor entre eux

    const effectiveSearchStart = Math.max(dropDecimal, chronologyMinDecimal);
    const effectiveSearchTimeStr = formatDecimalTime(effectiveSearchStart);

    // ATOMIC MOVE STRATEGY: Clear everything and move as one block
    const slotsBackup = [...operation.slots];
    operation.slots = []; 

    // Find the closest contiguous gap that can fit the WHOLE operation
    const gapStart = findFirstAvailableGap(targetMachine, searchDay, searchWeek, operation.dureeTotal, effectiveSearchTimeStr, true, searchYear);

    if (gapStart) {
        const startParts = gapStart.split(':');
        const startDec = parseInt(startParts[0]) + parseInt(startParts[1])/60;
        const endDec = calculateEndTimeWithLunch(startDec, operation.dureeTotal, searchDay);

        // ===== VALIDATION HEURES SUPPLÉMENTAIRES =====
        const overtimeCheck = detectOvertimeOverflow(startDec, operation.dureeTotal, searchDay);

        if (overtimeCheck.overflows) {
            // Vérifier si dépasse même avec heures sup
            if (overtimeCheck.exceedsDay) {
                operation.slots = slotsBackup;
                restoreAndAlert(`⛔ IMPOSSIBLE : L'opération dépasse la journée entière (même avec heures sup). Utilisez le placement automatique pour scindage multi-jours.`);
                return;
            }

            // Vérifier limites heures sup
            const machineOvertimeUsed = overtimeTracker.byMachine[targetMachine]?.hours || 0;
            const weeklyOvertimeUsed = overtimeTracker.totalHoursUsed || 0;

            const canUseOvertime = (
                machineOvertimeUsed + overtimeCheck.overtimeNeeded <= 2 && // Max 2h/jour
                weeklyOvertimeUsed + overtimeCheck.overtimeNeeded <= 10    // Max 10h/semaine
            );

            if (!canUseOvertime) {
                operation.slots = slotsBackup;
                restoreAndAlert(`⛔ IMPOSSIBLE : Limites heures supplémentaires atteintes (max 2h/jour, 10h/semaine).`);
                return;
            }

            // Afficher confirmation
            const confirmResult = await showOvertimeConfirmDialog({
                type: operation.type,
                machine: targetMachine,
                day: searchDay,
                normalDuration: operation.dureeTotal - overtimeCheck.overtimeNeeded,
                overtimeDuration: overtimeCheck.overtimeNeeded,
                totalDuration: operation.dureeTotal
            });

            if (confirmResult === 'refuse') {
                // Scinder à la limite des heures normales
                const fragments = splitAtNormalHoursEnd(
                    operation,
                    targetMachine,
                    searchWeek,
                    searchYear,
                    searchDay,
                    startDec
                );

                // Créer les slots pour chaque fragment
                operation.slots = fragments.map((frag, index) => ({
                    id: generateSlotId(operation.id, fragments.slice(0, index)),
                    machine: frag.machine,
                    duree: frag.duration,
                    semaine: frag.week,
                    annee: frag.year,
                    jour: frag.day,
                    heureDebut: formatDecimalTime(frag.startHour),
                    heureFin: formatDecimalTime(frag.endHour),
                    dateDebut: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.startHour), frag.year).toISOString(),
                    dateFin: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.endHour), frag.year).toISOString(),
                    overtime: isInOvertimeZone(frag.day, frag.startHour)
                }));

                operation.statut = "Planifiée";
                const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                cmd.statut = allPlaced ? "Planifiée" : "En cours";

                if (typeof replanifierOperationsSuivantes === 'function') {
                    replanifierOperationsSuivantes(cmd, operation);
                }

                renderVueJournee();
                renderCommandesNonPlacees(currentSearchQuery || '');
                saveDataImmediate(cmd.id);
                Toast.info(`Opération scindée en ${fragments.length} partie(s) (heures sup refusées)`);
                return;
            }

            // Accepté → tracker heures sup
            if (!overtimeTracker.byMachine[targetMachine]) {
                overtimeTracker.byMachine[targetMachine] = { hours: 0 };
            }
            overtimeTracker.byMachine[targetMachine].hours += overtimeCheck.overtimeNeeded;
            overtimeTracker.totalHoursUsed += overtimeCheck.overtimeNeeded;
        }
        // ===== FIN VALIDATION HEURES SUPPLÉMENTAIRES =====

        // Successor check on the final calculated end time
        if (endDec > successorMaxDecimal + 0.001) {
             operation.slots = slotsBackup;
             restoreAndAlert(`⛔ IMPOSSIBLE : L'opération se terminerait après le début de l'opération suivante (${formatDecimalTime(successorMaxDecimal)}).`);
             return;
        }

        // Apply new slot
        operation.slots = [{
            id: generateSlotId(operation.id, []),
            machine: targetMachine,
            duree: operation.dureeTotal,
            semaine: searchWeek,
            jour: searchDay,
            heureDebut: gapStart,
            heureFin: formatDecimalTime(endDec),
            dateDebut: getDateFromWeekDay(searchWeek, searchDay, gapStart, searchYear).toISOString(),
            dateFin: getDateFromWeekDay(searchWeek, searchDay, formatDecimalTime(endDec), searchYear).toISOString(),
            overtime: isInOvertimeZone(searchDay, startDec)
        }];

        operation.statut = "Planifiée";
        const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
        cmd.statut = allPlaced ? "Planifiée" : "En cours";

        // 🔄 Cascade Reschedule (Fix Conflicts if any)
        if (typeof replanifierOperationsSuivantes === 'function') {
            replanifierOperationsSuivantes(cmd, operation);
        }

        renderVueJournee();
        renderCommandesNonPlacees(currentSearchQuery || ''); // Update sidebar
        saveDataImmediate(cmd.id);

        // Message différent si fusion automatique ou simple déplacement
        const wasMultiFragment = slotsBackup.length > 1;
        if (wasMultiFragment) {
            Toast.success(`Opération fusionnée en un seul bloc à ${gapStart}`);
        } else {
            Toast.success(`Opération déplacée à ${gapStart}`);
        }
    } else {
        // Pas de gap contigu complet - chercher un gap partiel
        const partialGap = findNextGap(targetMachine, searchDay, searchWeek, effectiveSearchTimeStr, searchYear);

        if (partialGap) {
            const gapStartDec = timeToDecimalHours(partialGap.startTime);
            const normalEndHour = searchDay === 'Vendredi' ? 12 : 16.5;
            const overtimeEndHour = searchDay === 'Vendredi' ? 14 : 18;

            // Calculer combien on peut placer dans le gap avant heures normales
            const availableInGap = Math.min(partialGap.duration, Math.max(0, normalEndHour - gapStartDec));
            const overtimeNeeded = Math.min(operation.dureeTotal - availableInGap, overtimeEndHour - normalEndHour);

            // Vérifier limites H sup
            const machineOvertimeUsed = overtimeTracker.byMachine[targetMachine]?.hours || 0;
            const weeklyOvertimeUsed = overtimeTracker.totalHoursUsed || 0;
            const canUseOvertime = (
                machineOvertimeUsed + overtimeNeeded <= 2 && // Max 2h/jour
                weeklyOvertimeUsed + overtimeNeeded <= 10    // Max 10h/semaine
            );

            // Vérifier si heures sup permettent de compléter l'opération
            const totalAvailableWithOvertime = availableInGap + (canUseOvertime ? overtimeNeeded : 0);

            if (canUseOvertime && overtimeNeeded > 0.25 && totalAvailableWithOvertime >= operation.dureeTotal - 0.01) {
                // Proposer popup H sup
                const confirmResult = await showOvertimeConfirmDialog({
                    type: operation.type,
                    machine: targetMachine,
                    day: searchDay,
                    normalDuration: availableInGap,
                    overtimeDuration: overtimeNeeded,
                    totalDuration: operation.dureeTotal
                });

                if (confirmResult === 'accept') {
                    // Accepté → tracker heures sup et placer l'opération complète
                    if (!overtimeTracker.byMachine[targetMachine]) {
                        overtimeTracker.byMachine[targetMachine] = { hours: 0 };
                    }
                    overtimeTracker.byMachine[targetMachine].hours += overtimeNeeded;
                    overtimeTracker.totalHoursUsed += overtimeNeeded;

                    const endDec = calculateEndTimeWithLunch(gapStartDec, operation.dureeTotal, searchDay);

                    operation.slots = [{
                        id: generateSlotId(operation.id, []),
                        machine: targetMachine,
                        duree: operation.dureeTotal,
                        semaine: searchWeek,
                        jour: searchDay,
                        heureDebut: partialGap.startTime,
                        heureFin: formatDecimalTime(endDec),
                        dateDebut: getDateFromWeekDay(searchWeek, searchDay, partialGap.startTime, searchYear).toISOString(),
                        dateFin: getDateFromWeekDay(searchWeek, searchDay, formatDecimalTime(endDec), searchYear).toISOString(),
                        overtime: true
                    }];

                    operation.statut = "Planifiée";
                    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                    cmd.statut = allPlaced ? "Planifiée" : "En cours";

                    if (typeof replanifierOperationsSuivantes === 'function') {
                        replanifierOperationsSuivantes(cmd, operation);
                    }

                    renderVueJournee();
                    renderCommandesNonPlacees(currentSearchQuery || '');
                    saveDataImmediate(cmd.id);
                    Toast.success(`Opération placée avec ${formatHours(overtimeNeeded)} d'heures supplémentaires`);
                } else {
                    // Refusé → Scinder l'opération
                    const fragments = splitAtNormalHoursEnd(
                        operation,
                        targetMachine,
                        searchWeek,
                        searchYear,
                        searchDay,
                        gapStartDec
                    );

                    operation.slots = fragments.map((frag, index) => ({
                        id: generateSlotId(operation.id, fragments.slice(0, index)),
                        machine: frag.machine,
                        duree: frag.duration,
                        semaine: frag.week,
                        annee: frag.year,
                        jour: frag.day,
                        heureDebut: formatDecimalTime(frag.startHour),
                        heureFin: formatDecimalTime(frag.endHour),
                        dateDebut: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.startHour), frag.year).toISOString(),
                        dateFin: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.endHour), frag.year).toISOString(),
                        overtime: isInOvertimeZone(frag.day, frag.startHour)
                    }));

                    operation.statut = "Planifiée";
                    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                    cmd.statut = allPlaced ? "Planifiée" : "En cours";

                    if (typeof replanifierOperationsSuivantes === 'function') {
                        replanifierOperationsSuivantes(cmd, operation);
                    }

                    renderVueJournee();
                    renderCommandesNonPlacees(currentSearchQuery || '');
                    saveDataImmediate(cmd.id);
                    Toast.info(`Opération scindée en ${fragments.length} partie(s) (heures sup refusées)`);
                }
            } else {
                // Scinder directement (pas de H sup possibles/suffisantes)
                const fragments = splitAtNormalHoursEnd(
                    operation,
                    targetMachine,
                    searchWeek,
                    searchYear,
                    searchDay,
                    gapStartDec
                );

                operation.slots = fragments.map((frag, index) => ({
                    id: generateSlotId(operation.id, fragments.slice(0, index)),
                    machine: frag.machine,
                    duree: frag.duration,
                    semaine: frag.week,
                    annee: frag.year,
                    jour: frag.day,
                    heureDebut: formatDecimalTime(frag.startHour),
                    heureFin: formatDecimalTime(frag.endHour),
                    dateDebut: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.startHour), frag.year).toISOString(),
                    dateFin: getDateFromWeekDay(frag.week, frag.day, formatDecimalTime(frag.endHour), frag.year).toISOString(),
                    overtime: isInOvertimeZone(frag.day, frag.startHour)
                }));

                operation.statut = "Planifiée";
                const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
                cmd.statut = allPlaced ? "Planifiée" : "En cours";

                if (typeof replanifierOperationsSuivantes === 'function') {
                    replanifierOperationsSuivantes(cmd, operation);
                }

                renderVueJournee();
                renderCommandesNonPlacees(currentSearchQuery || '');
                saveDataImmediate(cmd.id);
                Toast.info(`Opération scindée en ${fragments.length} partie(s)`);
            }
        } else {
            // Aucun gap du tout
            operation.slots = slotsBackup;
            restoreAndAlert(`Impossible de déplacer l'opération : aucun créneau disponible.`);
        }
    }

    function restoreAndAlert(msg) {
        operation.slots = originalSlots;
        operation.statut = originalStatut;
        alert(msg);
        refresh(); // Re-render to show original
    }
}

// ===================================
// Auto Placement
// ===================================

/**
 * Automatically place an order
 * Support du placement parallèle Poinçonnage/Pliage
 */
async function placerAutomatiquement(commandeId) {
    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) return;

    // 🔒 VALIDATION CRITIQUE: Vérifier que la commande a les opérations dans le bon ordre
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
    const now = new Date(); // Use system time

    const currentWeek = getWeekNumber(now);
    let currentDayIndex = now.getDay() - 1; // 0=Mon, 4=Fri, -1=Sun
    if (currentDayIndex === -1) currentDayIndex = 6;

    const currentHour = now.getHours() + now.getMinutes() / 60;

    console.log(`📅 DEBUG Placement Auto: Date actuelle = ${now.toLocaleDateString('fr-FR')}, Semaine ${currentWeek}, Jour index ${currentDayIndex}, Heure ${currentHour.toFixed(2)}`);
    
    // Define Rush Hour Window: Only Morning 09:00-10:00
    // Removed Midday window per user request
    const isRushHour = (currentHour >= 9 && currentHour < 10);
    
    // Only apply logic if Today is a working day (Mon-Fri)
    if (currentDayIndex >= 0 && currentDayIndex < 5) {
        if (isRushHour) {
             // "Fait a la date d'aujourd'hui" => Force Start Today at 00:00 (allow filling morning gaps)
            globalMinStart = { week: currentWeek, dayIndex: currentDayIndex, timeStr: "00:00" };
            console.log("🚀 Rush Hour Mode (Morning): Prioritizing Today (filling gaps from start of day)!");
            Toast.info("Mode Matin : Optimisation du planning journée");
        } else {
            // "Sinon... ne peut pas placer avant celle-ci" => Start from NOW
            const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
            globalMinStart = { week: currentWeek, dayIndex: currentDayIndex, timeStr: timeStr };
            console.log(`🕒 Standard Mode: Starting search from ${timeStr}`);
        }
    } else {
        // Weekend (Samedi/Dimanche) => Start from Next Monday 00:00
        globalMinStart = { week: currentWeek + 1, dayIndex: 0, timeStr: "00:00" };
        console.log("📅 Week-end : Démarrage de la recherche lundi prochain");
    }

    // Constraint après Cisaillage pour le placement parallèle
    let constraintAfterCisaillage = null;

    // For each operation, find BEST machine slot (load-balanced)
    // Use for...of to allow breaking if an operation fails
    for (const operation of cmd.operations) {
        if (operation.slots.length > 0) continue; // Already placed

        // Get available machines for this operation type
        let availableMachines = [];
        if (operation.type === 'Cisaillage') availableMachines = MACHINES.cisailles;
        else if (operation.type === 'Poinçonnage') availableMachines = MACHINES.poinconneuses;
        else if (operation.type === 'Pliage') availableMachines = MACHINES.plieuses;

        let remainingDuration = operation.dureeTotal;
        let placementFailed = false;
        let assignedMachine = null; // Force continuity on same machine
        let nextStartConstraint = null; // Where to continue (week, day, time)

        // En mode parallèle, Poinçonnage et Pliage démarrent au même endroit (après Cisaillage)
        let parallelStartConstraint = null;
        if (placeInParallel && (operation.type === 'Poinçonnage' || operation.type === 'Pliage')) {
            parallelStartConstraint = constraintAfterCisaillage || globalMinStart;
            console.log(`🔀 Mode parallèle: ${operation.type} démarre à S${parallelStartConstraint.week} ${DAYS_OF_WEEK[parallelStartConstraint.dayIndex]} ${parallelStartConstraint.timeStr}`);
        }

        // Loop to place chunks until full duration is scheduled
        while (remainingDuration > 0.01) { // 0.01 tolerance for float math

            // 🎯 Find best slot for remaining duration (or largest available chunk)
            // Pass globalMinStart to constrain search
            let machineList = availableMachines;
            let searchConstraint = parallelStartConstraint || globalMinStart;

            // 🔒 CONTINUITY: If already assigned a machine, force same machine and continue from last end
            if (assignedMachine) {
                machineList = [assignedMachine]; // Force same machine
                searchConstraint = nextStartConstraint; // Continue from where we left off
                console.log(`🔗 Continuité sur ${assignedMachine}, recherche à partir de S${searchConstraint.week} ${DAYS_OF_WEEK[searchConstraint.dayIndex]} ${searchConstraint.timeStr}`);
            }

            const bestSlot = findBestMachineSlot(operation, cmd, machineList, remainingDuration, searchConstraint);

            if (!bestSlot) {
                console.warn(`⚠️ Impossible de placer une partie de l'opération ${operation.type} (${remainingDuration}h) de la commande ${cmd.id}`);
                alert(`⚠️ Impossible de placer ${operation.type} (reste ${formatHours(remainingDuration)}). Les opérations suivantes ne seront pas planifiées.`);
                placementFailed = true;
                break;
            }

            // 🔒 Assign machine on first placement
            if (!assignedMachine) {
                assignedMachine = bestSlot.machine;
                console.log(`Machine assignée pour ${operation.type}: ${assignedMachine}`);
            }

            // 📊 Check if we can fit the remaining duration with overtime
            let placedDuration = bestSlot.usableDuration;
            let useOvertime = false;

            // Calculate slot start time (needed for multiple checks)
            const startParts = bestSlot.startTime.split(':');
            const startHourFloat = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;

            // If the available duration is less than what we need, check overtime possibility
            if (placedDuration < remainingDuration) {
                const normalEndHour = bestSlot.day === 'Vendredi' ? 12 : 16.5;
                const overtimeEndHour = bestSlot.day === 'Vendredi' ? 14 : 18;
                const maxOvertimeHours = overtimeEndHour - normalEndHour;

                // Calculate what time the current slot ends
                const currentEndHourFloat = startHourFloat + placedDuration;

                // Check if we're at the end of normal hours
                if (currentEndHourFloat >= normalEndHour - 0.1 && remainingDuration - placedDuration > 0.1) {
                    // We could use overtime
                    const overtimeNeeded = Math.min(remainingDuration - placedDuration, maxOvertimeHours);

                    // Verify overtime limits
                    const currentOvertimeUsed = overtimeTracker.byMachine[assignedMachine]?.hours || 0;
                    const weeklyOvertimeUsed = overtimeTracker.totalHoursUsed || 0;

                    const canUseOvertime = (
                        currentOvertimeUsed + overtimeNeeded <= CAPACITY_CONFIG.overtime.maxDailyHours &&
                        weeklyOvertimeUsed + overtimeNeeded <= CAPACITY_CONFIG.overtime.maxWeeklyHours
                    );

                    if (canUseOvertime && overtimeNeeded > 0.25) {
                        // Afficher modale de confirmation pour heures sup
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

                            // Track overtime usage
                            if (!overtimeTracker.byMachine[assignedMachine]) {
                                overtimeTracker.byMachine[assignedMachine] = { hours: 0 };
                            }
                            overtimeTracker.byMachine[assignedMachine].hours += overtimeNeeded;
                            overtimeTracker.totalHoursUsed += overtimeNeeded;

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

            // Place chunk
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

            // Update remaining
            remainingDuration -= placedDuration;

            // 🔗 Set next start constraint: Continue right after this slot
            if (remainingDuration > 0.01) {
                // Continue on next available time on same machine
                const dayIndex = DAYS_OF_WEEK.indexOf(bestSlot.day);
                const endHourFloat = startHourFloat + placedDuration;

                // Check if we've reached end of day -> move to next day
                const dayEndHour = bestSlot.day === 'Vendredi' ? (useOvertime ? 14 : 12) : (useOvertime ? 18 : 16.5);

                if (endHourFloat >= dayEndHour - 0.1) {
                    // Move to next day
                    const currentWeekStart = getWeekNumber(new Date());
                    let weekOffset = bestSlot.week - currentWeekStart;
                    if (weekOffset < 0) weekOffset += 52;

                    let nextDayIndex = dayIndex + 1;
                    let nextWeek = bestSlot.week;

                    if (nextDayIndex >= DAYS_OF_WEEK.length) {
                        // Move to next week, Monday
                        nextDayIndex = 0;
                        nextWeek = bestSlot.week + 1;
                        if (nextWeek > 52) {
                            nextWeek = 1;
                        }
                    }

                    nextStartConstraint = {
                        week: nextWeek,
                        dayIndex: nextDayIndex,
                        timeStr: "07:30" // Start of next day
                    };

                    console.log(`➡️  ${formatHours(remainingDuration)} restant, continue ${DAYS_OF_WEEK[nextDayIndex]} S${nextWeek} 07:30`);
                } else {
                    // Continue same day after this slot
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
            break; // Stop placing subsequent operations for this command
        }

        operation.statut = "Planifiée";

        // Sauvegarder la contrainte après Cisaillage pour le placement parallèle
        if (operation.type === 'Cisaillage' && placeInParallel) {
            // Trouver la fin de la dernière slot de Cisaillage
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

    historyManager.saveState(`Auto-place ${commandeId}`);
    saveData(commandeId);

    // Re-render
    refresh();
}

/**
 * Show command details
 */
function showCommandeDetails(commandeId) {
    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) return;

    const modal = document.getElementById('modalOrderDetails');
    const content = document.getElementById('orderDetailsContent');

    content.innerHTML = `
        <div class="order-details-warning">
            🔒 <strong>ORDRE CHRONOLOGIQUE:</strong> Cisaille → Poinçon → Pliage (Obligatoire dans le planning)
        </div>
        <div class="detail-row">
            <span class="detail-label">Commande:</span>
            <span class="detail-value">${cmd.id}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Client:</span>
            <span class="detail-value">${cmd.client}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Matériau:</span>
            <span class="detail-value">${cmd.materiau} (${cmd.poids}kg)</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Livraison:</span>
            <span class="detail-value">${formatDate(cmd.dateLivraison)}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Statut:</span>
            <span class="detail-value">${cmd.statut}</span>
        </div>
        <div class="operations-list">
            <h3>Opérations</h3>
            ${cmd.operations.map(op => {
                const hasOverride = hasTimeOverride(op);
                const originalDuration = op.dureeOriginal || op.dureeTotal;
                const typeClass = op.type.toLowerCase().replace('ç', 'c').replace('é', 'e');
                return `
                <div class="operation-item ${typeClass} ${hasOverride ? 'has-override' : ''}">
                    <div class="operation-item-header">
                        <span>${op.type}</span>
                        <span class="operation-time-edit">
                            <span class="operation-duration ${hasOverride ? 'overridden' : ''}"
                                  onclick="showModalTimeEdit('${cmd.id}', '${op.type}', ${op.dureeTotal}, ${originalDuration})"
                                  title="Cliquer pour modifier le temps">
                                ${formatHours(op.dureeTotal)}
                                ${hasOverride ? '<span class="override-indicator">*</span>' : ''}
                                <span class="edit-icon">&#9998;</span>
                            </span>
                            ${hasOverride ? `<span class="override-badge">(Original: ${formatHours(originalDuration)})</span>` : ''}
                        </span>
                    </div>
                    <div class="operation-item-details">
                        ${op.slots.length > 0 ?
                            op.slots.map(slot => `
                                Machine: ${slot.machine}<br>
                                Semaine ${slot.semaine} - ${slot.jour}<br>
                                ${slot.heureDebut} - ${slot.heureFin}
                            `).join('<br>')
                            : 'Non placée'
                        }
                    </div>
                    ${hasOverride ? `
                        <div class="operation-override-actions">
                            <button class="btn btn-xs btn-secondary" onclick="resetOperationTimeOverride('${cmd.id}', '${op.type}'); showCommandeDetails('${cmd.id}');">
                                Réinitialiser au temps original
                            </button>
                        </div>
                    ` : ''}
                </div>
            `}).join('')}
        </div>
    `;

    modal.classList.add('active');
}

// ===================================
// Toast Notification System
// ===================================

const Toast = {
    success(message) {
        this.show(message, 'success', '✓');
    },
    
    error(message) {
        this.show(message, 'error', '✗');
    },
    
    warning(message) {
        this.show(message, 'warning', '⚠');
    },
    
    info(message) {
        this.show(message, 'info', 'ℹ');
    },
    
    show(message, type, icon) {
        // Supprimer les toasts existants
        document.querySelectorAll('.toast').forEach(t => t.remove());
        
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <span class="toast-message">${message}</span>
        `;
        
        document.body.appendChild(toast);
        
        // Auto-remove après 3 secondes
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
};

// ===================================
// Overtime Confirmation Dialog
// ===================================

/**
 * Affiche une modale de confirmation pour les heures supplémentaires
 * @param {object} operationInfo - Informations sur l'opération
 * @returns {Promise<string>} 'accept' ou 'refuse'
 */
function showOvertimeConfirmDialog(operationInfo) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modalOvertimeConfirm');
        const content = document.getElementById('overtimeConfirmContent');
        const btnAccept = document.getElementById('btnAcceptOvertime');
        const btnRefuse = document.getElementById('btnRefuseOvertime');

        // Construire le message
        content.innerHTML = `
            <p><strong>Opération :</strong> ${operationInfo.type}</p>
            <p><strong>Machine :</strong> ${operationInfo.machine}</p>
            <p><strong>Jour :</strong> ${operationInfo.day}</p>
            <hr>
            <p><strong>Durée totale :</strong> ${formatHours(operationInfo.totalDuration)}</p>
            <p><strong>Heures normales :</strong> ${formatHours(operationInfo.normalDuration)}</p>
            <p style="color: #fd7e14;"><strong>Heures supplémentaires :</strong> ${formatHours(operationInfo.overtimeDuration)}</p>
            <hr>
            <p style="font-size: 0.9em; color: #666;">
                Si vous refusez, l'opération sera scindée à ${operationInfo.day === 'Vendredi' ? '12:00' : '16:30'}
                et continuera le lendemain.
            </p>
        `;

        // Event handlers
        const handleAccept = () => {
            cleanup();
            resolve('accept');
        };

        const handleRefuse = () => {
            cleanup();
            resolve('refuse');
        };

        const cleanup = () => {
            btnAccept.removeEventListener('click', handleAccept);
            btnRefuse.removeEventListener('click', handleRefuse);
            modal.style.display = 'none';
        };

        btnAccept.addEventListener('click', handleAccept);
        btnRefuse.addEventListener('click', handleRefuse);

        modal.style.display = 'flex';
    });
}

// ===================================
// Data Sync Manager (Hybrid Architecture)
// ===================================

class DataSyncManager {
    constructor() {
        this.syncInterval = null;
        this.lastSyncTime = null;
        this.syncStatus = 'unknown'; // 'synced', 'offline', 'error', 'syncing'
        this.STORAGE_KEY = 'etm_commandes_v2';
        this.BACKUP_KEY = 'etm_commandes_backup';
    }

    // Méthode 1: Initialisation - Supabase comme source primaire
    async init() {
        // 1. Essayer Supabase d'abord (source primaire)
        if (supabaseClient) {
            try {
                this.updateSyncIndicator('syncing', 'Chargement Supabase...');
                const supabaseData = await this.loadCommandesFromSupabase();

                if (supabaseData && supabaseData.length > 0) {
                    commandes = supabaseData;
                    this.saveLocalData(); // Backup en localStorage
                    this.updateSyncIndicator('synced', 'Supabase');
                    refresh();
                    console.log(`✅ ${commandes.length} commandes chargées depuis Supabase`);

                    // Migration des noms de machines si nécessaire
                    if (migrateMachineNames()) {
                        markAllCommandesDirty();
                        this.saveLocalData();
                    }

                    // Démarrer auto-sync Supabase (Realtime fait le reste)
                    this.startAutoSyncSupabase();
                    return;
                } else {
                    console.log('ℹ️ Supabase vide, fallback localStorage');
                }
            } catch (e) {
                console.warn('⚠️ Supabase indisponible:', e.message);
            }
        }

        // 2. Fallback localStorage si Supabase échoue ou est vide
        console.log('📦 Fallback: chargement localStorage');
        this.loadLocalData();

        // Migration données si nécessaire
        if (migrateOperationOverrideFields()) {
            this.saveLocalData();
        }

        this.updateSyncIndicator('offline', 'Mode hors ligne');
    }

    // Méthode 2: Chargement local (localStorage - backup/fallback)
    loadLocalData() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                if (Array.isArray(data)) {
                    commandes = data;
                    console.log(`✅ Loaded ${commandes.length} orders from Local Storage.`);
                    this.updateSyncIndicator('offline', 'Données locales');
                    refresh();

                    // Migration des noms de machines si nécessaire
                    if (migrateMachineNames()) {
                        this.saveLocalData();
                        Toast.info('Noms de machines mis à jour');
                    }
                }
            } else {
                console.log('ℹ️ No local data found. Waiting for Supabase sync...');
                commandes = [];
                this.updateSyncIndicator('syncing', 'En attente de sync...');
            }
        } catch (e) {
            console.error('❌ Error loading local data:', e);
            commandes = [];
            this.updateSyncIndicator('error', 'Erreur chargement local');
        }
    }

    // Charger les commandes depuis Supabase
    async loadCommandesFromSupabase() {
        const { data: commandesData, error: cmdError } = await supabaseClient
            .from('commandes')
            .select('*');

        if (cmdError) throw cmdError;
        if (!commandesData || commandesData.length === 0) return [];

        // Charger les opérations pour chaque commande
        const { data: operationsData, error: opError } = await supabaseClient
            .from('operations')
            .select('*');

        if (opError) throw opError;

        // Charger les slots
        const { data: slotsData, error: slotError } = await supabaseClient
            .from('slots')
            .select('*');

        if (slotError) throw slotError;

        // Reconstruire la structure commandes avec operations et slots
        const result = commandesData.map(cmd => {
            const cmdOperations = (operationsData || [])
                .filter(op => op.commande_id === cmd.id)
                .map(op => {
                    const opSlots = (slotsData || [])
                        .filter(slot => slot.operation_id === op.id)
                        .map(slot => ({
                            id: slot.id,  // ID stable pour upsert
                            machine: slot.machine_name,
                            duree: parseFloat(slot.duree),
                            semaine: slot.semaine,
                            jour: slot.jour,
                            heureDebut: slot.heure_debut,
                            heureFin: slot.heure_fin,
                            dateDebut: slot.date_debut,
                            dateFin: slot.date_fin,
                            overtime: slot.overtime
                        }));
                    return {
                        id: op.id,  // ID stable pour upsert
                        type: op.type,
                        dureeTotal: parseFloat(op.duree_total),
                        dureeOriginal: parseFloat(op.duree_original),
                        dureeOverride: op.duree_override ? parseFloat(op.duree_override) : null,
                        overrideTimestamp: op.override_timestamp,
                        progressionReelle: parseFloat(op.progression_reelle),
                        statut: op.statut,
                        slots: opSlots
                    };
                });

            return {
                id: cmd.id,
                client: cmd.client_name,
                dateLivraison: cmd.date_livraison,
                statut: cmd.statut,
                materiau: cmd.materiau,
                poids: parseFloat(cmd.poids),
                refCdeClient: cmd.ref_cde_client,
                ressource: cmd.ressource,
                semaineAffectee: cmd.semaine_affectee,
                operations: cmdOperations
            };
        });

        return result;
    }

    // Migrer les données localStorage vers Supabase
    async migrateToSupabase() {
        if (!supabaseClient) return;

        console.log('🔄 Migration localStorage → Supabase...');
        try {
            for (const cmd of commandes) {
                await this.upsertCommandeToSupabase(cmd);
            }
            console.log('✅ Migration vers Supabase terminée');
            Toast.success('Données migrées vers Supabase');
        } catch (e) {
            console.error('❌ Erreur migration Supabase:', e);
        }
    }

    // Insérer ou mettre à jour une commande dans Supabase (avec IDs stables)
    async upsertCommandeToSupabase(cmd) {
        if (!supabaseClient) return;

        // 1. Upsert commande
        const { error: cmdError } = await supabaseClient
            .from('commandes')
            .upsert({
                id: cmd.id,
                client_name: cmd.client || null,
                date_livraison: cmd.dateLivraison && cmd.dateLivraison !== '' ? cmd.dateLivraison : null,
                statut: cmd.statut || null,
                materiau: cmd.materiau || null,
                poids: cmd.poids || 0,
                ref_cde_client: cmd.refCdeClient || null,
                ressource: cmd.ressource || null,
                semaine_affectee: cmd.semaineAffectee || null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'id' });

        if (cmdError) throw cmdError;
        markRecordAsModified(cmd.id); // Marquer pour ignorer notre propre event Realtime

        // 2. Upsert opérations et slots (avec nettoyage des orphelins)
        if (cmd.operations && cmd.operations.length > 0) {
            for (const op of cmd.operations) {
                // Utiliser l'ID déterministe de l'opération
                const opId = op.id;

                if (!opId) {
                    console.warn(`⚠️ Opération sans ID pour ${cmd.id}/${op.type}`);
                    continue;
                }

                const { error: opError } = await supabaseClient
                    .from('operations')
                    .upsert({
                        id: opId,
                        commande_id: cmd.id,
                        type: op.type,
                        duree_total: op.dureeTotal,
                        duree_original: op.dureeOriginal,
                        duree_override: op.dureeOverride,
                        override_timestamp: op.overrideTimestamp,
                        progression_reelle: op.progressionReelle || 0,
                        statut: op.statut || 'Non placée',
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'id' });

                if (opError) throw opError;
                markRecordAsModified(opId); // Marquer pour ignorer notre propre event Realtime

                // 3. Nettoyage des slots orphelins + upsert des slots locaux
                const { data: remoteSlots, error: fetchError } = await supabaseClient
                    .from('slots')
                    .select('id')
                    .eq('operation_id', opId);

                if (fetchError) {
                    console.warn(`⚠️ Impossible de vérifier les slots orphelins pour ${opId}:`, fetchError);
                }

                const remoteSlotIds = (remoteSlots || []).map(s => s.id);
                const localSlotIds = (op.slots || [])
                    .filter(s => s.id)
                    .map(s => s.id);

                // Supprimer les slots qui existent dans Supabase mais plus localement
                const orphanIds = remoteSlotIds.filter(id => !localSlotIds.includes(id));

                if (orphanIds.length > 0) {
                    console.log(`🧹 Suppression de ${orphanIds.length} slot(s) orphelin(s) pour ${opId}`);
                    const { error: deleteError } = await supabaseClient
                        .from('slots')
                        .delete()
                        .in('id', orphanIds);

                    if (!deleteError) {
                        orphanIds.forEach(id => markRecordAsModified(id));
                    }
                }

                // Upsert des slots locaux
                if (op.slots && op.slots.length > 0) {
                    const slotsToUpsert = op.slots
                        .filter(slot => slot.id)
                        .map(slot => ({
                            id: slot.id,
                            operation_id: opId,
                            machine_id: slot.machine ? slot.machine.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, '-') : null,
                            machine_name: slot.machine,
                            duree: slot.duree,
                            semaine: slot.semaine,
                            jour: slot.jour,
                            heure_debut: slot.heureDebut,
                            heure_fin: slot.heureFin,
                            date_debut: slot.dateDebut,
                            date_fin: slot.dateFin,
                            overtime: slot.overtime || false,
                            updated_at: new Date().toISOString()
                        }));

                    if (slotsToUpsert.length > 0) {
                        const { error: slotError } = await supabaseClient
                            .from('slots')
                            .upsert(slotsToUpsert, { onConflict: 'id' });

                        if (slotError) throw slotError;
                        slotsToUpsert.forEach(s => markRecordAsModified(s.id));
                    }
                }
            }
        }
    }

    // Supprimer un slot de Supabase
    async deleteSlotFromSupabase(slotId) {
        if (!supabaseClient || !slotId) return;

        try {
            const { error } = await supabaseClient
                .from('slots')
                .delete()
                .eq('id', slotId);

            if (error) throw error;
            markRecordAsModified(slotId); // Marquer pour ignorer notre propre event Realtime
            console.log(`🗑️ Slot ${slotId} supprimé de Supabase`);
        } catch (e) {
            console.error('❌ Erreur suppression slot Supabase:', e);
        }
    }

    // Supprimer tous les slots d'une opération dans Supabase
    async deleteAllSlotsForOperation(operationId) {
        if (!supabaseClient || !operationId) return;

        try {
            const { error } = await supabaseClient
                .from('slots')
                .delete()
                .eq('operation_id', operationId);

            if (error) throw error;
            markRecordAsModified(operationId); // Marquer l'opération pour ignorer les events de ses slots
            console.log(`🗑️ Tous les slots de ${operationId} supprimés de Supabase`);
        } catch (e) {
            console.error('❌ Erreur suppression slots Supabase:', e);
        }
    }

    cleanupPastSystemEvents() {
        const now = new Date();

        // Calculer la date limite (3 semaines en arrière)
        const threeWeeksAgo = new Date(now);
        threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
        const limitDateStr = threeWeeksAgo.toISOString().split('T')[0];

        systemEvents = systemEvents.filter(event => {
            // === FORMAT V2 (multi-jours) ===
            if (isMultiDayEvent(event)) {
                // Garder si dateEnd >= date limite (3 semaines en arrière)
                return event.dateEnd >= limitDateStr;
            }

            // === FORMAT V1 (ancien) ===
            if (event.dateStr) {
                return event.dateStr >= limitDateStr;
            }

            // Fallback sur l'ancienne logique par semaine pour très vieux événements
            const currentWeek = getWeekNumber(now);
            let evtW = event.week;
            const curW = currentWeek;

            if (curW > 40 && evtW < 10) evtW += 52;
            else if (curW < 10 && evtW > 40) evtW -= 52;

            // Garder si semaine >= currentWeek - 3
            return evtW >= curW - 3;
        });

        saveSystemEvents();
    }

    // Méthode 3: Sync avec Supabase (source primaire)
    async syncWithSupabase() {
        if (!supabaseClient) {
            this.updateSyncIndicator('offline', 'Supabase non disponible');
            return;
        }

        this.updateSyncIndicator('syncing', 'Synchronisation...');

        try {
            const remoteData = await this.loadCommandesFromSupabase();

            if (remoteData && remoteData.length > 0) {
                // Merge logic - Supabase est maintenant la source de vérité
                this.mergeData(commandes, remoteData);

                this.saveLocalData();
                this.updateSyncIndicator('synced', 'Synchronisé');
                this.lastSyncTime = new Date();
                refresh();
                console.log('✅ Sync Supabase terminée');
            } else {
                this.updateSyncIndicator('synced', 'À jour (vide)');
                console.log('ℹ️ Supabase: aucune commande active');
            }
        } catch (error) {
            console.error('❌ Sync Supabase failed:', error);
            this.updateSyncIndicator('error', 'Erreur Sync');
            Toast.warning('Synchronisation échouée. Mode hors ligne.');
        }
    }

    // Force full sync depuis Supabase
    async forceFullSync() {
        Toast.info('Rechargement complet depuis Supabase...');
        commandes = []; // Reset
        await this.syncWithSupabase();
    }

    // Méthode 5: Merge intelligent avec nettoyage des commandes obsolètes
    mergeData(localData, remoteData) {
        // Stratégie:
        // - Remote est maître pour la liste des commandes et leurs détails (poids, délais)
        // - Local est maître pour le PLANNING (slots) car le Sheet V1 ne les a pas
        // - Nettoyage : supprimer les commandes locales absentes du serveur (livrées/terminées)

        const localMap = new Map(localData.map(c => [c.id, c]));
        const remoteIds = new Set(remoteData.map(c => c.id));
        let updatedCount = 0;
        let newCount = 0;
        let cleanedCount = 0;

        // === NETTOYAGE DES COMMANDES OBSOLÈTES ===
        // Supprimer les commandes locales qui ne sont plus sur le serveur
        // SAUF si elles sont "Planifiée" avec des modifications locales non-sync
        localData.forEach(localCmd => {
            if (!remoteIds.has(localCmd.id)) {
                // Cette commande n'existe plus côté serveur (probablement Livrée/Terminée)
                const hasLocalModifications = localCmd.statut === 'Planifiée' &&
                    localCmd.operations?.some(op => op.slots && op.slots.length > 0);

                if (hasLocalModifications) {
                    // Garder cette commande - elle a des planifications locales non-sync
                    console.log(`⚠️ Commande ${localCmd.id} absente du serveur mais conservée (planning local actif)`);
                } else {
                    // Supprimer cette commande - elle n'est plus active
                    cleanedCount++;
                    console.log(`🗑️ Commande ${localCmd.id} supprimée (plus sur le serveur)`);
                }
            }
        });

        if (cleanedCount > 0) {
            console.log(`🧹 Nettoyage: ${cleanedCount} commande(s) obsolète(s) supprimée(s)`);
        }

        // On reconstruit la liste commandes en se basant sur le Remote
        const merged = remoteData.map(remoteCmd => {
            const localCmd = localMap.get(remoteCmd.id);
            
            if (localCmd) {
                // Detection simple de changement (pour l'info utilisateur)
                // Note: remoteCmd contient déjà les nouvelles valeurs du Sheet (Poids, Date, etc.)
                if (localCmd.poids !== remoteCmd.poids || 
                    localCmd.dateLivraison !== remoteCmd.dateLivraison ||
                    localCmd.statut !== remoteCmd.statut) {
                    updatedCount++;
                }

                // La commande existe déjà en local -> On préserve le planning (slots) et les overrides
                remoteCmd.operations.forEach(remoteOp => {
                    const localOp = localCmd.operations.find(op => op.type === remoteOp.type);

                    // Stocker la nouvelle valeur GSheet comme original
                    remoteOp.dureeOriginal = remoteOp.dureeTotal;

                    if (localOp) {
                        // Préserver les slots locaux
                        if (localOp.slots && localOp.slots.length > 0) {
                            remoteOp.slots = localOp.slots;
                            remoteOp.statut = localOp.statut;
                            remoteOp.progressionReelle = localOp.progressionReelle;
                        }

                        // Préserver les overrides de temps (LOCAL PRIORITAIRE)
                        if (localOp.dureeOverride !== null && localOp.dureeOverride !== undefined) {
                            remoteOp.dureeOverride = localOp.dureeOverride;
                            remoteOp.overrideTimestamp = localOp.overrideTimestamp;
                            remoteOp.dureeTotal = localOp.dureeOverride; // L'override devient la durée effective
                        } else {
                            remoteOp.dureeOverride = null;
                            remoteOp.overrideTimestamp = null;
                        }
                    } else {
                        // Nouvelle opération - initialiser les champs override
                        remoteOp.dureeOverride = null;
                        remoteOp.overrideTimestamp = null;
                    }
                });

                // Si la commande était "Planifiée" localement, on garde ce statut global
                // sauf si le remote dit "Livrée" ou "Terminée" (force override)
                if (localCmd.statut === 'Planifiée' && remoteCmd.statut !== 'Livrée' && remoteCmd.statut !== 'Terminée') {
                    remoteCmd.statut = 'Planifiée';
                }

                // === PRÉSERVER semaineAffectee (workflow 2 étapes) ===
                // Le champ semaineAffectee est local uniquement, on le préserve toujours
                if (localCmd.semaineAffectee !== undefined && localCmd.semaineAffectee !== null) {
                    remoteCmd.semaineAffectee = localCmd.semaineAffectee;
                } else {
                    remoteCmd.semaineAffectee = null;
                }
            } else {
                // Nouvelle commande - initialiser les champs override pour toutes les opérations
                newCount++;
                remoteCmd.operations.forEach(op => {
                    op.dureeOriginal = op.dureeTotal;
                    op.dureeOverride = null;
                    op.overrideTimestamp = null;
                });
                // Nouvelle commande = pas encore affectée à une semaine
                remoteCmd.semaineAffectee = null;
            }
            return remoteCmd;
        });
        
        commandes = merged;
        console.log(`✅ Merge: ${newCount} nouvelles, ${updatedCount} mises à jour, ${cleanedCount} nettoyées.`);

        if (newCount > 0 || updatedCount > 0 || cleanedCount > 0) {
            let msg = `Sync: ${newCount} nouvelles, ${updatedCount} mises à jour`;
            if (cleanedCount > 0) msg += `, ${cleanedCount} nettoyées`;
            Toast.success(msg);
        } else {
            Toast.info('Sync: Aucune modification de données détectée.');
        }
    }

    // Méthode 6: Sauvegarde locale (Supabase + localStorage)
    saveLocalData() {
        // Toujours sauvegarder en localStorage (backup)
        try {
            const dataStr = JSON.stringify(commandes);
            localStorage.setItem(this.STORAGE_KEY, dataStr);

            // Backup occasionnel
            if (Math.random() < 0.1) { // 10% chance
                localStorage.setItem(this.BACKUP_KEY, dataStr);
            }
        } catch (e) {
            console.error('❌ Quota exceeded or save error:', e);
            Toast.error('Erreur sauvegarde locale (Quota ?)');
        }

        // Sauvegarder vers Supabase en arrière-plan
        if (supabaseClient) {
            this.saveToSupabaseDebounced();
        }
    }

    // Debounce pour éviter trop d'appels Supabase
    saveToSupabaseDebounced() {
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
        }
        this._saveTimeout = setTimeout(() => {
            this.saveAllToSupabase();
        }, 500); // Attendre 500ms d'inactivité avant de sauvegarder
    }

    // Sauvegarder vers Supabase (uniquement les commandes modifiées)
    async saveAllToSupabase() {
        if (!supabaseClient) return;
        if (_dirtyCommandeIds.size === 0) return; // Rien à sauvegarder

        const idsToSync = [..._dirtyCommandeIds];
        _dirtyCommandeIds.clear();

        try {
            console.log(`💾 Supabase: ${idsToSync.length} commande(s) modifiée(s)`);

            for (const cmdId of idsToSync) {
                const cmd = commandes.find(c => c.id === cmdId);
                if (cmd) {
                    await this.upsertCommandeToSupabase(cmd);
                }
            }
        } catch (e) {
            console.error('❌ Erreur sauvegarde Supabase:', e);
            // Re-marquer les IDs en erreur pour retenter
            idsToSync.forEach(id => _dirtyCommandeIds.add(id));
        }
    }

    // Méthode 6b: Statistiques de stockage localStorage
    // Retourne les stats détaillées sur l'utilisation du localStorage
    getStorageStats() {
        const MAX_STORAGE = 5 * 1024 * 1024; // 5 MB limite localStorage

        // Calculer la taille des commandes
        const commandesStr = localStorage.getItem(this.STORAGE_KEY) || '[]';
        const commandesSize = new Blob([commandesStr]).size;
        const commandesCount = commandes.length;

        // Calculer la taille des événements système
        const eventsStr = localStorage.getItem('etm_system_events') || '[]';
        const eventsSize = new Blob([eventsStr]).size;
        const eventsCount = systemEvents?.length || 0;

        // Calculer la taille totale utilisée par l'app
        const backupStr = localStorage.getItem(this.BACKUP_KEY) || '';
        const backupSize = new Blob([backupStr]).size;
        const metadataStr = localStorage.getItem('etm_sync_metadata') || '';
        const metadataSize = new Blob([metadataStr]).size;

        const totalUsed = commandesSize + eventsSize + backupSize + metadataSize;
        const percentUsed = (totalUsed / MAX_STORAGE * 100);
        const remainingMB = ((MAX_STORAGE - totalUsed) / (1024 * 1024));

        return {
            commandes: {
                count: commandesCount,
                sizeKB: (commandesSize / 1024).toFixed(2)
            },
            events: {
                count: eventsCount,
                sizeKB: (eventsSize / 1024).toFixed(2)
            },
            backup: {
                sizeKB: (backupSize / 1024).toFixed(2)
            },
            totalUsedKB: (totalUsed / 1024).toFixed(2),
            percentUsed: percentUsed.toFixed(1),
            remainingMB: remainingMB.toFixed(2),
            maxMB: 5
        };
    }

    // Méthode 6c: Nettoyage manuel des commandes livrées/terminées
    // Supprime les commandes avec statut "Livrée" ou "Terminée" plus vieilles que daysToKeep jours
    cleanupDeliveredOrders(daysToKeep = 30) {
        const now = new Date();
        const limitDate = new Date(now);
        limitDate.setDate(limitDate.getDate() - daysToKeep);

        const initialCount = commandes.length;
        let removedCount = 0;

        commandes = commandes.filter(cmd => {
            // Garder si statut n'est pas "Livrée" ou "Terminée"
            if (cmd.statut !== 'Livrée' && cmd.statut !== 'Terminée') {
                return true;
            }

            // Vérifier la date de livraison
            const dateLivraison = new Date(cmd.dateLivraison);
            if (isNaN(dateLivraison.getTime())) {
                // Pas de date valide, garder par sécurité
                return true;
            }

            // Supprimer si plus vieille que la limite
            if (dateLivraison < limitDate) {
                removedCount++;
                console.log(`🗑️ Commande ${cmd.id} supprimée (${cmd.statut} depuis ${cmd.dateLivraison})`);
                return false;
            }

            return true;
        });

        if (removedCount > 0) {
            this.saveLocalData();
            Toast.success(`${removedCount} commande(s) archivée(s) supprimée(s)`);
            console.log(`🧹 Nettoyage manuel: ${removedCount}/${initialCount} commandes supprimées`);
        } else {
            Toast.info('Aucune commande archivée à nettoyer');
        }

        return removedCount;
    }

    // Méthode 7: Auto-sync périodique avec Supabase
    startAutoSyncSupabase() {
        if (this.syncInterval) clearInterval(this.syncInterval);
        // Sync moins fréquente car Realtime gère les mises à jour
        this.syncInterval = setInterval(() => {
            this.syncWithSupabase();
        }, 10 * 60 * 1000); // 10 minutes (Realtime fait le reste)
    }

    // Méthode 8: Sync manuelle
    manualSync() {
        Toast.info('Synchronisation Supabase...');
        this.syncWithSupabase();
    }

    // Méthode 9: Mise à jour indicateur UI
    updateSyncIndicator(status, message) {
        const el = document.getElementById('syncIndicator');
        if (!el) return;
        
        el.className = `sync-indicator sync-${status}`;
        let icon = '❓';
        if (status === 'synced') icon = '✓';
        if (status === 'syncing') icon = '↻';
        if (status === 'offline') icon = '⚠';
        if (status === 'error') icon = '✗';
        
        el.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    }

    // Méthode 10: Export
    exportLocalData() {
        const dataStr = JSON.stringify({
            version: '2.0',
            date: new Date().toISOString(),
            commandes: commandes
        }, null, 2);
        
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `etm_prod_backup_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        Toast.success('Export réussi');
    }

    // Méthode 11: Import
    importLocalData(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target.result);
                if (json.commandes && Array.isArray(json.commandes)) {
                    commandes = json.commandes;
                    markAllCommandesDirty();
                    this.saveLocalData();
                    refresh();
                    Toast.success('Import réussi');
                } else {
                    throw new Error('Format invalide');
                }
            } catch (err) {
                console.error(err);
                Toast.error('Erreur lors de l\'import');
            }
        };
        reader.readAsText(file);
    }
}

/**
 * Initialize sync event handlers
 */
function initSyncHandlers() {
    // Bouton sync manuelle
    document.getElementById('btnSyncNow')?.addEventListener('click', () => {
        syncManager.manualSync();
    });
    
    // Bouton export
    document.getElementById('btnExportData')?.addEventListener('click', () => {
        syncManager.exportLocalData();
    });
    
    // Bouton import
    document.getElementById('btnImportData')?.addEventListener('click', () => {
        document.getElementById('fileImport')?.click();
    });
    
    // Input file import
    document.getElementById('fileImport')?.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            syncManager.importLocalData(e.target.files[0]);
        }
    });
    
    // Bouton nettoyage commandes archivées
    document.getElementById('btnCleanupOrders')?.addEventListener('click', () => {
        if (confirm('Supprimer les commandes Livrées/Terminées de plus de 30 jours ?')) {
            syncManager.cleanupDeliveredOrders(30);
            updateStorageIndicator(); // Mettre à jour l'indicateur après nettoyage
        }
    });

    // Toggle dropdown menu + mise à jour indicateur stockage
    document.getElementById('btnDataMenu')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelector('.dropdown')?.classList.toggle('active');
        updateStorageIndicator(); // Mettre à jour à chaque ouverture
    });
    
    // Fermer dropdown si clic ailleurs
    document.addEventListener('click', () => {
        document.querySelector('.dropdown.active')?.classList.remove('active');
    });
}

/**
 * Met à jour l'indicateur visuel de stockage dans le dropdown Data
 * Affiche l'espace utilisé avec un code couleur si > 80%
 */
function updateStorageIndicator() {
    const indicator = document.getElementById('storageIndicator');
    const textEl = document.getElementById('storageText');
    if (!indicator || !textEl || typeof syncManager === 'undefined') return;

    const stats = syncManager.getStorageStats();
    const percent = parseFloat(stats.percentUsed);

    // Formater le texte
    textEl.textContent = `${stats.totalUsedKB} KB / ${stats.maxMB} MB (${stats.percentUsed}%)`;

    // Changer la couleur si usage > 80%
    if (percent > 80) {
        indicator.style.color = '#e67e22'; // Orange warning
        indicator.style.fontWeight = '600';
    } else {
        indicator.style.color = 'var(--color-text-muted)';
        indicator.style.fontWeight = 'normal';
    }

    // Log détaillé en console pour debug
    console.log('📊 Storage Stats:', stats);
}

// ===================================
// ⚙️ SYSTEM EVENTS (MAINTENANCE & CLOSURES)
// ===================================

function saveSystemEvents() {
    // Sauvegarder en localStorage (backup)
    localStorage.setItem('etm_system_events', JSON.stringify(systemEvents));

    // Sauvegarder vers Supabase
    if (supabaseClient) {
        saveSystemEventsToSupabase();
    }
}

async function saveSystemEventsToSupabase() {
    if (!supabaseClient) return;

    try {
        // Supprimer tous les événements existants et réinsérer
        // (approche simple pour éviter la complexité de sync)
        for (const event of systemEvents) {
            const eventData = {
                id: event.id,
                type: event.type,
                name: event.name || event.reason || 'Événement',
                date_start: event.dateStart || event.dateStr,
                date_end: event.dateEnd || event.dateStr,
                start_time_first_day: event.startTimeFirstDay,
                end_time_last_day: event.endTimeLastDay,
                full_last_day: event.fullLastDay !== false,
                affected_machines: event.affectedMachines || [],
                affected_shifts: event.affectedShifts || [],
                description: event.description || event.reason,
                resolved_conflicts: event.resolvedConflicts || {},
                version: event.version || 2,
                updated_at: new Date().toISOString()
            };

            await supabaseClient
                .from('system_events')
                .upsert(eventData, { onConflict: 'id' });
        }

        console.log('✅ System events sauvegardés vers Supabase');
    } catch (e) {
        console.error('❌ Erreur sauvegarde system events Supabase:', e);
    }
}

async function loadSystemEvents() {
    // Essayer Supabase d'abord
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('system_events')
                .select('*');

            if (!error && data && data.length > 0) {
                systemEvents = data.map(e => ({
                    id: e.id,
                    type: e.type,
                    name: e.name,
                    dateStart: e.date_start,
                    dateEnd: e.date_end,
                    startTimeFirstDay: e.start_time_first_day,
                    endTimeLastDay: e.end_time_last_day,
                    fullLastDay: e.full_last_day,
                    affectedMachines: e.affected_machines || [],
                    affectedShifts: e.affected_shifts || [],
                    description: e.description,
                    resolvedConflicts: e.resolved_conflicts || {},
                    version: e.version || 2
                }));
                console.log(`✅ Loaded ${systemEvents.length} system events from Supabase`);
                // Backup en localStorage
                localStorage.setItem('etm_system_events', JSON.stringify(systemEvents));
                return;
            }
        } catch (e) {
            console.warn('⚠️ Supabase system events load failed:', e);
        }
    }

    // Fallback: localStorage
    const stored = localStorage.getItem('etm_system_events');
    if (stored) {
        systemEvents = JSON.parse(stored);
        console.log(`✅ Loaded ${systemEvents.length} system events from localStorage`);

        // Migrer vers Supabase si disponible
        if (supabaseClient && systemEvents.length > 0) {
            saveSystemEventsToSupabase();
        }
    }
}

// ===================================
// System Events v2 - Utility Functions
// ===================================

// Variable pour le mode édition
let editingEventId = null;

/**
 * Détecter si un événement est au format multi-jours (v2)
 */
function isMultiDayEvent(event) {
    return event.version === 2 || event.dateStart !== undefined;
}

/**
 * Compter les jours ouvrables entre deux dates
 */
function countWorkingDays(startDate, endDate) {
    let count = 0;
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
        const dayIdx = current.getDay();
        if (dayIdx !== 0 && dayIdx !== 6) count++;
        current.setDate(current.getDate() + 1);
    }
    return count;
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
        // Événement d'un seul jour : utiliser les heures spécifiées
        effectiveStart = event.startTimeFirstDay;
        effectiveEnd = event.endTimeLastDay;
    } else if (isFirstDay) {
        // Premier jour : début spécifié, fin = heures supp si fermeture
        effectiveStart = event.startTimeFirstDay;
        effectiveEnd = (event.type === 'fermeture')
            ? decimalToTimeString(schedule.overtimeEnd)
            : decimalToTimeString(schedule.standardEnd);
    } else if (isLastDay) {
        // Dernier jour : début normal, fin selon option fullLastDay
        effectiveStart = decimalToTimeString(schedule.start);
        if (event.fullLastDay) {
            effectiveEnd = decimalToTimeString(schedule.overtimeEnd);
        } else {
            effectiveEnd = event.endTimeLastDay;
        }
    } else {
        // Jour intermédiaire : horaires complets (avec heures supp si fermeture)
        effectiveStart = decimalToTimeString(schedule.start);
        effectiveEnd = (event.type === 'fermeture')
            ? decimalToTimeString(schedule.overtimeEnd)
            : decimalToTimeString(schedule.standardEnd);
    }

    return { effectiveStart, effectiveEnd };
}

/**
 * Expanser un événement multi-jours en liste de jours individuels pour l'affichage
 */
function expandMultiDayEvent(event) {
    if (!isMultiDayEvent(event)) {
        return [event]; // Ancien format, retourner tel quel
    }

    const expanded = [];
    let current = new Date(event.dateStart);
    const endDate = new Date(event.dateEnd);
    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

    while (current <= endDate) {
        const dayIdx = current.getDay();
        if (dayIdx !== 0 && dayIdx !== 6) { // Skip weekends
            const currentStr = current.toISOString().split('T')[0];
            const dayName = dayNames[dayIdx];
            const { effectiveStart, effectiveEnd } = getEffectiveHoursForDay(event, currentStr, dayName);

            expanded.push({
                ...event,
                _expanded: true,           // Marqueur interne
                _parentId: event.id,       // Référence vers l'événement parent
                dateStr: currentStr,
                day: dayName,
                week: getWeekNumber(current),
                year: getISOWeekYear(current),
                startTime: effectiveStart,
                endTime: effectiveEnd
            });
        }
        current.setDate(current.getDate() + 1);
    }

    return expanded;
}

/**
 * Obtenir tous les événements expansés pour l'affichage dans le planning
 */
function getExpandedSystemEvents() {
    return systemEvents.flatMap(e => expandMultiDayEvent(e));
}

function toggleMachineSelect() {
    const type = document.getElementById('sysEventType').value;
    const group = document.getElementById('sysMachineGroup');
    group.style.display = (type === 'fermeture') ? 'none' : 'block';
    updateFullLastDayVisibility();
}

function updateFullLastDayVisibility() {
    const dateStart = document.getElementById('sysDateStart').value;
    const dateEnd = document.getElementById('sysDateEnd').value;
    const type = document.getElementById('sysEventType').value;
    const group = document.getElementById('fullLastDayGroup');
    const checkbox = document.getElementById('sysFullLastDay');

    // Afficher seulement si fermeture ET multi-jours
    if (type === 'fermeture' && dateStart && dateEnd && dateStart !== dateEnd) {
        group.style.display = 'block';
    } else {
        group.style.display = 'none';
        if (checkbox) checkbox.checked = false;
    }
}

// Make globally accessible for the onchange in HTML
window.toggleMachineSelect = toggleMachineSelect;
window.updateFullLastDayVisibility = updateFullLastDayVisibility;

function openSystemEventsModal() {
    const modal = document.getElementById('modalSystemEvents');
    const machineSelect = document.getElementById('sysMachine');

    // Populate machines
    machineSelect.innerHTML = ALL_MACHINES.map(m => `<option value="${m}">${m}</option>`).join('');

    // Set default dates to Today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('sysDateStart').value = today;
    document.getElementById('sysDateEnd').value = today;

    // Réinitialiser le checkbox fullLastDay
    document.getElementById('sysFullLastDay').checked = false;
    updateFullLastDayVisibility();

    renderSystemEventsList();
    modal.classList.add('active');
}

function addSystemEvent() {
    const type = document.getElementById('sysEventType').value;
    const machine = (type === 'fermeture') ? 'ALL' : document.getElementById('sysMachine').value;
    const dateStart = document.getElementById('sysDateStart').value;
    const dateEnd = document.getElementById('sysDateEnd').value;
    const startTime = document.getElementById('sysStart').value;
    const endTime = document.getElementById('sysEnd').value;
    const reason = document.getElementById('sysReason').value || (type === 'maintenance' ? 'Maintenance' : 'Fermeture');

    if (!dateStart || !dateEnd || !startTime || !endTime) {
        alert("Veuillez saisir les dates et les horaires.");
        return;
    }

    const startDate = new Date(dateStart);
    const endDate = new Date(dateEnd);

    if (startDate > endDate) {
        alert("La date de fin doit être après la date de début.");
        return;
    }

    // Validation horaire uniquement si même jour
    if (dateStart === dateEnd) {
        const startDec = timeToDecimalHours(startTime);
        const endDec = timeToDecimalHours(endTime);
        if (endDec <= startDec) {
            alert("L'heure de fin doit être après l'heure de début.");
            return;
        }
    }

    // Compter les jours ouvrables
    const workingDaysCount = countWorkingDays(startDate, endDate);
    if (workingDaysCount === 0) {
        alert("Aucun jour ouvrable (Lundi-Vendredi) dans la période sélectionnée.");
        return;
    }

    // Créer UN SEUL événement multi-jours (format v2)
    const fullLastDay = document.getElementById('sysFullLastDay').checked;
    const newEvent = {
        id: editingEventId || ('SYS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5)),
        version: 2,
        type,
        machine,
        dateStart,
        dateEnd,
        startTimeFirstDay: startTime,
        endTimeLastDay: endTime,
        fullLastDay: fullLastDay,
        reason,
        createdAt: new Date().toISOString()
    };

    // Si mode édition, supprimer l'ancien événement
    if (editingEventId) {
        systemEvents = systemEvents.filter(e => e.id !== editingEventId);
    }

    // Résoudre les conflits avec les opérations existantes
    const totalDisplaced = resolveSystemEventConflictsV2(newEvent);

    systemEvents.push(newEvent);
    saveSystemEvents();
    renderSystemEventsList();
    refresh();

    if (totalDisplaced > 0) {
        alert(`⚠️ ${totalDisplaced} opération(s) ont été déplacées vers "Commandes à placer" suite à ce blocage.`);
    } else if (editingEventId) {
        Toast.success("Blocage modifié avec succès");
    } else {
        Toast.success(`Blocage ajouté (${workingDaysCount} jour(s) ouvrable(s))`);
    }

    // Reset form et mode édition
    editingEventId = null;
    resetSystemEventForm();
}

/**
 * Helper: Resolve conflicts when adding a system event
 * Returns count of displaced operations
 */
function resolveSystemEventConflicts(event) {
    let displacedCount = 0;
    const eventStart = timeToDecimalHours(event.startTime);
    const eventEnd = timeToDecimalHours(event.endTime);

    commandes.forEach(cmd => {
        let cmdModified = false;
        
        cmd.operations.forEach(op => {
            if (!op.slots || op.slots.length === 0) return;

            // Check if ANY slot of this operation conflicts
            const hasConflict = op.slots.some(slot => {
                // 1. Check Scope (Machine, Week, Day)
                if (slot.semaine !== event.week) return false;
                if (slot.jour !== event.day) return false;
                if (event.machine !== 'ALL' && slot.machine !== event.machine) return false;

                // 2. Check Time Overlap
                const slotStart = timeToDecimalHours(slot.heureDebut);
                const slotEnd = timeToDecimalHours(slot.heureFin);

                // Overlap condition: (StartA < EndB) && (EndA > StartB)
                return (slotStart < eventEnd - 0.001) && (slotEnd > eventStart + 0.001);
            });

            if (hasConflict) {
                // Conflict found! Unplan this operation
                // Note: We unplan the WHOLE operation to be safe and simple
                op.slots = [];
                op.statut = "Non placée";
                op.progressionReelle = 0;
                cmdModified = true;
                displacedCount++;
                console.log(`⚠️ Conflit détecté: Opération ${op.type} de ${cmd.id} retirée du planning.`);
            }
        });

        if (cmdModified) {
            // Update global status
            const anyPlaced = cmd.operations.some(op => op.slots && op.slots.length > 0);
            cmd.statut = anyPlaced ? "En cours" : "Non placée";
        }
    });

    return displacedCount;
}

/**
 * Resolve conflicts for v2 multi-day events
 * Returns count of displaced operations
 */
function resolveSystemEventConflictsV2(event) {
    let displacedCount = 0;
    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

    commandes.forEach(cmd => {
        let cmdModified = false;

        cmd.operations.forEach(op => {
            if (!op.slots || op.slots.length === 0) return;

            const hasConflict = op.slots.some(slot => {
                // Machine check
                if (event.machine !== 'ALL' && slot.machine !== event.machine) return false;

                // Obtenir la date du slot
                let slotDateStr;
                if (slot.dateDebut) {
                    slotDateStr = slot.dateDebut.split('T')[0];
                } else {
                    // Recalculer la date à partir de semaine/jour
                    const slotDate = getDateFromWeekDay(slot.semaine, slot.jour, slot.heureDebut);
                    slotDateStr = slotDate.toISOString().split('T')[0];
                }

                // Pour les événements v2 multi-jours
                if (isMultiDayEvent(event)) {
                    // Vérifier si le slot est dans la plage de dates
                    if (slotDateStr < event.dateStart || slotDateStr > event.dateEnd) {
                        return false;
                    }

                    // Calculer les horaires effectifs pour ce jour
                    const { effectiveStart, effectiveEnd } = getEffectiveHoursForDay(
                        event, slotDateStr, slot.jour
                    );

                    const eventStartDec = timeToDecimalHours(effectiveStart);
                    const eventEndDec = timeToDecimalHours(effectiveEnd);
                    const slotStart = timeToDecimalHours(slot.heureDebut);
                    const slotEnd = timeToDecimalHours(slot.heureFin);

                    return (slotStart < eventEndDec - 0.001) && (slotEnd > eventStartDec + 0.001);
                }

                // Pour les événements v1 (ancien format)
                if (slot.semaine !== event.week) return false;
                if (slot.jour !== event.day) return false;

                const eventStart = timeToDecimalHours(event.startTime);
                const eventEnd = timeToDecimalHours(event.endTime);
                const slotStart = timeToDecimalHours(slot.heureDebut);
                const slotEnd = timeToDecimalHours(slot.heureFin);

                return (slotStart < eventEnd - 0.001) && (slotEnd > eventStart + 0.001);
            });

            if (hasConflict) {
                op.slots = [];
                op.statut = "Non placée";
                op.progressionReelle = 0;
                cmdModified = true;
                displacedCount++;
                console.log(`⚠️ Conflit détecté: Opération ${op.type} de ${cmd.id} retirée du planning.`);
            }
        });

        if (cmdModified) {
            const anyPlaced = cmd.operations.some(op => op.slots && op.slots.length > 0);
            cmd.statut = anyPlaced ? "En cours" : "Non placée";
        }
    });

    return displacedCount;
}

function deleteSystemEvent(id) {
    // Supprimer de Supabase d'abord
    if (typeof deleteSystemEventFromSupabase === 'function') {
        deleteSystemEventFromSupabase(id);
    }

    systemEvents = systemEvents.filter(e => e.id !== id);
    saveSystemEvents(); // Use standalone save
    renderSystemEventsList();
    refresh();
    Toast.info("Blocage supprimé");
}

function renderSystemEventsList() {
    const container = document.getElementById('systemEventsList');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    // Filtrer : garder seulement les événements futurs ou en cours
    const activeEvents = systemEvents.filter(e => {
        if (isMultiDayEvent(e)) {
            return e.dateEnd >= todayStr;
        } else {
            return e.dateStr >= todayStr;
        }
    });

    if (activeEvents.length === 0) {
        container.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#999;">Aucun blocage actif</td></tr>';
        return;
    }

    // Tri par date de début
    const sorted = [...activeEvents].sort((a, b) => {
        const dateA = isMultiDayEvent(a) ? a.dateStart : a.dateStr;
        const dateB = isMultiDayEvent(b) ? b.dateStart : b.dateStr;
        return dateA.localeCompare(dateB);
    });

    container.innerHTML = sorted.map(e => {
        const isMultiDay = isMultiDayEvent(e);

        // Formater l'affichage de la période
        let periodDisplay;
        if (isMultiDay) {
            const start = new Date(e.dateStart);
            const end = new Date(e.dateEnd);
            const isSingleDay = e.dateStart === e.dateEnd;

            if (isSingleDay) {
                periodDisplay = `
                    <span style="font-weight:bold">${start.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'2-digit'})}</span><br>
                    <small>${e.startTimeFirstDay} - ${e.endTimeLastDay}</small>
                `;
            } else {
                periodDisplay = `
                    <span style="font-weight:bold">
                        ${start.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit'})} -
                        ${end.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'2-digit'})}
                    </span><br>
                    <small>Début: ${e.startTimeFirstDay} | Fin: ${e.endTimeLastDay}</small>
                `;
            }
        } else {
            // Ancien format
            periodDisplay = `
                ${e.dateStr ? `<span style="font-weight:bold">${new Date(e.dateStr).toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit'})}</span>` : ''}
                S${e.week} ${e.day}<br>
                <small>${e.startTime} - ${e.endTime}</small>
            `;
        }

        return `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding:10px;">
                    <span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.85em;
                                 background:${e.type === 'fermeture' ? '#f8d7da' : '#fff3cd'};
                                 color:${e.type === 'fermeture' ? '#721c24' : '#856404'};">
                        ${e.type === 'fermeture' ? 'Fermeture' : 'Maintenance'}
                    </span>
                </td>
                <td style="padding:10px; font-weight:500;">
                    ${e.machine === 'ALL' ? 'Toutes les machines' : e.machine}
                </td>
                <td style="padding:10px;">${periodDisplay}</td>
                <td style="padding:10px; color:#666;">${e.reason}</td>
                <td style="padding:10px; text-align:right;">
                    <button class="btn btn-sm btn-secondary" onclick="editSystemEvent('${e.id}')"
                            style="margin-right:5px;">Modifier</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteSystemEvent('${e.id}')">Supprimer</button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Pré-remplir le formulaire pour modifier un événement existant
 */
function editSystemEvent(id) {
    const event = systemEvents.find(e => e.id === id);
    if (!event) {
        Toast.error("Événement introuvable");
        return;
    }

    editingEventId = id;

    // Pré-remplir le type
    document.getElementById('sysEventType').value = event.type;
    toggleMachineSelect();

    // Pré-remplir la machine si pas 'ALL'
    if (event.machine !== 'ALL') {
        document.getElementById('sysMachine').value = event.machine;
    }

    // Pré-remplir les dates et horaires selon le format
    if (isMultiDayEvent(event)) {
        document.getElementById('sysDateStart').value = event.dateStart;
        document.getElementById('sysDateEnd').value = event.dateEnd;
        document.getElementById('sysStart').value = event.startTimeFirstDay;
        document.getElementById('sysEnd').value = event.endTimeLastDay;
    } else {
        // Ancien format
        document.getElementById('sysDateStart').value = event.dateStr;
        document.getElementById('sysDateEnd').value = event.dateStr;
        document.getElementById('sysStart').value = event.startTime;
        document.getElementById('sysEnd').value = event.endTime;
    }

    // Restaurer le checkbox fullLastDay et mettre à jour la visibilité
    document.getElementById('sysFullLastDay').checked = event.fullLastDay || false;
    updateFullLastDayVisibility();

    document.getElementById('sysReason').value = event.reason || '';

    // Changer le texte du bouton
    const addBtn = document.getElementById('btnAddSystemEvent');
    if (addBtn) {
        addBtn.textContent = 'Sauvegarder les modifications';
        addBtn.classList.remove('btn-primary');
        addBtn.classList.add('btn-success');
    }

    // Ajouter un bouton Annuler si pas déjà présent
    if (!document.getElementById('btnCancelEdit')) {
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'btnCancelEdit';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Annuler';
        cancelBtn.style.marginLeft = '10px';
        cancelBtn.onclick = cancelEditSystemEvent;
        if (addBtn && addBtn.parentNode) {
            addBtn.parentNode.appendChild(cancelBtn);
        }
    }

    Toast.info("Mode édition activé");
}

/**
 * Annuler le mode édition
 */
function cancelEditSystemEvent() {
    editingEventId = null;
    resetSystemEventForm();
    Toast.info("Édition annulée");
}

/**
 * Réinitialiser le formulaire après ajout/modification
 */
function resetSystemEventForm() {
    // Reset les valeurs du formulaire
    document.getElementById('sysEventType').value = 'maintenance';
    toggleMachineSelect();

    const today = new Date().toISOString().split('T')[0];
    document.getElementById('sysDateStart').value = today;
    document.getElementById('sysDateEnd').value = today;
    document.getElementById('sysStart').value = '07:30';
    document.getElementById('sysEnd').value = '16:30';
    document.getElementById('sysReason').value = '';

    // Reset le bouton
    const addBtn = document.getElementById('btnAddSystemEvent');
    if (addBtn) {
        addBtn.textContent = 'Ajouter le blocage';
        addBtn.classList.remove('btn-success');
        addBtn.classList.add('btn-primary');
    }

    // Supprimer le bouton Annuler s'il existe
    const cancelBtn = document.getElementById('btnCancelEdit');
    if (cancelBtn) {
        cancelBtn.remove();
    }
}

// Global exposure for onclick
window.deleteSystemEvent = deleteSystemEvent;
window.editSystemEvent = editSystemEvent;
window.cancelEditSystemEvent = cancelEditSystemEvent;

// ===================================
// View Toggle
// ===================================

// ===================================
// UI Rendering - Vue Liste (Enhanced)
// ===================================

// Global state for list view
let listSort = { field: 'dateLivraison', direction: 'asc' };
let listSearch = '';

/**
 * Handle List Sort Click
 */
function handleListSort(field) {
    if (listSort.field === field) {
        listSort.direction = listSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        listSort.field = field;
        listSort.direction = 'asc';
    }
    renderVueListe();
}

/**
 * Handle List Search Input
 */
function handleListSearch(e) {
    listSearch = e.target.value;
    renderVueListe();
}

/**
 * Unplan all operations for a command
 */
function unplanCommand(commandeId) {
    if (!confirm(`Voulez-vous vraiment retirer la commande ${commandeId} du planning ?\nToutes les opérations placées seront remises en "Non placée".`)) {
        return;
    }

    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) return;

    cmd.operations.forEach(op => {
        // Supprimer les slots de Supabase
        if (op.id && supabaseClient) {
            syncManager.deleteAllSlotsForOperation(op.id);
        }
        op.slots = [];
        op.statut = "Non placée";
        op.progressionReelle = 0;
    });

    // Update main status based on what logic expects (usually 'Non placée' or 'En prépa')
    // Safe default:
    cmd.statut = "Non placée";

    historyManager.saveState(`Retrait ${commandeId}`);
    saveData(commandeId);
    refresh();
    Toast.info(`Commande ${commandeId} retirée du planning`);
}

/**
 * Render List View (Smart Update)
 */
function renderVueListe() {
    const container = document.getElementById('planningContainer');
    
    // --- 1. DATA PREPARATION ---

    // Calculate Stats
    let countTotal = 0;
    let countComplete = 0;
    let countPartial = 0;
    let countNone = 0;
    
    commandes.forEach(cmd => {
        countTotal++;
        const totalOps = cmd.operations.length;
        const placedOps = cmd.operations.filter(op => op.slots && op.slots.length > 0).length;
        
        if (totalOps > 0) {
            if (placedOps === totalOps) countComplete++;
            else if (placedOps > 0) countPartial++;
            else countNone++;
        } else {
            countNone++;
        }
    });

    // Filter Logic
    let filteredCommandes = [...commandes];
    if (listSearch) {
        const term = listSearch.toLowerCase();
        filteredCommandes = filteredCommandes.filter(c => 
            c.id.toLowerCase().includes(term) || 
            c.client.toLowerCase().includes(term) ||
            c.statut.toLowerCase().includes(term) ||
            c.materiau.toLowerCase().includes(term)
        );
    }

    // Sort Logic
    filteredCommandes.sort((a, b) => {
        let valA = a[listSort.field];
        let valB = b[listSort.field];
        
        // Handle special fields
        if (listSort.field === 'dateLivraison') {
            valA = new Date(valA || '2099-12-31').getTime();
            valB = new Date(valB || '2099-12-31').getTime();
        } else if (listSort.field === 'progression') {
             valA = a.operations.filter(op => op.slots.length > 0).length / Math.max(1, a.operations.length);
             valB = b.operations.filter(op => op.slots.length > 0).length / Math.max(1, b.operations.length);
        } else if (typeof valA === 'string') {
            valA = valA.toLowerCase();
            valB = valB.toLowerCase();
        }
        
        if (valA < valB) return listSort.direction === 'asc' ? -1 : 1;
        if (valA > valB) return listSort.direction === 'asc' ? 1 : -1;
        return 0;
    });

    // --- 2. HTML GENERATION HELPERS ---

    const generateStatsHtml = () => `
        <div class="stat-tag">Total: <span>${countTotal}</span></div>
        <div class="stat-tag" style="border-color: var(--color-capacity-ok); color: #198754;">
            <span style="background:var(--color-capacity-ok); width:8px; height:8px; border-radius:50%; display:inline-block;"></span>
            Complètes: <span>${countComplete}</span>
        </div>
        <div class="stat-tag" style="border-color: var(--color-capacity-warning); color: #d63384;">
            <span style="background:var(--color-capacity-warning); width:8px; height:8px; border-radius:50%; display:inline-block;"></span>
            Partielles: <span>${countPartial}</span>
        </div>
        <div class="stat-tag" style="color: var(--color-text-secondary);">
            Non placées: <span>${countNone}</span>
        </div>
    `;

    const generateRowsHtml = () => {
        if (filteredCommandes.length === 0) {
            return `<tr><td colspan="7" class="text-center" style="padding: 32px; color: var(--color-text-secondary);">Aucune commande trouvée</td></tr>`;
        }

        return filteredCommandes.map(cmd => {
            const isPlaced = cmd.operations.some(op => op.slots.length > 0);
            
            // Status Class
            let statusClass = 'non-placee';
            const s = cmd.statut.toLowerCase();
            if (s.includes('planifi')) statusClass = 'planifiee';
            else if (s.includes('cours')) statusClass = 'en-cours';
            else if (s.includes('livr')) statusClass = 'livree';
            else if (s.includes('termin')) statusClass = 'livree';
            
            // Operations Visualization
            let opsVizHtml = '<div class="ops-viz">';
            const requiredOps = ['Cisaillage', 'Poinçonnage', 'Pliage'];
            requiredOps.forEach(type => {
                const op = cmd.operations.find(o => o.type === type);
                if (op) {
                    const isOpPlaced = op.slots && op.slots.length > 0;
                    const typeClass = type.toLowerCase().replace('ç', 'c').replace('é', 'e');
                    const label = type.substring(0, 2);
                    opsVizHtml += `<div class="op-dot ${typeClass} ${isOpPlaced ? 'placed' : ''}" title="${type}: ${isOpPlaced ? 'Planifié' : 'À planifier'}">${label}</div>`;
                } else {
                     opsVizHtml += `<div class="op-dot" style="opacity:0.3" title="Non requis">-</div>`;
                }
            });
            opsVizHtml += '</div>';

            return `
                <tr>
                    <td><strong>${cmd.id}</strong></td>
                    <td>${cmd.client}</td>
                    <td>${formatDate(cmd.dateLivraison)}</td>
                    <td>${cmd.poids}kg ${cmd.materiau}</td>
                    <td><span class="status-badge ${statusClass}">${cmd.statut}</span></td>
                    <td>${opsVizHtml}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="showCommandeDetails('${cmd.id}')">Détails</button>
                        ${isPlaced ? `<button class="btn btn-sm btn-danger" onclick="unplanCommand('${cmd.id}')" style="margin-left: 8px;">Retirer</button>` : ''}
                    </td>
                </tr>
            `;
        }).join('');
    };

    // --- 3. DOM UPDATE ---
    
    const existingView = document.querySelector('.vue-liste');
    const isUpdate = existingView && container.contains(existingView);

    if (isUpdate) {
        // A. Smart Update: Only update dynamic parts
        
        // 1. Update Stats
        existingView.querySelector('.list-stats').innerHTML = generateStatsHtml();
        
        // 2. Update Table Body
        existingView.querySelector('tbody').innerHTML = generateRowsHtml();
        
        // 3. Update Header Classes (Sort Icons)
        const headers = existingView.querySelectorAll('.sort-header');
        headers.forEach(th => {
            th.classList.remove('asc', 'desc'); // Reset
            // Simple mapping based on onclick attribute content or text
            const onClickAttr = th.getAttribute('onclick');
            if (onClickAttr && onClickAttr.includes(`'${listSort.field}'`)) {
                th.classList.add(listSort.direction);
            }
        });

    } else {
        // B. Initial Render: Build full skeleton
        const html = `
            <div class="vue-liste">
                <!-- Header Controls -->
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 16px; flex-wrap: wrap; gap: 16px;">
                    <div>
                        <h2 style="margin:0 0 8px 0;">Liste des Commandes</h2>
                        <div class="list-stats">
                            ${generateStatsHtml()}
                        </div>
                    </div>
                    <div class="search-box">
                        <input type="text" 
                               class="search-input" 
                               placeholder="Rechercher (Client, ID, Statut...)" 
                               value="${listSearch}"
                               oninput="handleListSearch(event)"> <!-- Focus is safe now -->
                    </div>
                </div>

                <!-- Table -->
                <div class="table-responsive">
                    <table class="commands-table">
                        <thead>
                            <tr>
                                <th class="sort-header ${listSort.field === 'id' ? listSort.direction : ''}" onclick="handleListSort('id')">Commande</th>
                                <th class="sort-header ${listSort.field === 'client' ? listSort.direction : ''}" onclick="handleListSort('client')">Client</th>
                                <th class="sort-header ${listSort.field === 'dateLivraison' ? listSort.direction : ''}" onclick="handleListSort('dateLivraison')">Livraison</th>
                                <th class="sort-header ${listSort.field === 'materiau' ? listSort.direction : ''}" onclick="handleListSort('materiau')">Matériau</th>
                                <th class="sort-header ${listSort.field === 'statut' ? listSort.direction : ''}" onclick="handleListSort('statut')">Statut Global</th>
                                <th class="sort-header ${listSort.field === 'progression' ? listSort.direction : ''}" onclick="handleListSort('progression')">Progression Production</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${generateRowsHtml()}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        container.innerHTML = html;
        
        // Restore focus if this was a full re-render triggered by search (edge case)
        if (listSearch) {
             const input = container.querySelector('.search-input');
             if(input) {
                 input.focus();
                 input.setSelectionRange(input.value.length, input.value.length);
             }
        }
    }
}

// Make functions globally accessible
window.unplanCommand = unplanCommand;
window.handleListSort = handleListSort;
window.handleListSearch = handleListSearch;

/**
 * Toggle between week and day views
 */
function toggleVue(vue) {
    vueActive = vue;

    // Update button states
    document.getElementById('btnVueSemaine')?.classList.toggle('active', vue === 'semaine');
    document.getElementById('btnVueJournee')?.classList.toggle('active', vue === 'journee');
    document.getElementById('btnVueListe')?.classList.toggle('active', vue === 'liste');

    // Render appropriate view
    if (vue === 'semaine') {
        renderVueSemaine();
    } else if (vue === 'journee') {
        renderVueJournee();
    } else if (vue === 'liste') {
        renderVueListe();
    }

    // Mettre à jour la sidebar selon la vue (workflow 2 étapes)
    renderSidebarContent(currentSearchQuery || '');
}

/**
 * Refresh all views
 * Note: ne sauvegarde PAS vers Supabase - les appelants doivent appeler saveData() explicitement
 */
function refresh() {
    if (vueActive === 'semaine') {
        renderVueSemaine();
    } else if (vueActive === 'journee') {
        renderVueJournee();
    } else if (vueActive === 'liste') {
        renderVueListe();
    }
    renderCommandesNonPlacees(currentSearchQuery || '');
    updateCurrentTime();
}

/**
 * Update current time display
 */
function updateCurrentTime() {
    const timeElement = document.getElementById('currentTime');
    if (timeElement) {
        timeElement.textContent = currentTime.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    }
}

// ===================================
// Event Handlers
// ===================================

/**
 * Initialize event handlers
 */
function initEventHandlers() {
    // View toggle buttons
    document.getElementById('btnVueSemaine')?.addEventListener('click', () => toggleVue('semaine'));
    document.getElementById('btnVueJournee')?.addEventListener('click', () => toggleVue('journee'));
    document.getElementById('btnVueListe')?.addEventListener('click', () => toggleVue('liste'));

    // Modal close buttons
    document.getElementById('btnCloseDetails')?.addEventListener('click', () => {
        document.getElementById('modalOrderDetails').classList.remove('active');
    });

    document.getElementById('btnCloseNewOrder')?.addEventListener('click', () => {
        document.getElementById('modalNewOrder').classList.remove('active');
    });

    document.getElementById('btnCancelNewOrder')?.addEventListener('click', () => {
        document.getElementById('modalNewOrder').classList.remove('active');
    });

    // New order button
    document.getElementById('btnNewOrder')?.addEventListener('click', () => {
        document.getElementById('modalNewOrder').classList.add('active');
    });

    // System events (Maintenance/Closures)
    document.getElementById('btnSystemEvents')?.addEventListener('click', openSystemEventsModal);
    document.getElementById('btnCloseSystemEvents')?.addEventListener('click', () => {
        document.getElementById('modalSystemEvents').classList.remove('active');
    });
    document.getElementById('btnAddSystemEvent')?.addEventListener('click', addSystemEvent);

    // Close modals on background click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(modal => {
                modal.classList.remove('active');
            });
        }
        
        // Undo: Ctrl + Z
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            historyManager.undo();
        }
        
        // Redo: Ctrl + Y  OR  Ctrl + Shift + Z
        if (((e.ctrlKey || e.metaKey) && e.key === 'y') || 
            ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')) {
            e.preventDefault();
            historyManager.redo();
        }
    });
}

// ===================================
// ⚡ URGENT INSERTION & OVERBOOKING LOGIC
// ===================================

let currentUrgentOrder = null;
let currentScenarios = [];
let currentScenario = null;

/**
 * Show Urgent Insertion Modal
 */
function showUrgentInsertionModal() {
    document.getElementById('modalUrgentInsertion').classList.add('active');
    
    // Reset steps
    document.querySelectorAll('.insertion-step').forEach(step => step.classList.remove('active'));
    document.getElementById('stepSelectOrder').classList.add('active');
    
    renderUrgentOrdersList();
}

/**
 * Render list of urgent orders (Unplaced or Partial)
 */
function renderUrgentOrdersList() {
    const container = document.getElementById('urgentOrdersList');
    const unplaced = getUnplacedOrders();
    
    // Filter out delivered/completed
    const candidates = unplaced.filter(cmd => 
        !cmd.statut.toLowerCase().includes('livré') && 
        !cmd.statut.toLowerCase().includes('terminé')
    );
    
    // Sort by urgency (delivery date)
    candidates.sort((a, b) => new Date(a.dateLivraison) - new Date(b.dateLivraison));
    
    if (candidates.length === 0) {
        container.innerHTML = '<p class="text-center" style="padding:20px;">Aucune commande éligible à l\'insertion urgente.</p>';
        return;
    }
    
    let html = '';
    candidates.forEach(cmd => {
        const urgency = getUrgencyLevel(cmd.dateLivraison);
        const color = urgency === 'urgente' ? '#dc3545' : (urgency === 'attention' ? '#ffc107' : '#28a745');
        
        html += `
            <div class="urgent-order-item" onclick="selectUrgentOrder('${cmd.id}')" id="order-${cmd.id}">
                <div>
                    <div style="font-weight:bold;">${cmd.id} - ${cmd.client}</div>
                    <div style="font-size:0.9em; color:#666;">${cmd.poids}kg ${cmd.materiau}</div>
                </div>
                <div style="text-align:right;">
                    <div style="color:${color}; font-weight:bold;">${formatDate(cmd.dateLivraison)}</div>
                    <div style="font-size:0.8em;">${cmd.statut}</div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

/**
 * Handle Order Selection
 */
function selectUrgentOrder(orderId) {
    document.querySelectorAll('.urgent-order-item').forEach(el => el.classList.remove('selected'));
    document.getElementById(`order-${orderId}`).classList.add('selected');
    
    currentUrgentOrder = commandes.find(c => c.id === orderId);
    document.getElementById('btnNextToScenarios').disabled = false;
}

/**
 * Go to Scenario Selection Step
 */
function handleNextToScenarios() {
    if (!currentUrgentOrder) return;
    
    document.getElementById('stepSelectOrder').classList.remove('active');
    document.getElementById('stepSelectScenario').classList.add('active');
    
    // Generate Scenarios
    currentScenarios = generateInsertionScenarios(currentUrgentOrder);
    renderScenariosSelection();
}

/**
 * Generate 4 Insertion Scenarios
 */
function generateInsertionScenarios(order) {
    const scenarios = [];

    // Scénario 1 : Insertion Optimisée (Déplacement Intelligent)
    const planSmart = calculateSmartInsertionPlan(order);

    // Debug logging
    console.log('[SMART] Plan result:', planSmart);

    if (planSmart.feasible) {
        const feasibility = planSmart.totalImpact.opsDisplaced <= 2 ? 'Haute' : 'Moyenne';
        const impactScore = Math.min(5, Math.max(1, 3 - planSmart.totalImpact.opsDisplaced + (planSmart.totalImpact.maxDelay === 0 ? 1 : 0)));

        scenarios.push({
            id: 'SMART',
            name: 'Insertion Optimisée (Déplacement)',
            strategy: 'Déplacement intelligent des opérations selon leur marge et priorité',
            badge: 'badge-B',
            icon: '🎯',
            metrics: {
                feasibility: feasibility,
                impact_score: impactScore,
                details: `${planSmart.totalImpact.opsDisplaced} ops déplacées, ${planSmart.totalImpact.maxDelay} min retard, +${Math.round(planSmart.totalImpact.maxDisplacement)} min déplacement max`
            },
            actions: {
                slots: planSmart.slots,
                displacements: planSmart.displacements
            },
            capacity_impact: { overbooking: false, overtime_needed: false },
            totalImpact: planSmart.totalImpact,
            warnings: planSmart.totalImpact.opsDisplaced > 0 ? [`${planSmart.totalImpact.opsDisplaced} opérations seront déplacées`] : []
        });
        console.log('[SMART] Scenario added successfully');
    } else {
        console.log('[SMART] Scenario NOT feasible, reason:', planSmart.reason);
    }

    // Scénario 2 : Urgence Absolue (Overbooking/Heures Sup)
    const planPriority = calculateOverbookingPlan(order);

    if (planPriority.feasible) {
        scenarios.push({
            id: 'PRIO',
            name: 'Prioritaire (Heures Sup)',
            strategy: 'Insertion prioritaire avec heures supplémentaires si nécessaire',
            badge: 'badge-C',
            icon: '🔥',
            metrics: {
                feasibility: 'Haute',
                impact_score: 5,
                overtime_hours: planPriority.totalOvertimeHours,
                details: `${planPriority.totalOvertimeHours}h supp. estimées`
            },
            actions: { overbooking_slots: planPriority.slots },
            capacity_impact: { overbooking: true, overtime_needed: true },
            warnings: ['Vérifiez la disponibilité des opérateurs']
        });
    }

    // Si aucun scénario n'est faisable
    if (scenarios.length === 0) {
        scenarios.push({
            id: 'ERR',
            name: 'Impossible',
            strategy: 'Aucun créneau trouvé',
            badge: 'badge-A',
            icon: '❌',
            disabled: true,
            metrics: { feasibility: 'Nulle', impact_score: 0 },
            reason: planSmart.reason || planPriority.reason || 'Conflit insoluble'
        });
    }

    // Ordre d'affichage : Si SMART sans retard et peu d'impact, le mettre en premier
    if (scenarios.length > 1 && scenarios[0].id === 'SMART') {
        if (scenarios[0].totalImpact.maxDelay === 0 && scenarios[0].totalImpact.opsDisplaced <= 2) {
            // SMART déjà en premier, c'est bon
        } else {
            // Mettre PRIO en premier
            scenarios.reverse();
        }
    }

    return scenarios;
}

// --- CALCULATION FUNCTIONS ---

function calculateNormalPlan(order) {
    return true; // Stub
}

function getMachinesForOp(type) {
    if (type === 'Cisaillage') return MACHINES.cisailles;
    if (type === 'Poinçonnage') return MACHINES.poinconneuses;
    if (type === 'Pliage') return MACHINES.plieuses;
    return [];
}

/**
 * Scénario B: Earliest Start (Trous Standard)
 */
function calculateEarliestStartPlan(order) {
    const result = { feasible: true, slots: [] };
    const now = new Date();
    let currentSimulatedTime = { week: semaineSelectionnee, year: anneeSelectionnee, dayIdx: 0, minHour: 0 };

    if (getWeekNumber(now) === semaineSelectionnee) {
        let todayIdx = now.getDay() - 1;
        if (todayIdx === -1) todayIdx = 6;
        currentSimulatedTime.dayIdx = todayIdx;
        currentSimulatedTime.minHour = now.getHours() + now.getMinutes() / 60;
    }

    const sortedOperations = [...order.operations].sort((a, b) => {
        const orderMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
        return (orderMap[a.type] || 99) - (orderMap[b.type] || 99);
    });

    for (const op of sortedOperations) {
        if (op.slots.length > 0) continue;

        let placed = false;
        let startDayIdx = currentSimulatedTime.dayIdx;

        for (let d = startDayIdx; d < 5; d++) {
            const dayName = DAYS_OF_WEEK[d];
            const minStart = (d === currentSimulatedTime.dayIdx) ? currentSimulatedTime.minHour : 0;

            let machines = getMachinesForOp(op.type);
            for (const machine of machines) {
                // Cherche gap standard (pas heures sup)
                const slot = findUrgentSlot(machine, dayName, op.dureeTotal, minStart, currentSimulatedTime.week, currentSimulatedTime.year);
                // Vérifier si slot est dans heures standard (fin < 16.5 ou 12.0)
                const dayEndStandard = dayName === 'Vendredi' ? 12.0 : 16.5;
                
                if (slot && slot.endDecimal <= dayEndStandard) {
                    result.slots.push({
                        machine: machine, day: dayName, hours: op.dureeTotal, 
                        timeRange: slot.range, opType: op.type
                    });
                    currentSimulatedTime.dayIdx = d;
                    currentSimulatedTime.minHour = slot.endDecimal;
                    placed = true;
                    break;
                }
            }
            if (placed) break;
        }
        if (!placed) { result.feasible = false; break; }
    }
    return result;
}

/**
 * Scénario C: Split
 */
function calculateSplitPlan(order) {
    const result = { feasible: true, slots: [], isSplit: false, splitCount: 0 };
    const now = new Date();
    let currentSimulatedTime = { week: semaineSelectionnee, year: anneeSelectionnee, dayIdx: 0, minHour: 0 };

    if (getWeekNumber(now) === semaineSelectionnee) {
        let todayIdx = now.getDay() - 1;
        if (todayIdx === -1) todayIdx = 6;
        currentSimulatedTime.dayIdx = todayIdx;
        currentSimulatedTime.minHour = now.getHours() + now.getMinutes() / 60;
    }

    const sortedOperations = [...order.operations].sort((a, b) => {
        const orderMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
        return (orderMap[a.type] || 99) - (orderMap[b.type] || 99);
    });

    for (const op of sortedOperations) {
        if (op.slots.length > 0) continue;

        let remainingDuration = op.dureeTotal;
        let startDayIdx = currentSimulatedTime.dayIdx;
        let opSplits = 0;

        for (let d = startDayIdx; d < 5 && remainingDuration > 0.01; d++) {
            const dayName = DAYS_OF_WEEK[d];
            const minStart = (d === currentSimulatedTime.dayIdx) ? currentSimulatedTime.minHour : 0;

            let machines = getMachinesForOp(op.type);
            for (const machine of machines) {
                // Chercher petit trou
                const slot = findUrgentSlot(machine, dayName, Math.min(remainingDuration, 0.5), minStart, currentSimulatedTime.week, currentSimulatedTime.year); // Min 30m check
                
                if (slot) {
                    result.slots.push({
                        machine: machine, day: dayName, hours: Math.min(remainingDuration, 0.5),
                        timeRange: slot.range, opType: op.type
                    });
                    remainingDuration -= 0.5;
                    currentSimulatedTime.dayIdx = d;
                    currentSimulatedTime.minHour = slot.endDecimal;
                    opSplits++;
                    if (remainingDuration <= 0.01) break;
                }
            }
        }
        
        if (opSplits > 1) {
            result.isSplit = true;
            result.splitCount += (opSplits - 1);
        }
        
        if (remainingDuration > 0.01) { result.feasible = false; break; }
    }
    return result;
}

/**
 * Scénario B: Cherche le premier trou disponible (sans fractionnement)
 */
function calculateEarliestStartPlan(order) {
    const result = { feasible: true, slots: [] };
    let currentTime = { week: semaineSelectionnee, dayIdx: 0, minHour: 0 };
    
    // Ajuster au temps réel
    const now = new Date();
    if (getWeekNumber(now) === semaineSelectionnee) {
        let todayIdx = now.getDay() - 1;
        if (todayIdx === -1) todayIdx = 6;
        currentTime.dayIdx = todayIdx;
        currentTime.minHour = now.getHours() + now.getMinutes() / 60;
    }

    for (const op of order.operations) {
        let placed = false;
        let startDayIdx = currentTime.dayIdx;
        
        // Chercher sur les 5 prochains jours
        for (let d = startDayIdx; d < startDayIdx + 5; d++) {
            const dayIdx = d % 5; // Wrap week if needed, simplified here to current week
            const dayName = DAYS_OF_WEEK[dayIdx];
            const minStart = (dayIdx === currentTime.dayIdx) ? currentTime.minHour : 7.5; // 7.5 = start day

            // Chercher machine
            let machines = getMachinesForOp(op.type);
            for (const machine of machines) {
                // On cherche un trou STANDARD (pas heures sup, pas étendu)
                // Donc on utilise findFirstAvailableGap mais avec contrainte minStart
                const gap = findStandardGap(machine, dayName, semaineSelectionnee, anneeSelectionnee, op.dureeTotal, minStart);
                if (gap) {
                    result.slots.push({
                        machine: machine,
                        day: dayName,
                        hours: op.dureeTotal,
                        timeRange: formatTimeRange(gap.start, gap.end),
                        opType: op.type
                    });
                    currentTime.dayIdx = dayIdx;
                    currentTime.minHour = gap.end;
                    placed = true;
                    break;
                }
            }
            if (placed) break;
        }
        if (!placed) { result.feasible = false; break; }
    }
    return result;
}

/**
 * Scénario C: Fractionnement
 */
function calculateSplitPlan(order) {
    const result = { feasible: true, slots: [], isSplit: false, splitCount: 0 };
    let currentTime = { week: semaineSelectionnee, dayIdx: 0, minHour: 0 };
    
    // Ajuster temps réel
    const now = new Date();
    if (getWeekNumber(now) === semaineSelectionnee) {
        let todayIdx = now.getDay() - 1;
        if (todayIdx === -1) todayIdx = 6;
        currentTime.dayIdx = todayIdx;
        currentTime.minHour = now.getHours() + now.getMinutes() / 60;
    }

    for (const op of order.operations) {
        let remainingDuration = op.dureeTotal;
        let startDayIdx = currentTime.dayIdx;
        let opSplits = 0;

        // On essaye de caser des morceaux
        for (let d = startDayIdx; d < startDayIdx + 5 && remainingDuration > 0.1; d++) {
            const dayIdx = d % 5;
            const dayName = DAYS_OF_WEEK[dayIdx];
            const minStart = (dayIdx === currentTime.dayIdx) ? currentTime.minHour : 7.5;

            let machines = getMachinesForOp(op.type);
            for (const machine of machines) {
                // Trouver TOUS les trous disponibles sur cette machine ce jour là
                const gaps = findAllGaps(machine, dayName, semaineSelectionnee, anneeSelectionnee, minStart);
                
                for (const gap of gaps) {
                    const usable = Math.min(gap.duration, remainingDuration);
                    if (usable >= 0.5) { // Minimum 30 min pour un morceau
                        result.slots.push({
                            machine: machine,
                            day: dayName,
                            hours: usable,
                            timeRange: formatTimeRange(gap.start, gap.start + usable),
                            opType: op.type
                        });
                        remainingDuration -= usable;
                        currentTime.dayIdx = dayIdx;
                        currentTime.minHour = gap.start + usable;
                        opSplits++;
                        if (remainingDuration <= 0.1) break;
                    }
                }
                if (remainingDuration <= 0.1) break;
            }
        }
        
        if (opSplits > 1) {
            result.isSplit = true;
            result.splitCount += (opSplits - 1);
        }

        if (remainingDuration > 0.1) { result.feasible = false; break; }
    }
    return result;
}

// --- Helpers ---

function getMachinesForOp(type) {
    if (type === 'Cisaillage') return MACHINES.cisailles;
    if (type === 'Poinçonnage') return MACHINES.poinconneuses;
    if (type === 'Pliage') return MACHINES.plieuses;
    return [];
}

function findStandardGap(machine, day, week, year, duration, minStart) {
    // 1. Get busy slots
    const dayStart = 7.5;
    const dayEnd = day === 'Vendredi' ? 12.0 : 16.5;
    if (minStart >= dayEnd) return null;

    const startSearch = Math.max(dayStart, minStart);

    // Get occupied slots logic (same as findUrgentSlot but restricted to standard hours)
    // ... (Simplified: assume we use existing findFirstAvailableGap logic but constrained)

    // For this prototype, we reuse findUrgentSlot BUT we cap the dayEnd strictly
    // to simulate "Standard hours only"
    const slot = findUrgentSlot(machine, day, duration, startSearch, week, year);

    if (slot && slot.endDecimal <= dayEnd) {
        return { start: slot.endDecimal - duration, end: slot.endDecimal };
    }
    return null;
}

function findAllGaps(machine, day, week, year, minStart) {
    // Return array of {start, end, duration}
    // Simplified: check big chunks
    const gaps = [];
    const dayEnd = day === 'Vendredi' ? 12.0 : 16.5;
    let current = Math.max(7.5, minStart);

    // Check iteratively
    while (current < dayEnd) {
        // Try to find a gap of at least 0.5h
        const slot = findUrgentSlot(machine, day, 0.5, current, week, year);
        if (slot && slot.endDecimal <= dayEnd) {
            const gapStart = slot.endDecimal - 0.5; // We found 0.5, but maybe there is more?
            // Actually findUrgentSlot returns the *first* gap that fits.
            // We need a function that returns the gap size.

            // For prototype: Assume 1h gaps found one by one
            gaps.push({ start: gapStart, end: slot.endDecimal, duration: 0.5 });
            current = slot.endDecimal;
        } else {
            current += 0.5; // Skip busy
        }
    }
    return gaps;
}

function formatTimeRange(start, end) {
    const h1 = Math.floor(start);
    const m1 = Math.round((start - h1) * 60);
    const h2 = Math.floor(end);
    const m2 = Math.round((end - h2) * 60);
    return `${h1.toString().padStart(2,'0')}:${m1.toString().padStart(2,'0')}-${h2.toString().padStart(2,'0')}:${m2.toString().padStart(2,'0')}`;
}

// ===================================================================
// SMART SCENARIO - CONSTANTS & CONFIGURATION
// ===================================================================

let SCHEDULE_CONFIG = {
    MONDAY_TO_THURSDAY: {
        start: 7.5,          // 07:30
        standardEnd: 16.5,   // 16:30
        overtimeEnd: 18.0,   // 18:00
        lunchStart: 12.5,    // 12:30
        lunchEnd: 13.0       // 13:00
    },
    FRIDAY: {
        start: 7.0,          // 07:00
        standardEnd: 12.0,   // 12:00
        overtimeEnd: 14.0,   // 14:00
        lunchStart: null,    // Pas de pause le vendredi
        lunchEnd: null
    },
    CR_THRESHOLD: 1.05,       // Critical Ratio minimum apres deplacement
    CR_FORCE_THRESHOLD: 0.95, // En mode FORCE, on accepte jusqu'a 0.95
    MAX_DISPLACEMENTS_NORMAL: 5,
    MAX_DISPLACEMENTS_FORCE: 20,
    // Fragmentation supprimee : les operations ne se splitent QUE si pause/multi-jours
    SEARCH_HORIZON_DAYS: 14
};

/**
 * Get schedule config for a specific day
 */
function getScheduleForDay(dayName) {
    if (dayName === 'Vendredi') {
        return SCHEDULE_CONFIG.FRIDAY;
    }
    return SCHEDULE_CONFIG.MONDAY_TO_THURSDAY;
}

/**
 * Retourne la plage horaire globale pour un jour (toutes equipes confondues)
 * @param {string} dayName - Jour de la semaine
 * @returns {object} { globalStart, globalEnd, shifts: [{shiftId, shiftName, start, end}], gaps: [{start, end}] }
 */
function getGlobalScheduleRangeForDay(dayName) {
    const ranges = getAvailableRangesForDay(dayName);
    if (!ranges || ranges.length === 0) {
        // Fallback sur getScheduleForDay
        const fallback = getScheduleForDay(dayName);
        return {
            globalStart: fallback.start,
            globalEnd: fallback.overtimeEnd,
            shifts: [{ shiftId: 'default', shiftName: 'Equipe Jour', start: fallback.start, end: fallback.overtimeEnd }],
            gaps: []
        };
    }

    // Trier les equipes par heure de debut
    ranges.sort((a, b) => a.start - b.start);

    const globalStart = Math.min(...ranges.map(r => r.start));
    let globalEnd = Math.max(...ranges.map(r => r.end));

    // Verifier si heures sup actives et etendre globalEnd
    if (scheduleConfig.overtime && scheduleConfig.overtime.enabled && scheduleConfig.overtime.slots) {
        const overtimeSlot = scheduleConfig.overtime.slots.find(s => s.days && s.days.includes(dayName));
        if (overtimeSlot) {
            const overtimeEnd = timeStringToDecimal(overtimeSlot.end);
            if (overtimeEnd > globalEnd) {
                globalEnd = overtimeEnd;
            }
        }
    }

    // Detecter les gaps entre equipes
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
 * Retourne TOUTES les zones bloquees pour un jour (pauses + gaps inter-equipes)
 * @param {string} day - Nom du jour
 * @returns {Array<{start, end, type, name}>}
 */
function getBlockedZonesForDay(day) {
    const blockedZones = [];

    // 1. Ajouter toutes les pauses actives
    const breaks = getActiveBreaksForDay(day);
    breaks.forEach(b => {
        blockedZones.push({
            start: timeStringToDecimal(b.start),
            end: timeStringToDecimal(b.end),
            type: 'break',
            name: b.name || 'Pause'
        });
    });

    // 2. Ajouter les gaps inter-equipes
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
 * Verifie si un temps decimal est dans une zone bloquee
 * @param {string} day - Nom du jour
 * @param {number} timeDecimal - Heure en decimal
 * @returns {object|null} La zone bloquee ou null
 */
function isTimeInBlockedZone(day, timeDecimal) {
    const zones = getBlockedZonesForDay(day);
    for (const zone of zones) {
        if (timeDecimal >= zone.start && timeDecimal < zone.end) {
            return zone;
        }
    }
    return null;
}

/**
 * Verifie si un temps est dans la zone d'heures supplementaires
 * @param {string} day - Nom du jour
 * @param {number} timeDecimal - Heure en decimal
 * @returns {boolean}
 */
function isInOvertimeZone(day, timeDecimal) {
    const ranges = getAvailableRangesForDay(day);
    if (!ranges || ranges.length === 0) {
        // Fallback sur la logique ancienne
        const schedule = getScheduleForDay(day);
        return timeDecimal >= schedule.standardEnd;
    }

    // Trouver la fin normale (derniere equipe)
    const lastShiftEnd = Math.max(...ranges.map(r => r.end));
    return timeDecimal >= lastShiftEnd;
}

/**
 * Retourne l'heure de fin des heures sup pour une equipe/jour
 * @param {string} day - Nom du jour
 * @param {string} shiftId - ID de l'equipe (optionnel)
 * @returns {number} Heure de fin en decimal
 */
function getOvertimeEndForShift(day, shiftId = null) {
    if (!scheduleConfig.overtime || !scheduleConfig.overtime.enabled) {
        // Fallback sur les valeurs par defaut
        return day === 'Vendredi' ? 14.0 : 18.0;
    }
    const slot = scheduleConfig.overtime.slots.find(s => s.days && s.days.includes(day));
    return slot ? timeStringToDecimal(slot.end) : (day === 'Vendredi' ? 14.0 : 18.0);
}

/**
 * Calculate Displaceability Score for an operation
 * Plus le score est élevé, plus l'opération peut être déplacée
 */
function calculateDisplaceabilityScore(operation, commandeData, currentDate) {
    // Calculer la date de livraison en millisecondes
    const deliveryDate = new Date(commandeData.dateLivraison);
    const now = new Date(currentDate);

    // Temps restant jusqu'à la livraison (en heures)
    const timeUntilDelivery = (deliveryDate - now) / (1000 * 60 * 60);

    // Calculer le travail restant pour cette commande (somme de toutes les opérations non placées ou partiellement placées)
    let remainingWork = 0;
    commandeData.operations.forEach(op => {
        if (op.slots && op.slots.length > 0) {
            const totalSlotted = op.slots.reduce((sum, slot) => sum + (slot.duree || 0), 0);
            remainingWork += Math.max(0, op.dureeTotal - totalSlotted);
        } else {
            remainingWork += op.dureeTotal || 0;
        }
    });

    // Si pas de travail restant, score maximal (très déplaçable)
    if (remainingWork === 0) remainingWork = 0.1; // Éviter division par zéro

    // Slack = temps disponible - travail restant (en heures)
    const slack = timeUntilDelivery - remainingWork;

    // Critical Ratio = temps disponible / travail restant
    const criticalRatio = timeUntilDelivery / remainingWork;

    // Score final : combinaison pondérée
    // Slack × 0.6 + CR × 0.4
    const score = (slack * 0.6) + (criticalRatio * 0.4);

    return {
        score,
        slack,
        criticalRatio,
        remainingWork,
        timeUntilDelivery
    };
}

/**
 * Find next available slot for displacement with robust gap finding
 * Returns: { week, year, day, startHour, endHour, isOvertime } or null
 */
function findNextAvailableSlotForDisplacement(machine, duration, startDay, startWeek, startYear, minHour, allowOvertime = true) {
    console.log(`[GAP_FINDER] Searching slot: machine=${machine}, duration=${duration}h, from ${startDay} week ${startWeek}, minHour=${minHour}, overtime=${allowOvertime}`);

    const searchHorizonDays = SCHEDULE_CONFIG.SEARCH_HORIZON_DAYS;
    let searchDate = getDateFromWeekAndDay(startWeek, startYear, startDay);
    searchDate.setHours(Math.floor(minHour), Math.round((minHour - Math.floor(minHour)) * 60), 0, 0);

    const now = new Date();

    for (let dayOffset = 0; dayOffset < searchHorizonDays; dayOffset++) {
        const weekNum = getWeekNumber(searchDate);
        const yearNum = getISOWeekYear(searchDate);
        const dayIdx = searchDate.getDay() - 1; // 0=Lun

        if (dayIdx < 0 || dayIdx > 4) {
            searchDate.setDate(searchDate.getDate() + 1);
            continue; // Skip weekend
        }

        const dayName = DAYS_OF_WEEK[dayIdx];
        const schedule = getScheduleForDay(dayName);

        // Déterminer les bornes de recherche
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

        // Ajouter les systemEvents - utilise les événements expansés pour supporter v2
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

        // Ajouter les zones bloquees comme busy slots (pauses + gaps inter-equipes)
        const blockedZones = getBlockedZonesForDay(dayName);
        blockedZones.forEach(zone => {
            busySlots.push({ start: zone.start, end: zone.end, type: zone.type });
        });

        // Trier les créneaux occupés
        busySlots.sort((a, b) => a.start - b.start);

        // Chercher des gaps
        let currentPointer = searchStartHour;

        for (const busy of busySlots) {
            if (currentPointer < busy.start) {
                const gapSize = busy.start - currentPointer;

                // Vérifier si l'opération tient dans ce gap
                if (gapSize >= duration - 0.001) {
                    const endHour = currentPointer + duration;

                    // Vérifier qu'on ne dépasse pas la fin de journée
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

        // Vérifier le dernier gap (après la dernière occupation jusqu'à la fin de journée)
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

    console.log(`[GAP_FINDER] ✗ No slot found after ${searchHorizonDays} days`);
    return null;
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

    const dayIndex = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi"].indexOf(dayName);
    const targetDate = new Date(ISOweekStart);
    targetDate.setDate(ISOweekStart.getDate() + dayIndex);

    return targetDate;
}

/**
 * Calculate Smart Insertion Plan (Scenario SMART) - REFACTORED
 * Stratégie : Déplacement intelligent des opérations existantes
 */
/**
 * Calculate Smart Insertion Plan (Scenario SMART) - V2 avec ordre des opérations
 *
 * Logique métier :
 * 1. Cisaillage → Poinçonnage → Pliage (ordre strict)
 * 2. Chaque opération commence juste après la fin de la précédente
 * 3. Le goulot est souvent sur la cisaille → on place la cisaille d'abord
 * 4. Les déplacements doivent aussi respecter l'ordre des opérations liées
 */
function calculateSmartInsertionPlan(order) {
    console.log('[SMART] ========================================');
    console.log('[SMART] V2 - Calculating plan with operation sequencing for order:', order.id);

    const result = {
        feasible: true,
        slots: [],
        displacements: [],
        totalImpact: {
            opsDisplaced: 0,
            maxDelay: 0,
            maxDisplacement: 0,
            nervosity: 0
        },
        reason: '',
        mode: 'NORMAL'
    };

    const now = new Date();
    const deliveryDate = new Date(order.dateLivraison);

    // DÉTECTION MODE FORCE
    const isLate = deliveryDate < now;
    const mode = isLate ? 'FORCE' : 'NORMAL';
    result.mode = mode;

    const crThreshold = mode === 'FORCE' ? SCHEDULE_CONFIG.CR_FORCE_THRESHOLD : SCHEDULE_CONFIG.CR_THRESHOLD;
    const maxDisplacements = mode === 'FORCE' ? SCHEDULE_CONFIG.MAX_DISPLACEMENTS_FORCE : SCHEDULE_CONFIG.MAX_DISPLACEMENTS_NORMAL;

    console.log(`[SMART] Mode: ${mode} (delivery: ${deliveryDate.toLocaleDateString()}, now: ${now.toLocaleDateString()})`);
    console.log(`[SMART] CR threshold: ${crThreshold}, Max displacements: ${maxDisplacements}`);

    // TRIER dans l'ordre métier : Cisaillage → Poinçonnage → Pliage
    const sortedOperations = [...order.operations].sort((a, b) => {
        const orderMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
        return (orderMap[a.type] || 99) - (orderMap[b.type] || 99);
    });

    console.log('[SMART] Operations order:', sortedOperations.map(op => op.type).join(' → '));

    // Contexte de séquençage : garder trace de la fin de l'opération précédente
    let sequencingContext = {
        lastEndWeek: null,
        lastEndYear: null,
        lastEndDay: null,
        lastEndHour: null
    };

    // Placer chaque opération EN SÉQUENCE
    for (let i = 0; i < sortedOperations.length; i++) {
        const urgentOp = sortedOperations[i];
        const isFirstOp = (i === 0);

        if (urgentOp.slots.length > 0) continue;

        console.log(`[SMART] --- [${i+1}/${sortedOperations.length}] Processing: ${urgentOp.type}, duration: ${urgentOp.dureeTotal}h ---`);

        // Pour la première opération (cisaille), on cherche partout
        // Pour les suivantes, on cherche juste après la précédente
        const searchContext = isFirstOp ? {
            startWeek: getWeekNumber(now),
            startYear: getISOWeekYear(now),
            startDay: null, // chercher partout
            minHour: now.getHours() + now.getMinutes() / 60
        } : {
            startWeek: sequencingContext.lastEndWeek,
            startYear: sequencingContext.lastEndYear,
            startDay: sequencingContext.lastEndDay,
            minHour: sequencingContext.lastEndHour
        };

        console.log(`[SMART] Search context:`, searchContext);

        // Placement de l'opération (le split se fera automatiquement si nécessaire)
        const placementResult = placeOperationSequentially(
            urgentOp.dureeTotal,
            urgentOp.type,
            order,
            mode,
            crThreshold,
            maxDisplacements,
            now,
            searchContext
        );

        if (!placementResult.feasible) {
            result.feasible = false;
            result.reason = placementResult.reason;
            console.log(`[SMART] ✗ Failed to place ${urgentOp.type}:`, placementResult.reason);
            return result;
        }

        // Le placement peut retourner un ou plusieurs slots (si split pause/multi-jours)
        const slots = Array.isArray(placementResult.slots) ? placementResult.slots : [placementResult.slot];

        for (const slot of slots) {
            result.slots.push({
                ...slot,
                opType: urgentOp.type
            });
        }

        result.displacements.push(...placementResult.displacements);

        // Mettre à jour le contexte pour l'opération suivante (dernier slot)
        const lastSlot = slots[slots.length - 1];
        sequencingContext = {
            lastEndWeek: lastSlot.week,
            lastEndYear: lastSlot.year,
            lastEndDay: lastSlot.day,
            lastEndHour: lastSlot.endHour || (lastSlot.startHour + lastSlot.hours)
        };

        console.log(`[SMART] Next operation will start from: ${sequencingContext.lastEndDay} week ${sequencingContext.lastEndWeek} at ${decimalToTimeString(sequencingContext.lastEndHour)}`);
    }

    // Calculer l'impact total
    result.totalImpact.opsDisplaced = result.displacements.length;
    result.totalImpact.maxDisplacement = result.displacements.length > 0 ?
        Math.max(...result.displacements.map(d => d.displacement)) : 0;
    result.totalImpact.maxDelay = 0;
    result.totalImpact.nervosity = result.displacements.length * 2 + result.totalImpact.maxDisplacement * 0.01;

    console.log(`[SMART] ✓ Plan completed successfully`);
    console.log(`[SMART] Sequence: ${result.slots.map(s => `${s.opType} ${s.day} ${s.timeRange}`).join(' → ')}`);
    console.log(`[SMART] Mode: ${result.mode}, Displacements: ${result.totalImpact.opsDisplaced}`);
    console.log('[SMART] ========================================');

    return result;
}

/**
 * Place une opération en respectant le séquençage
 */
function placeOperationSequentially(duration, opType, urgentOrder, mode, crThreshold, maxDisplacements, now, searchContext) {
    const result = {
        feasible: false,
        slot: null,
        displacements: [],
        reason: ''
    };

    const machines = getMachinesForOp(opType);

    let bestOption = null;
    let bestCost = Infinity;

    console.log(`[PLACE_SEQ] Searching slot for ${opType} (${duration}h) from context:`, searchContext);

    // Si on a un contexte de séquence (pas la première opération)
    if (searchContext.startDay !== null) {
        // Chercher à partir de lastEndHour sur le même jour
        console.log(`[PLACE_SEQ] Sequenced search from ${searchContext.startDay} at ${decimalToTimeString(searchContext.minHour)}`);
        console.log(`[PLACE_SEQ] Testing ${machines.length} machines: ${machines.join(', ')}`);

        for (const machine of machines) {
            const slotResult = tryPlaceFromPosition(
                machine,
                searchContext.startDay,
                searchContext.startWeek,
                searchContext.startYear,
                searchContext.minHour,
                duration,
                opType,
                urgentOrder,
                mode,
                crThreshold,
                maxDisplacements,
                now
            );

            if (slotResult && slotResult.cost < bestCost) {
                bestCost = slotResult.cost;
                bestOption = {
                    ...slotResult,
                    machine: machine
                };
            } else if (slotResult && slotResult.cost === bestCost) {
                // Même coût : comparer pour trouver le meilleur
                const currentBest = compareSlotsForSequencing(
                    slotResult.slot,
                    bestOption.slot,
                    searchContext.startWeek,
                    searchContext.startYear,
                    searchContext.startDay,
                    searchContext.minHour
                );
                if (currentBest === slotResult.slot) {
                    bestOption = {
                        ...slotResult,
                        machine: machine
                    };
                }
            }
        }

    } else {
        // Première opération : chercher partout sur l'horizon
        console.log(`[PLACE_SEQ] Free search (first operation)`);
        console.log(`[PLACE_SEQ] Testing ${machines.length} machines: ${machines.join(', ')}`);

        let searchDate = new Date(now);
        const searchHorizonDays = SCHEDULE_CONFIG.SEARCH_HORIZON_DAYS;

        for (let dayOffset = 0; dayOffset < searchHorizonDays; dayOffset++) {
            const weekNum = getWeekNumber(searchDate);
            const yearNum = getISOWeekYear(searchDate);
            const dayIdx = searchDate.getDay() - 1;

            if (dayIdx < 0 || dayIdx > 4) {
                searchDate.setDate(searchDate.getDate() + 1);
                continue;
            }

            const dayName = DAYS_OF_WEEK[dayIdx];
            const isToday = searchDate.toDateString() === now.toDateString();
            const minHour = isToday ? (now.getHours() + now.getMinutes() / 60) : 0;

            for (const machine of machines) {
                const slotResult = tryPlaceFromPosition(
                    machine,
                    dayName,
                    weekNum,
                    yearNum,
                    minHour,
                    duration,
                    opType,
                    urgentOrder,
                    mode,
                    crThreshold,
                    maxDisplacements,
                    now
                );

                if (slotResult && slotResult.cost < bestCost) {
                    bestCost = slotResult.cost;
                    bestOption = {
                        ...slotResult,
                        machine: machine
                    };
                } else if (slotResult && slotResult.cost === bestCost && bestCost === 0) {
                    // Comparer deux slots libres : prendre le plus proche
                    const currentBest = compareSlotsForSequencing(
                        slotResult.slot,
                        bestOption.slot,
                        weekNum,
                        yearNum,
                        dayName,
                        minHour
                    );
                    if (currentBest === slotResult.slot) {
                        bestOption = {
                            ...slotResult,
                            machine: machine
                        };
                    }
                }
            }

            // Si on a trouvé un créneau libre (coût 0), on peut arrêter la recherche
            if (bestCost === 0) break;
            searchDate.setDate(searchDate.getDate() + 1);
        }
    }

    if (!bestOption) {
        result.reason = `Aucun créneau trouvé pour ${opType} avec contraintes de séquençage`;
        console.log(`[PLACE_SEQ] ✗ ${result.reason}`);
        return result;
    }

    console.log(`[PLACE_SEQ] ✓ Best slot found: Machine ${bestOption.machine}, ${bestOption.slot.day} ${decimalToTimeString(bestOption.slot.startHour)}-${decimalToTimeString(bestOption.slot.endHour)}, cost: ${bestCost}, displacements: ${bestOption.displacements.length}`);

    // SPLIT INTELLIGENT : vérifier si l'opération doit être splittée (pause/multi-jours)
    const operation = { type: opType, dureeTotal: duration };
    const fragments = splitOperationForSlot(
        operation,
        bestOption.machine,
        bestOption.slot.week,
        bestOption.slot.year,
        bestOption.slot.day,
        bestOption.slot.startHour
    );

    result.feasible = true;
    result.displacements = bestOption.displacements;

    if (fragments.length === 1) {
        // Pas de split, retour simple
        result.slot = {
            machine: bestOption.machine,
            week: fragments[0].week,
            year: fragments[0].year,
            day: fragments[0].day,
            hours: fragments[0].duration,
            startHour: fragments[0].startHour,
            endHour: fragments[0].endHour,
            timeRange: `${decimalToTimeString(fragments[0].startHour)}-${decimalToTimeString(fragments[0].endHour)}`,
            isOvertime: bestOption.slot.isOvertime
        };
    } else {
        // Split en plusieurs fragments : retourner tous les slots
        console.log(`[PLACE_SEQ] ⚠️ Operation split into ${fragments.length} fragments (pause/multi-day)`);
        result.slots = fragments.map((frag, idx) => ({
            machine: frag.machine,
            week: frag.week,
            year: frag.year,
            day: frag.day,
            hours: frag.duration,
            startHour: frag.startHour,
            endHour: frag.endHour,
            timeRange: `${decimalToTimeString(frag.startHour)}-${decimalToTimeString(frag.endHour)}`,
            isOvertime: frag.endHour > getScheduleForDay(frag.day).standardEnd,
            fragmentIndex: idx,
            totalFragments: fragments.length
        }));
    }

    return result;
}

/**
 * Essaie de placer à partir d'une position donnée (jour/heure)
 */
function tryPlaceFromPosition(machine, dayName, weekNum, yearNum, minHour, duration, opType, urgentOrder, mode, crThreshold, maxDisplacements, now) {
    const schedule = getScheduleForDay(dayName);

    // Chercher un créneau libre d'abord
    const freeSlot = findNextAvailableSlotForDisplacement(
        machine,
        duration,
        dayName,
        weekNum,
        yearNum,
        minHour,
        true // allow overtime
    );

    if (freeSlot) {
        console.log(`[TRY_PLACE] ✓ Free slot found on ${freeSlot.day} at ${decimalToTimeString(freeSlot.startHour)}`);
        return {
            slot: freeSlot,
            displacements: [],
            cost: 0
        };
    }

    // Pas de créneau libre, essayer avec déplacements
    console.log(`[TRY_PLACE] No free slot, trying with displacements...`);

    // Scanner les horaires possibles à partir de minHour
    const isToday = getDateFromWeekAndDay(weekNum, yearNum, dayName).toDateString() === now.toDateString();
    const currentHourDecimal = now.getHours() + now.getMinutes() / 60;
    const searchStartHour = isToday ? Math.max(minHour, currentHourDecimal) : Math.max(minHour, schedule.start);

    for (let startHour = searchStartHour; startHour + duration <= schedule.overtimeEnd; startHour += 0.5) {
        const endHour = startHour + duration;

        // Identifier les conflits
        const conflicts = findConflicts(machine, dayName, weekNum, yearNum, startHour, endHour);

        // Vérifier blocages système
        if (hasSystemBlock(machine, dayName, weekNum, yearNum, startHour, endHour)) {
            continue;
        }

        if (conflicts.length === 0) {
            return {
                slot: {
                    week: weekNum,
                    year: yearNum,
                    day: dayName,
                    startHour: startHour,
                    endHour: endHour,
                    isOvertime: endHour > schedule.standardEnd
                },
                displacements: [],
                cost: 0
            };
        }

        if (conflicts.length > maxDisplacements) {
            continue;
        }

        // Essayer de déplacer
        const displacementResult = tryDisplaceConflicts(
            conflicts,
            machine,
            dayName,
            weekNum,
            yearNum,
            endHour, // Les opérations déplacées vont APRÈS
            mode,
            crThreshold,
            now
        );

        if (displacementResult.success) {
            const cost = (conflicts.length * 2) + displacementResult.totalDisplacement * 0.01;

            return {
                slot: {
                    week: weekNum,
                    year: yearNum,
                    day: dayName,
                    startHour: startHour,
                    endHour: endHour,
                    isOvertime: endHour > schedule.standardEnd
                },
                displacements: displacementResult.displacements,
                cost: cost
            };
        }
    }

    // Essayer sur le jour suivant si on a pas trouvé
    const nextDay = getNextWorkDay(dayName, weekNum, yearNum);
    if (nextDay) {
        console.log(`[TRY_PLACE] Trying next day: ${nextDay.day}`);
        return tryPlaceFromPosition(
            machine,
            nextDay.day,
            nextDay.week,
            nextDay.year,
            0, // Début de journée
            duration,
            opType,
            urgentOrder,
            mode,
            crThreshold,
            maxDisplacements,
            now
        );
    }

    return null;
}

/**
 * Get next work day
 */
function getNextWorkDay(currentDay, currentWeek, currentYear) {
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
function getOperationSequence(commande) {
    const orderMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
    return [...commande.operations].sort((a, b) => {
        return (orderMap[a.type] || 99) - (orderMap[b.type] || 99);
    });
}

/**
 * Retourne les opérations qui suivent une opération donnée dans la séquence
 */
function getFollowingOperations(commande, currentOperation) {
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
function compareSlotsForSequencing(slotA, slotB, targetWeek, targetYear, targetDay, targetHour) {
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
 * Déplace une opération et toutes les opérations suivantes en cascade
 */
function displaceOperationWithCascade(conflict, destinationSlot, now) {
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
            // Trouver le slot actuel de cette opération
            if (!followingOp.slots || followingOp.slots.length === 0) {
                console.log(`[CASCADE] ⚠️ Following operation ${followingOp.type} has no slots, skipping cascade`);
                continue;
            }

            const currentSlot = followingOp.slots[0];
            const opDuration = followingOp.dureeTotal;
            const opMachines = getMachinesForOp(followingOp.type);

            // CHERCHER LE MEILLEUR SLOT PARMI TOUTES LES MACHINES
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
                return null; // Échec du déplacement en cascade
            }

            console.log(`[CASCADE] ✓ Best slot for ${followingOp.type}: Machine ${bestSlot.machine}, ${bestSlot.day} ${decimalToTimeString(bestSlot.startHour)}-${decimalToTimeString(bestSlot.endHour)}`);

            // SPLIT INTELLIGENT : vérifier si l'opération doit être splittée (pause/multi-jours)
            const opFragments = splitOperationForSlot(
                followingOp,
                bestSlot.machine,
                bestSlot.week,
                bestSlot.year,
                bestSlot.day,
                bestSlot.startHour
            );

            // Créer un déplacement pour chaque fragment (ou un seul si pas de split)
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

            // Mettre à jour pour l'opération suivante (utiliser le dernier fragment)
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
function tryDisplaceConflicts(conflicts, machine, dayName, weekNum, yearNum, afterHour, mode, crThreshold, now) {
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

        // DÉPLACEMENT EN CASCADE : déplacer l'opération ET toutes les suivantes
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

            // Calculer le nouveau CR pour cette opération
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

            // Ajouter les infos de CR à chaque déplacement
            disp.displacement = dispMinutes;
            disp.crBefore = scoreDataBefore.criticalRatio;
            disp.crAfter = newCR;
            disp.slack = scoreDataBefore.slack;
            disp.criticalRatio = newCR;
            disp.score = scoreDataBefore.score;
            disp.status = newCR < crThreshold ? 'RISQUE' : 'OK';
        }

        // Ajouter tous les déplacements en cascade
        result.displacements.push(...cascadeDisplacements);
        result.totalDisplacement += totalDisplacementMinutes;
    }

    result.success = true;
    return result;
}

/**
 * Scinde une opération à la limite des heures normales (évite les heures sup)
 * Utilisé quand l'utilisateur refuse les heures supplémentaires
 * @param {object} operation - L'opération à scinder
 * @param {string} machine - Machine assignée
 * @param {number} startWeek - Semaine de début
 * @param {number} startYear - Année de début
 * @param {string} startDay - Jour de début
 * @param {number} startHour - Heure de début (décimal)
 * @returns {Array} Tableau de fragments
 */
function splitAtNormalHoursEnd(operation, machine, startWeek, startYear, startDay, startHour) {
    const fragments = [];
    let remainingDuration = operation.dureeTotal;
    let currentWeek = startWeek;
    let currentYear = startYear;
    let currentDay = startDay;
    let currentHour = startHour;

    console.log(`[SPLIT-NORMAL] Scindage à limite heures normales pour ${operation.type} (${remainingDuration}h) à partir de ${currentDay} ${decimalToTimeString(currentHour)}`);

    while (remainingDuration > 0.01) {
        const schedule = getScheduleForDay(currentDay);
        const normalEnd = schedule.standardEnd; // 16.5 ou 12.0

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
                currentHour = zone.end; // Sauter apres la zone
                fragmentEnd = calculateEndTimeWithBreaks(currentHour, remainingDuration, currentDay);
            }
        }

        // Vérifier si dépasse les heures normales
        if (fragmentEnd > normalEnd) {
            // Split à la limite des heures normales (ÉVITE heures sup)
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
 * Une opération se split UNIQUEMENT si :
 * 1. Elle chevauche une pause déjeuner
 * 2. Elle s'étale sur plusieurs jours
 * Les fragments restent TOUJOURS sur la même machine
 */
function splitOperationForSlot(operation, machine, startWeek, startYear, startDay, startHour) {
    const fragments = [];
    let remainingDuration = operation.dureeTotal || operation.duration;
    let currentWeek = startWeek;
    let currentYear = startYear;
    let currentDay = startDay;
    let currentHour = startHour;

    console.log(`[SPLIT] Checking if split needed for ${operation.type || 'operation'} (${remainingDuration}h) starting at ${currentDay} ${decimalToTimeString(currentHour)}`);

    while (remainingDuration > 0.01) {
        const schedule = getScheduleForDay(currentDay);
        let availableUntil = schedule.overtimeEnd;

        // Verifier si on chevauche une zone bloquee (pauses + gaps inter-equipes)
        let fragmentEnd = currentHour + remainingDuration;
        const blockedZones = getBlockedZonesForDay(currentDay);

        for (const zone of blockedZones) {
            if (currentHour < zone.start && fragmentEnd > zone.start) {
                // L'operation chevauche une zone bloquee → split avant la zone
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
                currentHour = zone.end; // Sauter apres la zone
                fragmentEnd = calculateEndTimeWithBreaks(currentHour, remainingDuration, currentDay);
            }
        }

        // Vérifier si l'opération dépasse la fin de journée
        if (fragmentEnd > schedule.overtimeEnd) {
            // L'opération dépasse la fin de journée → split à la fin de journée
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
            // Pas de split nécessaire, l'opération tient dans le créneau
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

/**
 * Find conflicts at a specific time slot
 */
function findConflicts(machine, dayName, weekNum, yearNum, startHour, endHour) {
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

/**
 * Check if there is a system block (maintenance/fermeture)
 * Supporte les deux formats : v1 (ancien) et v2 (multi-jours)
 * Note : La pause déjeuner n'est PLUS bloquante ici, car le split intelligent s'en occupe
 */
function hasSystemBlock(machine, dayName, weekNum, yearNum, startHour, endHour) {
    // Calculer la date cible pour comparaison avec les événements v2
    const targetDate = getDateFromWeekDay(weekNum, dayName, "00:00", yearNum);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    const hasEvent = systemEvents.some(e => {
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
    // Le slot peut chevaucher la pause, il sera automatiquement splitté

    return false;
}

/**
 * Helper: Convert decimal hours to time string
 */
function decimalToTimeString(decimal) {
    const hours = Math.floor(decimal);
    const minutes = Math.round((decimal - hours) * 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Calculate Urgent/Overbooking Plan (Scenario PRIO)
 * Stratégie : Trouve le PREMIER créneau disponible sur un horizon de 4 semaines
 */
function calculateOverbookingPlan(order) {
    const result = {
        feasible: true,
        slots: [],
        totalOvertimeHours: 0,
        reason: ''
    };
    
    const now = new Date();
    // Determine strict start point (Now)
    const currentWeekNum = getWeekNumber(now);
    const currentYearNum = now.getFullYear();
    let startDayIdx = now.getDay() - 1; // 0=Mon
    if (startDayIdx === -1) startDayIdx = 6;
    
    // We start searching from "Now" or from the currently selected view week if it's in the future?
    // User request: "take into account the day it is in... then next day".
    // Usually "Urgent" implies starting ASAP, i.e., NOW.
    
    let cursor = {
        week: currentWeekNum,
        year: currentYearNum,
        dayIdx: startDayIdx,
        minHour: now.getHours() + now.getMinutes() / 60
    };

    // If selected view is far in future, maybe we should start there? 
    // Let's stick to "ASAP from Now" for urgent orders.

    // 🔒 Trier les opérations
    const sortedOperations = [...order.operations].sort((a, b) => {
        const orderMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
        return (orderMap[a.type] || 99) - (orderMap[b.type] || 99);
    });

    for (const op of sortedOperations) {
        if (op.slots.length > 0) continue;

        let machines = [];
        if (op.type === 'Cisaillage') machines = MACHINES.cisailles;
        else if (op.type === 'Poinçonnage') machines = MACHINES.poinconneuses;
        else if (op.type === 'Pliage') machines = MACHINES.plieuses;

        let placed = false;

        // HORIZON SEARCH: Scan up to 4 weeks forward
        // Pour l'insertion urgente, chaque opération cherche indépendamment le premier créneau
        // On utilise le cursor initial pour la première recherche, mais on ne force pas la séquentialité
        let searchWeek = cursor.week;
        let searchYear = cursor.year;

        // Loop 4 weeks
        for (let wOffset = 0; wOffset < 4; wOffset++) {

            // Loop Days (Mon-Fri)
            // Pour la première semaine, commencer au début de la semaine (pas au cursor)
            // pour permettre le placement en parallèle sur différentes machines
            const dStart = 0; // Toujours chercher depuis Lundi
            
            for (let d = dStart; d < 5; d++) {
                const dayName = DAYS_OF_WEEK[d];

                // Pour l'insertion urgente, on commence toujours au début de la journée
                // sauf pour le jour actuel de la semaine actuelle où on utilise l'heure courante
                const isToday = (wOffset === 0 && d === cursor.dayIdx);
                const minStart = isToday ? cursor.minHour : 0;

                for (const machine of machines) {
                    // Search with explicit week/year context
                    const slot = findUrgentSlot(machine, dayName, op.dureeTotal, minStart, searchWeek, searchYear);
                    
                    if (slot) {
                        result.slots.push({
                            machine: machine,
                            day: dayName,
                            hours: op.dureeTotal, 
                            timeRange: slot.range,
                            opType: op.type,
                            // Store context for application
                            week: searchWeek,
                            year: searchYear
                        });
                        
                        result.totalOvertimeHours += op.dureeTotal;

                        // Ne pas mettre à jour le cursor pour permettre le placement en parallèle
                        // Les opérations peuvent se placer sur différentes machines/jours simultanément

                        placed = true;
                        break; // Machine found
                    }
                }
                if (placed) break; // Day found
            }
            if (placed) break; // Week found

            // Prepare next week iteration
            searchWeek++;
            if (searchWeek > 52) {
                searchWeek = 1;
                searchYear++;
            }
        }
        
        if (!placed) {
            result.feasible = false;
            result.reason = `Aucun créneau (Standard ou Sup) trouvé pour ${op.type} sur 4 semaines`;
            break;
        }
    }
    
    return result;
}

/**
 * Trouve un créneau urgent sur la journée étendue (Matin -> Fin Heures Sup)
 * Respecte la pause déjeuner existante.
 */
function findUrgentSlot(machine, day, duration, minStartHour = 0, targetWeek = semaineSelectionnee, targetYear = anneeSelectionnee) {
    // 1. Définir les bornes de la journée étendue
    const dayStart = day === 'Vendredi' ? 7.0 : 7.5;
    
    // Fin absolue (Standard + Max Heures Sup)
    // Lun-Jeu: 16:30 + 1.5 = 18:00
    // Ven: 12:00 + 2.0 = 14:00
    const dayEnd = day === 'Vendredi' ? 14.0 : 18.0;
    
    // Le début effectif ne peut pas être avant l'ouverture
    let searchStart = Math.max(dayStart, minStartHour);
    
    // Si la durée dépasse le temps restant total possible
    if (searchStart + duration > dayEnd) return null;

    // 2. Récupérer tous les créneaux OCCUPÉS (Standard + Overtime déjà placés)
    const placedOrders = getPlacedOrders();
    const busySlots = placedOrders
        .flatMap(c => c.operations)
        .flatMap(o => o.slots)
        .filter(s => {
            // Vérifier machine, jour et semaine
            if (s.machine !== machine || s.jour !== day || s.semaine !== targetWeek) return false;
            // Si le slot a une année, vérifier qu'elle correspond. Sinon, l'inclure pour compatibilité
            if (s.annee && s.annee !== targetYear) return false;
            return true;
        })
        .map(s => ({
            start: timeToDecimalHours(s.heureDebut),
            end: timeToDecimalHours(s.heureFin)
        }));

    // Ajouter les blocages système (Maintenance / Fermeture)
    systemEvents
        .filter(e => (e.machine === machine || e.machine === 'ALL') && e.day === day && e.week === targetWeek && (!e.year || e.year === targetYear))
        .forEach(e => {
            busySlots.push({
                start: timeToDecimalHours(e.startTime),
                end: timeToDecimalHours(e.endTime)
            });
        });

    // Ajouter toutes les zones bloquees (pauses + gaps inter-equipes) comme creneaux occupes
    const blockedZones = getBlockedZonesForDay(day);
    blockedZones.forEach(zone => {
        busySlots.push({ start: zone.start, end: zone.end, type: zone.type });
    });

    // Trier les créneaux occupés
    busySlots.sort((a, b) => a.start - b.start);

    // 3. Chercher un trou (Gap)
    let currentPointer = searchStart;

    for (const busy of busySlots) {
        // Le trou est entre currentPointer et busy.start
        // On doit vérifier si le trou est valide (start < end)
        // Et si la durée rentre
        
        // Ajuster le début du trou si nécessaire (si currentPointer est avant busy.start)
        if (currentPointer < busy.start) {
            const gapSize = busy.start - currentPointer;
            if (gapSize >= duration - 0.001) { // Tolérance float
                // Trouvé !
                return formatSlotResult(currentPointer, currentPointer + duration);
            }
        }
        
        // Avancer le pointeur après le créneau occupé
        // Attention: si le créneau occupé finissait avant notre pointeur actuel, on ne recule pas
        currentPointer = Math.max(currentPointer, busy.end);
    }

    // 4. Vérifier le dernier trou (après la dernière occupation jusqu'à la fin de journée)
    if (currentPointer + duration <= dayEnd + 0.001) {
        return formatSlotResult(currentPointer, currentPointer + duration);
    }

    return null;
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

/**
 * Render Scenario Cards
 */
function renderScenariosSelection() {
    const container = document.getElementById('scenariosList');
    let html = '';

    currentScenarios.forEach(scenario => {
        const disabledClass = scenario.disabled ? 'opacity:0.6; pointer-events:none;' : '';
        const overtimeClass = scenario.id === 'PRIO' ? 'overtime' : '';
        const smartClass = scenario.id === 'SMART' ? 'smart' : '';

        html += `
            <div class="scenario-card ${overtimeClass} ${smartClass}" style="${disabledClass}" onclick="selectScenario('${scenario.id}')" id="scenario-${scenario.id}">
                <div class="scenario-header">
                    <span class="scenario-title">${scenario.icon} ${scenario.name}</span>
                    <span class="scenario-badge ${scenario.badge}">${scenario.id}</span>
                </div>
                <div style="margin-bottom:8px; font-weight:500;">${scenario.strategy}</div>

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; font-size:0.9em; color:#666;">
                    <div>Faisabilité: <strong>${scenario.metrics.feasibility}</strong></div>
                    <div>Impact: <span class="impact-stars">${'★'.repeat(scenario.metrics.impact_score)}</span></div>
                </div>

                ${scenario.metrics.details ? `<div style="margin-top:8px; font-size:0.9em; color:#d63384;">${scenario.metrics.details}</div>` : ''}

                ${scenario.id === 'SMART' && scenario.actions && scenario.actions.displacements && scenario.actions.displacements.length > 0 ? `
                    <div style="margin-top:12px; padding:8px; background:#f8f9fa; border-radius:4px; font-size:0.85em;">
                        <div style="font-weight:600; margin-bottom:6px; color:#0dcaf0;">📊 Opérations affectées :</div>
                        ${scenario.actions.displacements.slice(0, 3).map(d => `
                            <div style="margin:4px 0; padding:4px; background:white; border-left:3px solid #0dcaf0; border-radius:2px;">
                                <strong>${d.commandeId}</strong> - ${d.operationType}<br>
                                <span style="font-size:0.9em; color:#666;">
                                    ${d.oldSlot.day} ${d.oldSlot.startTime} → ${d.newSlot.day} ${d.newSlot.startTime}
                                    (+${Math.round(d.displacement)} min)
                                </span>
                            </div>
                        `).join('')}
                        ${scenario.actions.displacements.length > 3 ? `
                            <div style="margin-top:4px; font-style:italic; color:#666;">
                                ... et ${scenario.actions.displacements.length - 3} autre(s)
                            </div>
                        ` : ''}
                    </div>
                ` : ''}

                ${scenario.warnings && scenario.warnings.length > 0 ? `
                    <div style="margin-top:8px; font-size:0.85em; color:#dc3545; background:#fff5f5; padding:4px; border-radius:4px;">
                        ⚠️ ${scenario.warnings[0]}
                    </div>
                ` : ''}
            </div>
        `;
    });

    container.innerHTML = html;
}

/**
 * Select a Scenario
 */
function selectScenario(id) {
    document.querySelectorAll('.scenario-card').forEach(el => el.classList.remove('selected'));
    document.getElementById(`scenario-${id}`).classList.add('selected');
    
    currentScenario = currentScenarios.find(s => s.id === id);
    document.getElementById('btnValidateScenario').disabled = false;
}

// ------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------

document.getElementById('btnInsertUrgent')?.addEventListener('click', showUrgentInsertionModal);

document.getElementById('btnCloseUrgent')?.addEventListener('click', () => {
    document.getElementById('modalUrgentInsertion').classList.remove('active');
});

document.getElementById('btnCancelUrgent')?.addEventListener('click', () => {
    document.getElementById('modalUrgentInsertion').classList.remove('active');
});

document.getElementById('btnNextToScenarios')?.addEventListener('click', handleNextToScenarios);

document.getElementById('btnBackToOrders')?.addEventListener('click', () => {
    document.getElementById('stepSelectScenario').classList.remove('active');
    document.getElementById('stepSelectOrder').classList.add('active');
});

document.getElementById('btnValidateScenario')?.addEventListener('click', () => {
    if (!currentScenario) return;

    if (currentScenario.id === 'SMART') {
        // Go to SMART confirmation step
        document.getElementById('stepSelectScenario').classList.remove('active');
        document.getElementById('stepConfirmDisplacement').classList.add('active');

        // Render displacement details
        renderDisplacementConfirmation();
    } else if (currentScenario.id === 'PRIO') {
        // Go to confirmation step
        document.getElementById('stepSelectScenario').classList.remove('active');
        document.getElementById('stepConfirmOvertime').classList.add('active');

        // Render details
        let detailsHtml = `<strong>Résumé Heures Supplémentaires :</strong><br>`;
        detailsHtml += `Total: ${currentScenario.metrics.overtime_hours}h<br>`;
        detailsHtml += `<ul style="margin-left:20px; margin-top:8px;">`;
        currentScenario.actions.overbooking_slots.forEach(slot => {
            detailsHtml += `<li>${slot.day} - ${slot.machine} (${slot.opType}): ${slot.hours}h</li>`;
        });
        detailsHtml += `</ul>`;
        document.getElementById('overtimeDetails').innerHTML = detailsHtml;

        checkConfirmationState();
    } else {
        // Should not happen with current logic, but safe fallback
        applyScenario(currentScenario, currentUrgentOrder);
        document.getElementById('modalUrgentInsertion').classList.remove('active');
    }
});

// Render Displacement Confirmation Details
function renderDisplacementConfirmation() {
    if (!currentScenario || !currentUrgentOrder) return;

    // Render urgent order info
    const urgentInfo = document.getElementById('urgentOrderInfo');
    if (urgentInfo) {
        urgentInfo.innerHTML = `
            <div style="padding:12px; background:#fff3cd; border-radius:8px; border-left:4px solid #ffc107;">
                <strong>${currentUrgentOrder.id}</strong> - ${currentUrgentOrder.client || 'Client'}<br>
                <span style="font-size:0.9em; color:#666;">
                    ${currentUrgentOrder.operations.length} opération(s) à placer
                </span>
            </div>
        `;
    }

    // Render impact summary
    const impactSummary = document.getElementById('impactSummary');
    if (impactSummary && currentScenario.totalImpact) {
        const impact = currentScenario.totalImpact;
        impactSummary.innerHTML = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
                <div style="padding:12px; background:#d1ecf1; border-radius:8px; text-align:center;">
                    <div style="font-size:1.5em; font-weight:bold; color:#0c5460;">${impact.opsDisplaced}</div>
                    <div style="font-size:0.85em; color:#0c5460;">Opérations déplacées</div>
                </div>
                <div style="padding:12px; background:#d4edda; border-radius:8px; text-align:center;">
                    <div style="font-size:1.5em; font-weight:bold; color:#155724;">${impact.maxDelay} min</div>
                    <div style="font-size:0.85em; color:#155724;">Retard créé</div>
                </div>
            </div>
            <div style="padding:12px; background:#f8f9fa; border-radius:8px;">
                <div style="font-weight:600; margin-bottom:8px; color:#0dcaf0;">✅ Avantages :</div>
                <ul style="margin:0; padding-left:20px; font-size:0.9em;">
                    <li>Aucun retard de livraison</li>
                    <li>Pas d'heures supplémentaires nécessaires</li>
                    <li>Déplacement minimal (+${Math.round(impact.maxDisplacement)} min max)</li>
                </ul>
            </div>
        `;
    }

    // Render displacements list
    const displacementsList = document.getElementById('displacementsList');
    if (displacementsList && currentScenario.actions.displacements) {
        let html = '';
        currentScenario.actions.displacements.forEach((d, index) => {
            html += `
                <div style="margin-bottom:12px; padding:12px; background:white; border:1px solid #dee2e6; border-radius:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">
                        <div>
                            <strong style="color:#0dcaf0;">${index + 1}. ${d.commandeId}</strong> - ${d.operationType}<br>
                            <span style="font-size:0.85em; color:#666;">Machine: ${d.oldSlot.machine}</span>
                        </div>
                        <span style="background:#fff3cd; padding:4px 8px; border-radius:4px; font-size:0.85em; font-weight:600;">
                            +${Math.round(d.displacement)} min
                        </span>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr auto 1fr; gap:8px; align-items:center; font-size:0.9em;">
                        <div style="padding:8px; background:#f8d7da; border-radius:4px; text-align:center;">
                            <div style="font-weight:600; color:#721c24;">Avant</div>
                            <div style="margin-top:4px;">${d.oldSlot.day}</div>
                            <div style="font-size:1.1em; font-weight:600; margin-top:2px;">${d.oldSlot.startTime}</div>
                        </div>
                        <div style="font-size:1.5em; color:#0dcaf0;">→</div>
                        <div style="padding:8px; background:#d4edda; border-radius:4px; text-align:center;">
                            <div style="font-weight:600; color:#155724;">Après</div>
                            <div style="margin-top:4px;">${d.newSlot.day}</div>
                            <div style="font-size:1.1em; font-weight:600; margin-top:2px;">${d.newSlot.startTime}</div>
                        </div>
                    </div>
                    <div style="margin-top:8px; padding:6px; background:#f8f9fa; border-radius:4px; font-size:0.85em; color:#666;">
                        <strong>Marge restante :</strong> ${Math.round(d.slack)}h |
                        <strong>Score :</strong> ${d.score.toFixed(2)} |
                        <strong>CR :</strong> ${d.criticalRatio.toFixed(2)}
                    </div>
                </div>
            `;
        });
        displacementsList.innerHTML = html;
    }
}

// Confirmation Logic
function checkConfirmationState() {
    const c1 = document.getElementById('checkOperators').checked;
    const c2 = document.getElementById('checkMaintenance').checked;
    const c3 = document.getElementById('checkApproval').checked;
    document.getElementById('btnConfirmOvertime').disabled = !(c1 && c2 && c3);
}

document.getElementById('checkOperators')?.addEventListener('change', checkConfirmationState);
document.getElementById('checkMaintenance')?.addEventListener('change', checkConfirmationState);
document.getElementById('checkApproval')?.addEventListener('change', checkConfirmationState);

document.getElementById('btnBackToScenarios')?.addEventListener('click', () => {
    document.getElementById('stepConfirmOvertime').classList.remove('active');
    document.getElementById('stepSelectScenario').classList.add('active');
});

document.getElementById('btnConfirmOvertime')?.addEventListener('click', () => {
    applyScenario(currentScenario, currentUrgentOrder);
    document.getElementById('modalUrgentInsertion').classList.remove('active');
});

// SMART Scenario Event Listeners
document.getElementById('btnBackToScenariosFromSmart')?.addEventListener('click', () => {
    document.getElementById('stepConfirmDisplacement').classList.remove('active');
    document.getElementById('stepSelectScenario').classList.add('active');
});

document.getElementById('btnConfirmDisplacement')?.addEventListener('click', () => {
    applyScenario(currentScenario, currentUrgentOrder);
    document.getElementById('modalUrgentInsertion').classList.remove('active');
});

/**
 * Apply Scenario Logic
 */
function applyScenario(scenario, selectedOrder) {
    // 1. Validate
    if (scenario.id === 'PRIO') {
        // Double check limits just in case
    }

    // 2. Handle SMART scenario (Displacement)
    if (scenario.id === 'SMART' && scenario.actions.displacements) {
        // Apply slots for urgent order
        scenario.actions.slots.forEach(slot => {
            const operation = selectedOrder.operations.find(op => op.type === slot.opType);
            if (!operation) return;

            const startHourStr = slot.timeRange.split('-')[0];
            const startDecimal = timeToDecimalHours(startHourStr);
            const endDecimal = startDecimal + slot.hours;

            const endHour = Math.floor(endDecimal);
            const endMinute = Math.round((endDecimal - endHour) * 60);
            const endTimeStr = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;

            const targetWeek = slot.week || semaineSelectionnee;
            const targetYear = slot.year || anneeSelectionnee;

            // Calculate dates
            const simple = new Date(targetYear, 0, 1 + (targetWeek - 1) * 7);
            const dow = simple.getDay();
            const ISOweekStart = new Date(simple);
            if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
            else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

            const dayIndex = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"].indexOf(slot.day);
            const targetDateBase = new Date(ISOweekStart);
            targetDateBase.setDate(ISOweekStart.getDate() + dayIndex);

            const [sh, sm] = startHourStr.split(':');
            const dStart = new Date(targetDateBase);
            dStart.setHours(parseInt(sh), parseInt(sm), 0, 0);

            const [eh, em] = endTimeStr.split(':');
            const dEnd = new Date(targetDateBase);
            dEnd.setHours(parseInt(eh), parseInt(em), 0, 0);

            operation.slots.push({
                id: generateSlotId(operation.id, operation.slots),
                machine: slot.machine,
                duree: slot.hours,
                semaine: targetWeek,
                annee: targetYear,
                jour: slot.day,
                heureDebut: startHourStr,
                heureFin: endTimeStr,
                dateDebut: dStart.toISOString().split('.')[0],
                dateFin: dEnd.toISOString().split('.')[0],
                smart: true
            });
            operation.statut = "Planifiée";
        });

        // Apply displacements
        scenario.actions.displacements.forEach(displacement => {
            // Find the command and operation to displace
            const cmd = commandes.find(c => c.id === displacement.commandeId);
            if (!cmd) return;

            const operation = displacement.operation;
            if (!operation || !operation.slots) return;

            // Find and remove the old slot
            const oldSlotIndex = operation.slots.findIndex(s =>
                s.machine === displacement.oldSlot.machine &&
                s.jour === displacement.oldSlot.day &&
                s.semaine === displacement.oldSlot.week &&
                s.heureDebut === displacement.oldSlot.startTime
            );

            if (oldSlotIndex !== -1) {
                const removedSlot = operation.slots[oldSlotIndex];
                // Supprimer de Supabase si ID existe
                if (removedSlot.id && supabaseClient) {
                    syncManager.deleteSlotFromSupabase(removedSlot.id);
                }
                operation.slots.splice(oldSlotIndex, 1);
            }

            // Add the new slot
            const newStartStr = displacement.newSlot.startTime;
            const newEndStr = displacement.newSlot.endTime;

            const targetWeek = displacement.newSlot.week;
            const targetYear = displacement.newSlot.year;

            // Calculate dates for new slot
            const simple = new Date(targetYear, 0, 1 + (targetWeek - 1) * 7);
            const dow = simple.getDay();
            const ISOweekStart = new Date(simple);
            if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
            else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

            const dayIndex = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"].indexOf(displacement.newSlot.day);
            const targetDateBase = new Date(ISOweekStart);
            targetDateBase.setDate(ISOweekStart.getDate() + dayIndex);

            const [sh, sm] = newStartStr.split(':');
            const dStart = new Date(targetDateBase);
            dStart.setHours(parseInt(sh), parseInt(sm), 0, 0);

            const [eh, em] = newEndStr.split(':');
            const dEnd = new Date(targetDateBase);
            dEnd.setHours(parseInt(eh), parseInt(em), 0, 0);

            operation.slots.push({
                id: generateSlotId(operation.id, operation.slots),
                machine: displacement.newSlot.machine,
                duree: displacement.slot.duree,
                semaine: targetWeek,
                annee: targetYear,
                jour: displacement.newSlot.day,
                heureDebut: newStartStr,
                heureFin: newEndStr,
                dateDebut: dStart.toISOString().split('.')[0],
                dateFin: dEnd.toISOString().split('.')[0],
                displaced: true
            });
        });
    }

    // 3. Apply Overtime Slots (PRIO scenario)
    if (scenario.actions.overbooking_slots) {
        scenario.actions.overbooking_slots.forEach(slot => {
            // Find operation
            const operation = selectedOrder.operations.find(op => op.type === slot.opType);
            if (!operation) return;
            
            const startHourStr = slot.timeRange.split('-')[0];
            const startDecimal = timeToDecimalHours(startHourStr);
            const endDecimal = startDecimal + slot.hours;
            
            const endHour = Math.floor(endDecimal);
            const endMinute = Math.round((endDecimal - endHour) * 60);
            const endTimeStr = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;
            
            const targetWeek = slot.week || semaineSelectionnee;
            const targetYear = slot.year || anneeSelectionnee; // Fallback or global

            // Use targetYear in date calculation if needed, or rely on week-based calc
            // But getDateFromWeekDay currently relies on global anneeSelectionnee if not passed?
            // We should update getDateFromWeekDay to accept year, which I did earlier.
            // Let's pass targetYear to it.
            
            const dateDebut = getDateFromWeekDay(targetWeek, slot.day, startHourStr); // Implicitly uses global year if not careful
            // Actually getDateFromWeekDay implementation:
            // function getDateFromWeekDay(weekNumber, dayName, timeStr) {
            //    const year = typeof anneeSelectionnee !== 'undefined' ? anneeSelectionnee : 2025;
            //    ...
            // It doesn't accept year as argument in its signature in some versions?
            // I updated getWeekDateRange but did I update getDateFromWeekDay?
            // Let's assume I need to fix getDateFromWeekDay signature if I haven't.
            // Checking my memory... I updated getDateFromWeekDay to use global.
            // I should have updated it to take year as optional param.
            
            // Wait, I will use a direct Date construction here to be safe and explicit using the calculated Year.
            // Or better: Re-read getDateFromWeekDay to be sure.
            // Assuming I can pass year if I modify it.
            
            // Let's implement a safe local date calc here to ensure year correctness
            const simple = new Date(targetYear, 0, 1 + (targetWeek - 1) * 7);
            const dow = simple.getDay();
            const ISOweekStart = new Date(simple);
            if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
            else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
            
            const dayIndex = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"].indexOf(slot.day);
            // Note: DAYS_OF_WEEK in app usually Mon-Fri.
            // Standard calc:
            const targetDateBase = new Date(ISOweekStart);
            targetDateBase.setDate(ISOweekStart.getDate() + dayIndex); // 0=Mon
            
            const [sh, sm] = startHourStr.split(':');
            const dStart = new Date(targetDateBase);
            dStart.setHours(parseInt(sh), parseInt(sm), 0, 0);
            
            const [eh, em] = endTimeStr.split(':');
            const dEnd = new Date(targetDateBase);
            dEnd.setHours(parseInt(eh), parseInt(em), 0, 0);

            operation.slots.push({
                id: generateSlotId(operation.id, operation.slots),
                machine: slot.machine,
                duree: slot.hours,
                semaine: targetWeek,
                annee: targetYear,
                jour: slot.day,
                heureDebut: startHourStr,
                heureFin: endTimeStr,
                dateDebut: dStart.toISOString().split('.')[0],
                dateFin: dEnd.toISOString().split('.')[0],
                overtime: true
            });
            operation.statut = "Planifiée";
        });
        
        // Track
        if (scenario.id === 'PRIO') {
            trackOvertimeUsage(scenario);
        }
    }
    
    // 4. Finalize
    const allPlaced = selectedOrder.operations.every(op => op.slots.length > 0);
    if (allPlaced) selectedOrder.statut = "Planifiée";

    historyManager.saveState(`Insertion ${selectedOrder.id}`);
    markCommandeDirty(selectedOrder.id);
    syncManager.saveLocalData();
    refresh();

    // Custom message for SMART scenario
    if (scenario.id === 'SMART') {
        const opsCount = scenario.actions.displacements ? scenario.actions.displacements.length : 0;
        const maxDelay = scenario.totalImpact ? scenario.totalImpact.maxDelay : 0;
        Toast.success(`Insertion réussie : ${opsCount} ops déplacées, ${maxDelay} min retard`);
    } else {
        Toast.success(`Commande ${selectedOrder.id} insérée (Scénario ${scenario.id})`);
    }
}

/**
 * Track Overtime Usage
 */
function trackOvertimeUsage(scenario) {
    if (!scenario.actions.overbooking_slots) return;
    
    scenario.actions.overbooking_slots.forEach(slot => {
        overtimeTracker.totalHoursUsed += slot.hours;
        
        if (!overtimeTracker.byMachine[slot.machine]) {
            overtimeTracker.byMachine[slot.machine] = { hours: 0 };
        }
        overtimeTracker.byMachine[slot.machine].hours += slot.hours;
        
        if (!overtimeTracker.byDay[slot.day]) {
            overtimeTracker.byDay[slot.day] = 0;
        }
        overtimeTracker.byDay[slot.day] += slot.hours;
    });
}

// ===================================
// 🖨️ PRINT & EXPORT LOGIC
// ===================================

document.getElementById('btnPrintPlanning')?.addEventListener('click', showPrintConfig);
document.getElementById('btnCancelPrint')?.addEventListener('click', () => {
    document.getElementById('modalPrintConfig').classList.remove('active');
});
document.getElementById('btnConfirmPrint')?.addEventListener('click', handlePrint);

function showPrintConfig() {
    const modal = document.getElementById('modalPrintConfig');
    const select = document.getElementById('printWeekSelect');

    // Populate weeks (Current - 1 to Current + 4)
    select.innerHTML = '';
    const currentW = getWeekNumber(new Date());
    const currentYear = new Date().getFullYear();

    for (let i = -1; i <= 4; i++) {
        let w = currentW + i;
        let year = currentYear;

        // Handle year rollover
        if (w > 52) {
            w = w - 52;
            year++;
        } else if (w < 1) {
            w = w + 52;
            year--;
        }

        const range = getWeekDateRange(w, year);
        const option = document.createElement('option');
        option.value = `${w}|${year}`; // Store both week and year
        option.text = `Semaine ${w} ${year} (${range.start}-${range.end} ${range.month})`;
        if (w === semaineSelectionnee && year === anneeSelectionnee) option.selected = true;
        select.appendChild(option);
    }

    modal.classList.add('active');
}

function handlePrint() {
    const selectedValue = document.getElementById('printWeekSelect').value;
    const [week, year] = selectedValue.split('|').map(v => parseInt(v));
    const format = document.querySelector('input[name="printFormat"]:checked').value;

    // 1. Switch View with correct week and year
    semaineSelectionnee = week;
    anneeSelectionnee = year;

    // 2. Enable print mode for dual-row rendering (only for journee view)
    if (format === 'journee') {
        isPrintMode = true;
    }

    toggleVue(format); // 'semaine' or 'journee'

    // 3. Wait for render then Print
    setTimeout(() => {
        document.getElementById('modalPrintConfig').classList.remove('active');
        window.print();

        // 4. Disable print mode and re-render after printing
        setTimeout(() => {
            isPrintMode = false;
            if (format === 'journee') {
                renderVueJournee();
            }
        }, 100);
    }, 500);
}

// ===================================
// Initialization
// ===================================

const syncManager = new DataSyncManager();

/**
 * Initialize the application
 */
async function init() {
    console.log('🏭 ETM PROD V2 - Planning de Production');
    console.log(`📅 Date de référence: ${currentTime.toLocaleString('fr-FR')}`);

    // Initialiser Supabase
    initSupabase();

    // Set initial selected week/year to current
    semaineSelectionnee = getWeekNumber(currentTime);
    anneeSelectionnee = currentTime.getFullYear();

    // Charger la configuration des machines depuis Supabase/localStorage
    await loadMachinesConfig();

    // Charger la configuration des horaires depuis Supabase/localStorage
    await loadScheduleConfig();

    // Safe initialization of UI components
    if (typeof updateCurrentTime === 'function') updateCurrentTime();
    if (typeof initEventHandlers === 'function') initEventHandlers();
    if (typeof initSyncHandlers === 'function') initSyncHandlers();
    if (typeof initMachineManagerHandlers === 'function') initMachineManagerHandlers();
    if (typeof initScheduleManagerHandlers === 'function') initScheduleManagerHandlers();

    // Start clock (Real-time update)
    setInterval(() => {
        // Update global time
        currentTime = new Date();
        
        // Update display
        if (typeof updateCurrentTime === 'function') updateCurrentTime();

        // Refresh views if needed (and not dragging)
        if (!draggedOperation) {
            // Update sidebar urgency
            renderCommandesNonPlacees(currentSearchQuery || '');

            // Update Day View (Red Line)
            if (vueActive === 'journee') {
                const wrapper = document.querySelector('.planning-wrapper');
                const scrollTop = wrapper ? wrapper.scrollTop : 0;
                const scrollLeft = wrapper ? wrapper.scrollLeft : 0;
                
                renderVueJournee();
                
                if (wrapper) {
                    wrapper.scrollTop = scrollTop;
                    wrapper.scrollLeft = scrollLeft;
                }
            }
        }
    }, 60000); // Every minute

    // Load system events directly (async avec Supabase)
    if (typeof loadSystemEvents === 'function') await loadSystemEvents();

    // Initialiser le système de sync hybride (charge local d'abord, puis tente remote)
    try {
        if (typeof syncManager !== 'undefined') {
            await syncManager.init();
        } else {
            console.error("❌ Critical: syncManager is not defined");
            Toast.error('Erreur critique: gestionnaire de sync non initialisé');
        }
    } catch (e) {
        console.error("❌ Critical: Sync Manager Init failed", e);
        if (typeof syncManager !== 'undefined') syncManager.loadLocalData();
    }

    // Migration workflow 2 étapes: ajouter semaineAffectee aux commandes
    if (migrateCommandesSemaineAffectee()) {
        syncManager.saveLocalData();
    }

    // ===== REALTIME SUBSCRIPTIONS =====
    // Initialiser les subscriptions temps réel pour synchroniser entre utilisateurs
    if (typeof initAllRealtimeSubscriptions === 'function' && supabaseClient) {
        initAllRealtimeSubscriptions({
            onCommandeChange: handleRealtimeCommandeChange,
            onOperationChange: handleRealtimeOperationChange,
            onSlotChange: handleRealtimeSlotChange,
            onMachineChange: handleRealtimeMachineChange,
            onSystemEventChange: handleRealtimeSystemEventChange,
            onShiftChange: handleRealtimeScheduleChange,
            onShiftScheduleChange: handleRealtimeScheduleChange,
            onBreakChange: handleRealtimeScheduleChange,
            onOvertimeConfigChange: handleRealtimeScheduleChange,
            onOvertimeSlotsChange: handleRealtimeScheduleChange
        });
        console.log('📡 Realtime subscriptions initialisées');
    }

    console.log(`✅ Commandes actives: ${getActiveOrders().length}/${commandes.length}`);
    console.log(`📦 Commandes placées: ${getPlacedOrders().length}`);
    console.log(`⏳ Commandes non placées: ${getUnplacedOrders().length}`);

    // Initialize sidebar search
    initializeSidebarSearch();

    console.log('✅ Application V2 initialisée avec sync hybride');
}

// ===================================
// REALTIME HANDLERS - Gestion des changements temps réel
// ===================================

const REALTIME_DEBUG = false; // Passer à true pour logs détaillés Realtime

/**
 * Dirty-tracking : ne sauvegarder vers Supabase que les commandes modifiées
 */
const _dirtyCommandeIds = new Set();

function markCommandeDirty(commandeId) {
    if (commandeId) _dirtyCommandeIds.add(commandeId);
}

function markAllCommandesDirty() {
    commandes.forEach(c => { if (c.id) _dirtyCommandeIds.add(c.id); });
}

/**
 * Sauvegarde les données (localStorage + Supabase pour les commandes dirty)
 * Appelée après chaque modification (drag & drop, etc.)
 * @param {string} [commandeId] - ID de la commande modifiée (pour dirty-tracking)
 */
let _isSaving = false;
function saveData(commandeId) {
    if (commandeId) markCommandeDirty(commandeId);
    if (typeof syncManager !== 'undefined') {
        _isSaving = true;
        syncManager.saveLocalData();
        // Reset après le debounce de sauvegarde (1.5s)
        setTimeout(() => { _isSaving = false; }, 1500);
    }
}

/**
 * Sauvegarde immédiate vers Supabase (sans debounce)
 * Pour les opérations critiques comme le drag & drop
 */
async function saveDataImmediate(commandeId) {
    if (commandeId) markCommandeDirty(commandeId);
    if (typeof syncManager !== 'undefined') {
        _isSaving = true;
        syncManager.saveLocalData();
        if (!navigator.onLine || !supabaseClient) {
            // Mode offline - ajouter à la file d'attente
            addToOfflineQueue('save_commande', { commandeId });
            Toast.info('Sauvegardé localement (hors ligne)');
        } else {
            await syncManager.saveAllToSupabase();
        }
        setTimeout(() => { _isSaving = false; }, 1500);
    }
}

// ===================================
// CONFLICT DETECTION (Multi-utilisateurs)
// ===================================

/**
 * Vérifie si un slot a été modifié par un autre utilisateur
 * Compare le timestamp local avec celui en base
 * @param {string} slotId - ID du slot
 * @param {string} localUpdatedAt - Timestamp local connu (ISO string)
 * @returns {Promise<{hasConflict: boolean, remoteData: object|null}>}
 */
async function checkSlotConflict(slotId, localUpdatedAt) {
    if (!supabaseClient) return { hasConflict: false, remoteData: null };

    try {
        const { data, error } = await supabaseClient
            .from('slots')
            .select('*')
            .eq('id', slotId)
            .single();

        if (error || !data) return { hasConflict: false, remoteData: null };

        // Si pas de timestamp local, pas de conflit possible
        if (!localUpdatedAt) return { hasConflict: false, remoteData: data };

        // Comparer les timestamps
        const remoteTime = new Date(data.updated_at).getTime();
        const localTime = new Date(localUpdatedAt).getTime();

        // Conflit si remote est plus récent (avec 2s de marge)
        const hasConflict = remoteTime > localTime + 2000;

        return { hasConflict, remoteData: data };

    } catch (e) {
        console.error('Erreur vérification conflit:', e);
        return { hasConflict: false, remoteData: null };
    }
}

/**
 * Sauvegarde un slot avec détection de conflit
 * Si conflit détecté, demande confirmation à l'utilisateur
 */
async function saveSlotWithConflictCheck(slot, operationId) {
    if (!supabaseClient) {
        // Mode offline - sauvegarder localement uniquement
        syncManager.saveLocalData();
        return true;
    }

    // Vérifier s'il y a un conflit potentiel
    const { hasConflict, remoteData } = await checkSlotConflict(slot.id, slot._lastSyncedAt);

    if (hasConflict && remoteData) {
        // Conflit détecté ! Demander à l'utilisateur
        const userChoice = await showConflictModal(slot, remoteData);

        if (userChoice === 'keep-mine') {
            console.log('⚠️ Conflit résolu: données locales conservées');
        } else if (userChoice === 'keep-remote') {
            applyRemoteSlotToLocal(remoteData, operationId);
            Toast.info('Modification annulée - données distantes appliquées');
            return false;
        } else {
            // Annulé
            return false;
        }
    }

    return true;
}

// ===================================
// CONFLICT MODAL
// ===================================

let conflictResolveCallback = null;

/**
 * Affiche le modal de conflit et attend la décision de l'utilisateur
 * @returns {Promise<'keep-mine'|'keep-remote'|'cancel'>}
 */
function showConflictModal(localSlot, remoteSlot) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modalConflict');
        if (!modal) {
            console.warn('Modal conflit non trouvé dans le DOM');
            resolve('keep-mine');
            return;
        }

        // Afficher les données locales
        document.getElementById('conflictLocalData').innerHTML = `
            Machine: <strong>${localSlot.machine || 'N/A'}</strong><br>
            Jour: ${localSlot.jour || 'N/A'}<br>
            Horaire: ${localSlot.heureDebut || '?'} - ${localSlot.heureFin || '?'}
        `;

        // Afficher les données distantes
        document.getElementById('conflictRemoteData').innerHTML = `
            Machine: <strong>${remoteSlot.machine_name || 'N/A'}</strong><br>
            Jour: ${remoteSlot.jour || 'N/A'}<br>
            Horaire: ${remoteSlot.heure_debut || '?'} - ${remoteSlot.heure_fin || '?'}
        `;

        conflictResolveCallback = resolve;
        modal.classList.add('active');
    });
}

function closeConflictModal() {
    const modal = document.getElementById('modalConflict');
    if (modal) modal.classList.remove('active');
    if (conflictResolveCallback) {
        conflictResolveCallback('cancel');
        conflictResolveCallback = null;
    }
}

function resolveConflict(choice) {
    const modal = document.getElementById('modalConflict');
    if (modal) modal.classList.remove('active');
    if (conflictResolveCallback) {
        conflictResolveCallback(choice);
        conflictResolveCallback = null;
    }
}

/**
 * Applique les données d'un slot distant au slot local
 */
function applyRemoteSlotToLocal(remoteSlot, operationId) {
    for (const cmd of commandes) {
        const operation = cmd.operations?.find(op => op.id === operationId);
        if (operation) {
            const localIndex = (operation.slots || []).findIndex(s => s.id === remoteSlot.id);
            if (localIndex >= 0) {
                operation.slots[localIndex] = {
                    id: remoteSlot.id,
                    machine: remoteSlot.machine_name,
                    duree: parseFloat(remoteSlot.duree),
                    semaine: remoteSlot.semaine,
                    jour: remoteSlot.jour,
                    heureDebut: remoteSlot.heure_debut,
                    heureFin: remoteSlot.heure_fin,
                    dateDebut: remoteSlot.date_debut,
                    dateFin: remoteSlot.date_fin,
                    overtime: remoteSlot.overtime,
                    _lastSyncedAt: remoteSlot.updated_at
                };
                syncManager.saveLocalData();
                refreshUIOnly();
                return;
            }
        }
    }
}

// ===================================
// OFFLINE QUEUE
// ===================================

const OFFLINE_QUEUE_KEY = 'etm_offline_queue';

/**
 * Récupère la file d'attente offline depuis localStorage
 */
function getOfflineQueue() {
    try {
        const stored = localStorage.getItem(OFFLINE_QUEUE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Sauvegarde la file d'attente offline
 */
function saveOfflineQueue(queue) {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

/**
 * Ajoute une opération à la file d'attente offline
 */
function addToOfflineQueue(action, data) {
    const queue = getOfflineQueue();
    queue.push({
        id: 'offline_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        action: action,
        data: data,
        timestamp: new Date().toISOString()
    });
    saveOfflineQueue(queue);
    console.log('📦 Ajouté à la file offline:', action);
}

/**
 * Traite la file d'attente offline quand la connexion revient
 */
async function processOfflineQueue() {
    const queue = getOfflineQueue();
    if (queue.length === 0) return;

    console.log(`🔄 Traitement de ${queue.length} opération(s) en attente...`);
    Toast.info(`Synchronisation de ${queue.length} modification(s)...`);

    const failedItems = [];

    for (const item of queue) {
        try {
            let success = false;

            switch (item.action) {
                case 'save_commande':
                    if (item.data.commandeId) {
                        markCommandeDirty(item.data.commandeId);
                        await syncManager.saveAllToSupabase();
                        success = true;
                    }
                    break;
                case 'delete_slot':
                    success = await deleteSlotFromSupabase(item.data.slotId);
                    break;
                default:
                    console.warn('Action offline inconnue:', item.action);
                    success = true;
            }

            if (!success) {
                failedItems.push(item);
            }

        } catch (e) {
            console.error('Erreur traitement offline:', e);
            failedItems.push(item);
        }
    }

    saveOfflineQueue(failedItems);

    if (failedItems.length === 0) {
        Toast.success('Toutes les modifications synchronisées !');
    } else {
        Toast.warning(`${failedItems.length} modification(s) en attente`);
    }
}

// Écouter le retour en ligne / hors ligne
window.addEventListener('online', () => {
    console.log('🌐 Connexion rétablie');
    updateRealtimeStatusUI('connected');
    // Attendre que la connexion soit stable
    setTimeout(() => {
        processOfflineQueue();
    }, 2000);
});

window.addEventListener('offline', () => {
    console.log('📴 Connexion perdue');
    updateRealtimeStatusUI('disconnected');
});

/**
 * Rafraîchir l'UI UNIQUEMENT (sans sauvegarde Supabase)
 * Utilisé par les handlers Realtime pour éviter les boucles de write-back
 */
function refreshUIOnly() {
    if (vueActive === 'semaine') {
        renderVueSemaine();
    } else if (vueActive === 'journee') {
        renderVueJournee();
    } else if (vueActive === 'liste') {
        renderVueListe();
    }
    renderCommandesNonPlacees(currentSearchQuery || '');
    updateCurrentTime();
}

/**
 * Sauvegarder en localStorage UNIQUEMENT (sans Supabase)
 * Utilisé par les handlers Realtime pour backup sans re-upload
 */
function saveLocalStorageOnly() {
    try {
        const dataStr = JSON.stringify(commandes);
        localStorage.setItem(syncManager.STORAGE_KEY, dataStr);
    } catch (e) {
        console.error('❌ Erreur sauvegarde localStorage:', e);
    }
}

/**
 * Debounce pour les handlers Realtime
 * Batch les events rapides (500ms) et ne fait que rafraîchir l'UI + localStorage
 */
let _realtimeUpdateTimer = null;

function debouncedRealtimeUpdate() {
    if (_realtimeUpdateTimer) {
        clearTimeout(_realtimeUpdateTimer);
    }
    _realtimeUpdateTimer = setTimeout(() => {
        _realtimeUpdateTimer = null;
        refreshUIOnly();
        saveLocalStorageOnly();
    }, 500);
}

/**
 * Handler pour les changements de commandes en temps réel
 */
function handleRealtimeCommandeChange(payload) {
    // Ignorer nos propres modifications
    const recordId = payload?.new?.id || payload?.old?.id;
    if (recordId && isOurOwnRealtimeEvent(recordId)) {
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif): commande ${recordId}`);
        return;
    }

    const eventType = payload.eventType;
    console.log(`📡 Realtime commande: ${eventType} ${recordId}`);

    switch (eventType) {
        case 'INSERT': {
            const newCmd = mapSupabaseCommandeToLocal(payload.new);
            // Vérifier si n'existe pas déjà
            if (!commandes.find(c => c.id === newCmd.id)) {
                commandes.push(newCmd);
                console.log(`➕ Commande ${newCmd.id} ajoutée`);
            }
            break;
        }
        case 'UPDATE': {
            const cmd = commandes.find(c => c.id === recordId);
            if (cmd) {
                // Mettre à jour seulement les champs de base (pas les operations/slots)
                cmd.client = payload.new.client_name;
                cmd.dateLivraison = payload.new.date_livraison;
                cmd.statut = payload.new.statut;
                cmd.materiau = payload.new.materiau;
                cmd.poids = parseFloat(payload.new.poids) || 0;
                cmd.refCdeClient = payload.new.ref_cde_client;
                cmd.ressource = payload.new.ressource;
                cmd.semaineAffectee = payload.new.semaine_affectee;
                console.log(`✏️ Commande ${recordId} mise à jour`);
            }
            break;
        }
        case 'DELETE': {
            const idx = commandes.findIndex(c => c.id === recordId);
            if (idx !== -1) {
                commandes.splice(idx, 1);
                console.log(`🗑️ Commande ${recordId} supprimée`);
            }
            break;
        }
    }

    debouncedRealtimeUpdate();
}

/**
 * Convertit une commande Supabase en format local
 */
function mapSupabaseCommandeToLocal(cmd) {
    return {
        id: cmd.id,
        client: cmd.client_name,
        dateLivraison: cmd.date_livraison,
        statut: cmd.statut,
        materiau: cmd.materiau,
        poids: parseFloat(cmd.poids) || 0,
        refCdeClient: cmd.ref_cde_client,
        ressource: cmd.ressource,
        semaineAffectee: cmd.semaine_affectee,
        operations: [] // Les opérations arrivent séparément
    };
}

/**
 * Handler pour les changements d'opérations en temps réel
 */
function handleRealtimeOperationChange(payload) {
    // Ignorer nos propres modifications
    const recordId = payload?.new?.id || payload?.old?.id;
    if (recordId && isOurOwnRealtimeEvent(recordId)) {
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif): operation ${recordId}`);
        return;
    }

    const eventType = payload.eventType;
    const commandeId = payload?.new?.commande_id || payload?.old?.commande_id;
    console.log(`📡 Realtime operation: ${eventType} ${recordId} (cmd: ${commandeId})`);

    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) {
        console.warn(`⚠️ Commande ${commandeId} non trouvée pour operation ${recordId}`);
        return;
    }

    if (!cmd.operations) cmd.operations = [];

    switch (eventType) {
        case 'INSERT': {
            if (!cmd.operations.find(op => op.id === recordId)) {
                cmd.operations.push(mapSupabaseOperationToLocal(payload.new));
                console.log(`➕ Operation ${recordId} ajoutée à ${commandeId}`);
            }
            break;
        }
        case 'UPDATE': {
            const op = cmd.operations.find(o => o.id === recordId);
            if (op) {
                op.type = payload.new.type;
                op.dureeTotal = parseFloat(payload.new.duree_total) || 0;
                op.dureeOriginal = parseFloat(payload.new.duree_original) || 0;
                op.dureeOverride = payload.new.duree_override ? parseFloat(payload.new.duree_override) : null;
                op.overrideTimestamp = payload.new.override_timestamp;
                op.progressionReelle = parseFloat(payload.new.progression_reelle) || 0;
                op.statut = payload.new.statut;
                console.log(`✏️ Operation ${recordId} mise à jour`);
            }
            break;
        }
        case 'DELETE': {
            const idx = cmd.operations.findIndex(o => o.id === recordId);
            if (idx !== -1) {
                cmd.operations.splice(idx, 1);
                console.log(`🗑️ Operation ${recordId} supprimée`);
            }
            break;
        }
    }

    debouncedRealtimeUpdate();
}

/**
 * Convertit une opération Supabase en format local
 */
function mapSupabaseOperationToLocal(op) {
    return {
        id: op.id,
        type: op.type,
        dureeTotal: parseFloat(op.duree_total) || 0,
        dureeOriginal: parseFloat(op.duree_original) || 0,
        dureeOverride: op.duree_override ? parseFloat(op.duree_override) : null,
        overrideTimestamp: op.override_timestamp,
        progressionReelle: parseFloat(op.progression_reelle) || 0,
        statut: op.statut,
        slots: [] // Les slots arrivent séparément
    };
}

/**
 * Handler pour les changements de slots en temps réel
 */
function handleRealtimeSlotChange(payload) {
    // Ignorer nos propres modifications
    const recordId = payload?.new?.id || payload?.old?.id;
    const operationId = payload?.new?.operation_id || payload?.old?.operation_id;

    if (recordId && isOurOwnRealtimeEvent(recordId)) {
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif): slot ${recordId}`);
        return;
    }
    if (operationId && isOurOwnRealtimeEvent(operationId)) {
        if (REALTIME_DEBUG) console.log(`🔇 Realtime ignoré (notre modif via operation): slot ${recordId}`);
        return;
    }

    const eventType = payload.eventType;
    console.log(`📡 Realtime slot: ${eventType} ${recordId} (op: ${operationId})`);

    // Trouver l'opération parente
    let targetOp = null;
    for (const cmd of commandes) {
        if (!cmd.operations) continue;
        targetOp = cmd.operations.find(op => op.id === operationId);
        if (targetOp) break;
    }

    if (!targetOp) {
        console.warn(`⚠️ Operation ${operationId} non trouvée pour slot ${recordId}`);
        return;
    }

    if (!targetOp.slots) targetOp.slots = [];

    switch (eventType) {
        case 'INSERT': {
            if (!targetOp.slots.find(s => s.id === recordId)) {
                targetOp.slots.push(mapSupabaseSlotToLocal(payload.new));
                console.log(`➕ Slot ${recordId} ajouté à ${operationId}`);
            }
            break;
        }
        case 'UPDATE': {
            const slot = targetOp.slots.find(s => s.id === recordId);
            if (slot) {
                Object.assign(slot, mapSupabaseSlotToLocal(payload.new));
                console.log(`✏️ Slot ${recordId} mis à jour`);
            }
            break;
        }
        case 'DELETE': {
            const idx = targetOp.slots.findIndex(s => s.id === recordId);
            if (idx !== -1) {
                targetOp.slots.splice(idx, 1);
                console.log(`🗑️ Slot ${recordId} supprimé`);
            }
            break;
        }
    }

    debouncedRealtimeUpdate();
}

/**
 * Convertit un slot Supabase en format local
 */
function mapSupabaseSlotToLocal(slot) {
    return {
        id: slot.id,
        machine: slot.machine_name,
        duree: parseFloat(slot.duree) || 0,
        semaine: slot.semaine,
        jour: slot.jour,
        heureDebut: slot.heure_debut,
        heureFin: slot.heure_fin,
        dateDebut: slot.date_debut,
        dateFin: slot.date_fin,
        overtime: slot.overtime || false
    };
}

/**
 * Handler pour les changements de machines en temps réel
 */
let _machineDebounceTimer = null;
function handleRealtimeMachineChange(payload) {
    if (_isSaving) return;

    if (_machineDebounceTimer) clearTimeout(_machineDebounceTimer);
    _machineDebounceTimer = setTimeout(() => {
        console.log('🔄 Realtime: rechargement machines...');
        loadMachinesConfig().then(() => {
            renderMachinesManager();
            refresh();
        }).catch(err => console.error('Erreur reload machines:', err));
    }, 2000);
}

/**
 * Handler pour les changements d'événements système en temps réel
 */
let _sysEventDebounceTimer = null;
function handleRealtimeSystemEventChange(payload) {
    if (_isSaving) return;

    if (_sysEventDebounceTimer) clearTimeout(_sysEventDebounceTimer);
    _sysEventDebounceTimer = setTimeout(() => {
        console.log('🔄 Realtime: rechargement événements système...');
        loadSystemEvents().then(() => {
            renderSystemEventsList();
            refresh();
        }).catch(err => console.error('Erreur reload system events:', err));
    }, 2000);
}

/**
 * Handler pour les changements de configuration horaires en temps réel
 */
let _scheduleDebounceTimer = null;
function handleRealtimeScheduleChange(payload) {
    if (_isSaving) return;

    if (_scheduleDebounceTimer) clearTimeout(_scheduleDebounceTimer);
    _scheduleDebounceTimer = setTimeout(() => {
        console.log('🔄 Realtime: rechargement config horaires...');
        loadScheduleConfig().then(() => {
            renderScheduleManager();
            refresh();
        }).catch(err => console.error('Erreur reload schedule:', err));
    }, 2000);
}

/**
 * Merge les données Realtime avec les données locales
 * Évite de perdre les modifications en cours de l'utilisateur
 */
function mergeRealtimeCommandes(remoteData) {
    const localIds = new Set(commandes.map(c => c.id));
    const remoteIds = new Set(remoteData.map(c => c.id));

    // Ajouter les nouvelles commandes
    remoteData.forEach(remoteCmd => {
        if (!localIds.has(remoteCmd.id)) {
            commandes.push(remoteCmd);
        } else {
            // Mettre à jour les commandes existantes (sauf si en cours de modification)
            const localIndex = commandes.findIndex(c => c.id === remoteCmd.id);
            if (localIndex !== -1) {
                // Préserver les slots locaux si plus récents
                const localCmd = commandes[localIndex];
                const localHasSlots = localCmd.operations?.some(op => op.slots?.length > 0);
                const remoteHasSlots = remoteCmd.operations?.some(op => op.slots?.length > 0);

                if (remoteHasSlots || !localHasSlots) {
                    commandes[localIndex] = remoteCmd;
                }
            }
        }
    });

    // Supprimer les commandes qui n'existent plus côté remote
    commandes = commandes.filter(c => remoteIds.has(c.id) || !c.id);
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Make functions globally accessible
window.placerAutomatiquement = placerAutomatiquement;
window.showCommandeDetails = showCommandeDetails;
window.toggleVue = toggleVue;
window.closeConflictModal = closeConflictModal;
window.resolveConflict = resolveConflict;

// ===================================
// Machine Management System
// ===================================

/**
 * Charge la configuration des machines depuis Supabase/localStorage
 */
async function loadMachinesConfig() {
    // Essayer Supabase d'abord
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('machines')
                .select('*')
                .order('type');

            if (!error && data && data.length > 0) {
                // Reconstruire machinesConfig depuis les données Supabase
                machinesConfig = {
                    cisaillage: data.filter(m => m.type === 'cisaillage').map(m => ({
                        id: m.id,
                        name: m.name,
                        capacity: parseFloat(m.capacity),
                        color: m.color,
                        active: m.active
                    })),
                    poinconnage: data.filter(m => m.type === 'poinconnage').map(m => ({
                        id: m.id,
                        name: m.name,
                        capacity: parseFloat(m.capacity),
                        color: m.color,
                        active: m.active
                    })),
                    pliage: data.filter(m => m.type === 'pliage').map(m => ({
                        id: m.id,
                        name: m.name,
                        capacity: parseFloat(m.capacity),
                        color: m.color,
                        active: m.active
                    }))
                };
                console.log('✅ Configuration machines chargée depuis Supabase');
                // Backup en localStorage
                localStorage.setItem(MACHINES_STORAGE_KEY, JSON.stringify(machinesConfig));
                reloadMachineArrays();
                return;
            }
        } catch (e) {
            console.warn('⚠️ Supabase machines load failed:', e);
        }
    }

    // Fallback: localStorage
    try {
        const stored = localStorage.getItem(MACHINES_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            // Valider la structure
            if (parsed.cisaillage && parsed.poinconnage && parsed.pliage) {
                machinesConfig = parsed;
                console.log('✅ Configuration machines chargée depuis localStorage');

                // Migrer vers Supabase si disponible
                if (supabaseClient) {
                    saveMachinesConfigToSupabase();
                }
            }
        }
    } catch (e) {
        console.error('Erreur chargement config machines:', e);
    }
    reloadMachineArrays();
}

/**
 * Sauvegarde la configuration des machines dans Supabase/localStorage
 */
function saveMachinesConfig() {
    // Sauvegarder en localStorage (backup)
    try {
        localStorage.setItem(MACHINES_STORAGE_KEY, JSON.stringify(machinesConfig));
        console.log('✅ Configuration machines sauvegardée localStorage');
    } catch (e) {
        console.error('Erreur sauvegarde config machines:', e);
        Toast.error('Erreur lors de la sauvegarde');
    }

    // Sauvegarder vers Supabase
    if (supabaseClient) {
        saveMachinesConfigToSupabase();
    }
}

async function saveMachinesConfigToSupabase() {
    if (!supabaseClient) return;

    try {
        const allMachines = [
            ...machinesConfig.cisaillage.map(m => ({ ...m, type: 'cisaillage' })),
            ...machinesConfig.poinconnage.map(m => ({ ...m, type: 'poinconnage' })),
            ...machinesConfig.pliage.map(m => ({ ...m, type: 'pliage' }))
        ];

        for (const machine of allMachines) {
            await supabaseClient
                .from('machines')
                .upsert({
                    id: machine.id,
                    name: machine.name,
                    type: machine.type,
                    capacity: machine.capacity,
                    color: machine.color,
                    active: machine.active,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
        }

        console.log('✅ Configuration machines sauvegardée Supabase');
    } catch (e) {
        console.error('❌ Erreur sauvegarde machines Supabase:', e);
    }
}

/**
 * Ouvre le modal de gestion des machines
 */
function openMachineManager() {
    const modal = document.getElementById('modalMachines');
    if (modal) {
        renderMachinesManager();
        modal.classList.add('active');
    }
}

/**
 * Ferme le modal de gestion des machines
 */
function closeMachineManager() {
    const modal = document.getElementById('modalMachines');
    if (modal) {
        modal.classList.remove('active');
    }
}

/**
 * Affiche la liste des machines dans le gestionnaire
 */
function renderMachinesManager() {
    const container = document.getElementById('machinesManagerContent');
    if (!container) return;

    const categories = [
        { key: 'cisaillage', label: 'Cisaillage', color: '#10b981' },
        { key: 'poinconnage', label: 'Poinçonnage', color: '#2563eb' },
        { key: 'pliage', label: 'Pliage', color: '#ef4444' }
    ];

    let html = '';

    categories.forEach(cat => {
        const machines = machinesConfig[cat.key] || [];
        html += `
            <div class="machine-section">
                <div class="machine-section-header">
                    <h3 style="color: ${cat.color};">${cat.label}</h3>
                    <button class="btn btn-sm btn-primary" onclick="openMachineEdit(null, '${cat.key}')">+ Ajouter</button>
                </div>
                <div class="machines-list">
        `;

        if (machines.length === 0) {
            html += `<p class="no-machines">Aucune machine dans cette catégorie</p>`;
        } else {
            machines.forEach(machine => {
                const statusClass = machine.active ? 'status-active' : 'status-inactive';
                const statusLabel = machine.active ? 'Active' : 'Inactive';
                html += `
                    <div class="machine-item" onclick="openMachineEdit('${machine.id}', '${cat.key}')">
                        <div class="machine-color" style="background: ${machine.color};"></div>
                        <div class="machine-info">
                            <span class="machine-name">${machine.name}</span>
                            <span class="machine-details">${machine.capacity}h/jour</span>
                        </div>
                        <span class="machine-status ${statusClass}">${statusLabel}</span>
                    </div>
                `;
            });
        }

        html += `
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

/**
 * Ouvre le modal d'édition/ajout d'une machine
 * @param {string|null} machineId - ID de la machine (null pour ajout)
 * @param {string} category - Catégorie de la machine
 */
function openMachineEdit(machineId, category) {
    const modal = document.getElementById('modalMachineEdit');
    const title = document.getElementById('machineEditTitle');
    const form = document.getElementById('formMachineEdit');
    const deleteBtn = document.getElementById('btnDeleteMachine');

    if (!modal || !form) return;

    // Reset form
    form.reset();

    // Set hidden fields
    document.getElementById('machineEditId').value = machineId || '';
    document.getElementById('machineEditCategory').value = category;

    if (machineId) {
        // Mode édition
        title.textContent = 'Modifier la machine';
        deleteBtn.style.display = 'block';

        const machines = machinesConfig[category] || [];
        const machine = machines.find(m => m.id === machineId);

        if (machine) {
            document.getElementById('machineEditOriginalName').value = machine.name;
            document.getElementById('machineEditName').value = machine.name;
            document.getElementById('machineEditCapacity').value = machine.capacity;
            document.getElementById('machineEditColor').value = machine.color;
            document.getElementById('machineEditActive').value = machine.active ? 'true' : 'false';
        }
    } else {
        // Mode ajout
        title.textContent = 'Ajouter une machine';
        deleteBtn.style.display = 'none';
        document.getElementById('machineEditOriginalName').value = '';

        // Couleur par défaut selon catégorie
        const defaultColors = {
            cisaillage: '#10b981',
            poinconnage: '#2563eb',
            pliage: '#ef4444'
        };
        document.getElementById('machineEditColor').value = defaultColors[category] || '#10b981';
    }

    modal.classList.add('active');
}

/**
 * Ferme le modal d'édition de machine
 */
function closeMachineEdit() {
    const modal = document.getElementById('modalMachineEdit');
    if (modal) {
        modal.classList.remove('active');
    }
}

/**
 * Sauvegarde les modifications d'une machine
 */
function saveMachineEdit() {
    const machineId = document.getElementById('machineEditId').value;
    const category = document.getElementById('machineEditCategory').value;
    const originalName = document.getElementById('machineEditOriginalName').value;
    const name = document.getElementById('machineEditName').value.trim();
    const capacity = parseFloat(document.getElementById('machineEditCapacity').value);
    const color = document.getElementById('machineEditColor').value;
    const active = document.getElementById('machineEditActive').value === 'true';

    if (!name) {
        Toast.error('Le nom de la machine est requis');
        return;
    }

    const machines = machinesConfig[category];
    if (!machines) {
        Toast.error('Catégorie invalide');
        return;
    }

    if (machineId) {
        // Mode édition
        const index = machines.findIndex(m => m.id === machineId);
        if (index !== -1) {
            const oldName = machines[index].name;
            const wasActive = machines[index].active === true || machines[index].active === 'true';

            machines[index] = {
                ...machines[index],
                name,
                capacity,
                color,
                active
            };

            // Si le nom a changé, mettre à jour les opérations planifiées
            if (oldName !== name) {
                updateOperationsMachineName(oldName, name);
            }

            // Si la machine passe de active à inactive, désaffecter les opérations
            if (wasActive && !active) {
                unassignOperationsFromMachine(oldName);
            }

            Toast.success('Machine modifiée avec succès');
        }
    } else {
        // Mode ajout
        const newId = `${category}-${Date.now()}`;
        machines.push({
            id: newId,
            name,
            capacity,
            color,
            active
        });
        Toast.success('Machine ajoutée avec succès');
    }

    saveMachinesConfig();
    reloadMachineArrays();
    closeMachineEdit();
    renderMachinesManager();
    refresh();
}

/**
 * Supprime une machine
 */
function deleteMachine() {
    const machineId = document.getElementById('machineEditId').value;
    const category = document.getElementById('machineEditCategory').value;
    const machineName = document.getElementById('machineEditName').value;

    if (!machineId || !category) return;

    // Vérifier si des opérations sont planifiées sur cette machine
    const hasPlannedOps = commandes.some(cmd =>
        cmd.operations?.some(op =>
            op.slots?.some(slot => slot.machine === machineName)
        )
    );

    let confirmMessage = `Êtes-vous sûr de vouloir supprimer la machine "${machineName}" ?`;
    if (hasPlannedOps) {
        confirmMessage += '\n\n⚠️ ATTENTION: Des opérations sont planifiées sur cette machine. Elles seront désaffectées.';
    }

    if (!confirm(confirmMessage)) return;

    const machines = machinesConfig[category];
    const index = machines.findIndex(m => m.id === machineId);

    if (index !== -1) {
        // Supprimer de Supabase d'abord
        if (typeof deleteMachineFromSupabase === 'function') {
            deleteMachineFromSupabase(machineId);
        }

        machines.splice(index, 1);

        // Désaffecter les opérations de cette machine
        if (hasPlannedOps) {
            unassignOperationsFromMachine(machineName);
        }

        saveMachinesConfig();
        reloadMachineArrays();
        closeMachineEdit();
        renderMachinesManager();
        refresh();
        Toast.success('Machine supprimée');
    }
}

/**
 * Met à jour le nom de machine dans les opérations planifiées (dans les slots)
 * @param {string} oldName - Ancien nom
 * @param {string} newName - Nouveau nom
 */
function updateOperationsMachineName(oldName, newName) {
    let updated = 0;
    commandes.forEach(cmd => {
        cmd.operations?.forEach(op => {
            op.slots?.forEach(slot => {
                if (slot.machine === oldName) {
                    slot.machine = newName;
                    updated++;
                }
            });
        });
    });

    if (updated > 0) {
        syncManager.saveLocalData();
    }
}

/**
 * Désaffecte TOUTES les opérations des commandes qui ont au moins une opération sur la machine inactive
 * Les commandes gardent leur semaineAffectee mais perdent tous leurs slots
 * @param {string} machineName - Nom de la machine
 */
function unassignOperationsFromMachine(machineName) {
    let commandesAffectees = 0;
    let operationsDesaffectees = 0;

    commandes.forEach(cmd => {
        // Vérifier si la commande a au moins une opération sur cette machine
        const hasOpOnMachine = cmd.operations?.some(op =>
            op.slots?.some(slot => slot.machine === machineName)
        );

        if (!hasOpOnMachine) return;

        commandesAffectees++;

        // Récupérer la semaine depuis le premier slot trouvé (avant de tout vider)
        if (!cmd.semaineAffectee) {
            for (const op of cmd.operations || []) {
                if (op.slots && op.slots.length > 0 && op.slots[0].semaine) {
                    cmd.semaineAffectee = op.slots[0].semaine;
                    break;
                }
            }
        }

        // Désaffecter TOUTES les opérations de cette commande
        cmd.operations?.forEach(op => {
            if (op.slots && op.slots.length > 0) {
                op.slots = [];
                operationsDesaffectees++;
            }
        });

        // Mettre à jour le statut
        if (cmd.statut === 'Planifiée') {
            cmd.statut = 'En attente';
        }
    });

    if (commandesAffectees > 0) {
        syncManager.saveLocalData();
        Toast.warning(`${commandesAffectees} commande(s) désaffectée(s) (${operationsDesaffectees} opérations)`);
    }
}

/**
 * Réinitialise la configuration des machines
 */
function resetMachinesConfig() {
    if (!confirm('Êtes-vous sûr de vouloir réinitialiser la configuration des machines ?\n\nCela restaurera les machines par défaut.')) {
        return;
    }

    localStorage.removeItem(MACHINES_STORAGE_KEY);
    machinesConfig = JSON.parse(JSON.stringify(MACHINES_CONFIG));
    reloadMachineArrays();
    renderMachinesManager();
    refresh();
    Toast.success('Configuration réinitialisée');
}

/**
 * Exporte la configuration des machines en fichier JSON
 */
function exportMachinesConfig() {
    const dataStr = JSON.stringify(machinesConfig, null, 2);
    const blob = new Blob([`const MACHINES_CONFIG = ${dataStr};\nObject.freeze(MACHINES_CONFIG);`], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.js';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    Toast.success('Configuration exportée');
}

/**
 * Initialise les event listeners du gestionnaire de machines
 */
function initMachineManagerHandlers() {
    // Bouton ouvrir
    document.getElementById('btnManageMachines')?.addEventListener('click', openMachineManager);

    // Boutons fermer modal principal
    document.getElementById('btnCloseMachines')?.addEventListener('click', closeMachineManager);
    document.getElementById('btnCloseMachinesBottom')?.addEventListener('click', closeMachineManager);

    // Boutons actions
    document.getElementById('btnResetMachines')?.addEventListener('click', resetMachinesConfig);
    document.getElementById('btnExportMachines')?.addEventListener('click', exportMachinesConfig);

    // Modal édition - fermer
    document.getElementById('btnCloseMachineEdit')?.addEventListener('click', closeMachineEdit);
    document.getElementById('btnCancelMachineEdit')?.addEventListener('click', closeMachineEdit);

    // Modal édition - supprimer
    document.getElementById('btnDeleteMachine')?.addEventListener('click', deleteMachine);

    // Modal édition - formulaire
    document.getElementById('formMachineEdit')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveMachineEdit();
    });

    // Fermer modals en cliquant en dehors
    document.getElementById('modalMachines')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalMachines') closeMachineManager();
    });

    document.getElementById('modalMachineEdit')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalMachineEdit') closeMachineEdit();
    });
}

// Exposer les fonctions globalement
window.openMachineEdit = openMachineEdit;
window.closeMachineEdit = closeMachineEdit;

// ===================================================================
// SCHEDULE MANAGER - Gestion dynamique des horaires
// ===================================================================

/**
 * Charge la configuration des horaires depuis Supabase/localStorage
 */
async function loadScheduleConfig() {
    // Essayer Supabase d'abord
    if (supabaseClient) {
        try {
            // Charger shifts
            const { data: shiftsData, error: shiftsError } = await supabaseClient
                .from('shifts')
                .select('*');

            // Charger shift_schedules
            const { data: schedulesData, error: schedulesError } = await supabaseClient
                .from('shift_schedules')
                .select('*');

            // Charger breaks
            const { data: breaksData, error: breaksError } = await supabaseClient
                .from('breaks')
                .select('*');

            // Charger overtime_config
            const { data: overtimeData, error: overtimeError } = await supabaseClient
                .from('overtime_config')
                .select('*')
                .limit(1)
                .single();

            // Charger overtime_slots
            const { data: overtimeSlotsData, error: overtimeSlotsError } = await supabaseClient
                .from('overtime_slots')
                .select('*');

            if (!shiftsError && shiftsData && shiftsData.length > 0) {
                // Reconstruire scheduleConfig
                const shifts = shiftsData.map(s => {
                    const shiftSchedules = (schedulesData || []).filter(sc => sc.shift_id === s.id);
                    const schedulesObj = {};
                    shiftSchedules.forEach(sc => {
                        schedulesObj[sc.day_name] = {
                            start: sc.start_time,
                            end: sc.end_time
                        };
                    });

                    return {
                        id: s.id,
                        name: s.name,
                        active: s.active,
                        days: s.days || [],
                        schedules: schedulesObj
                    };
                });

                const breaks = (breaksData || []).map(b => ({
                    id: b.id,
                    name: b.name,
                    start: b.start_time,
                    end: b.end_time,
                    days: b.days || [],
                    active: b.active
                }));

                const overtime = {
                    enabled: overtimeData?.enabled || false,
                    maxDailyHours: overtimeData?.max_daily_hours || 2,
                    maxWeeklyHours: overtimeData?.max_weekly_hours || 10,
                    slots: (overtimeSlotsData || []).map(os => ({
                        days: os.days || [],
                        start: os.start_time,
                        end: os.end_time,
                        maxHours: os.max_hours
                    }))
                };

                scheduleConfig = { shifts, breaks, overtime };
                console.log('[ScheduleConfig] Configuration chargée depuis Supabase');
                // Backup en localStorage
                localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(scheduleConfig));
                reloadScheduleArrays();
                return;
            }
        } catch (e) {
            console.warn('[ScheduleConfig] Supabase load failed:', e);
        }
    }

    // Fallback: localStorage
    try {
        const saved = localStorage.getItem(SCHEDULE_STORAGE_KEY);
        if (saved) {
            scheduleConfig = JSON.parse(saved);
            console.log('[ScheduleConfig] Configuration chargee depuis localStorage');

            // Migrer vers Supabase si disponible
            if (supabaseClient) {
                saveScheduleConfigToSupabase();
            }
        }
    } catch (e) {
        console.error('[ScheduleConfig] Erreur chargement:', e);
        scheduleConfig = JSON.parse(JSON.stringify(SCHEDULE_DEFAULT_CONFIG));
    }
    reloadScheduleArrays();
}

/**
 * Sauvegarde la configuration des horaires dans Supabase/localStorage
 */
function saveScheduleConfig() {
    // Sauvegarder en localStorage (backup)
    try {
        localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(scheduleConfig));
        console.log('[ScheduleConfig] Configuration sauvegardee localStorage');
    } catch (e) {
        console.error('[ScheduleConfig] Erreur sauvegarde:', e);
    }

    // Sauvegarder vers Supabase
    if (supabaseClient) {
        saveScheduleConfigToSupabase();
    }
}

async function saveScheduleConfigToSupabase() {
    if (!supabaseClient) return;

    try {
        // Sauvegarder shifts
        for (const shift of scheduleConfig.shifts) {
            await supabaseClient
                .from('shifts')
                .upsert({
                    id: shift.id,
                    name: shift.name,
                    active: shift.active,
                    days: shift.days,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });

            // Supprimer anciens schedules pour ce shift
            await supabaseClient
                .from('shift_schedules')
                .delete()
                .eq('shift_id', shift.id);

            // Insérer nouveaux schedules
            if (shift.schedules) {
                for (const [dayName, schedule] of Object.entries(shift.schedules)) {
                    await supabaseClient
                        .from('shift_schedules')
                        .insert({
                            shift_id: shift.id,
                            day_name: dayName,
                            start_time: schedule.start,
                            end_time: schedule.end
                        });
                }
            }
        }

        // Sauvegarder breaks
        for (const brk of scheduleConfig.breaks) {
            await supabaseClient
                .from('breaks')
                .upsert({
                    id: brk.id,
                    name: brk.name,
                    start_time: brk.start,
                    end_time: brk.end,
                    days: brk.days,
                    active: brk.active,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
        }

        // Sauvegarder overtime config
        if (scheduleConfig.overtime) {
            // Supprimer et réinsérer
            await supabaseClient.from('overtime_config').delete().neq('id', '00000000-0000-0000-0000-000000000000');

            const { data: otConfig } = await supabaseClient
                .from('overtime_config')
                .insert({
                    enabled: scheduleConfig.overtime.enabled,
                    max_daily_hours: scheduleConfig.overtime.maxDailyHours,
                    max_weekly_hours: scheduleConfig.overtime.maxWeeklyHours
                })
                .select()
                .single();

            if (otConfig && scheduleConfig.overtime.slots) {
                await supabaseClient.from('overtime_slots').delete().eq('overtime_config_id', otConfig.id);

                for (const slot of scheduleConfig.overtime.slots) {
                    await supabaseClient
                        .from('overtime_slots')
                        .insert({
                            overtime_config_id: otConfig.id,
                            days: slot.days,
                            start_time: slot.start,
                            end_time: slot.end,
                            max_hours: slot.maxHours
                        });
                }
            }
        }

        console.log('[ScheduleConfig] Configuration sauvegardée Supabase');
    } catch (e) {
        console.error('[ScheduleConfig] Erreur sauvegarde Supabase:', e);
    }
}

/**
 * Convertit une heure "HH:MM" en decimal (ex: "07:30" -> 7.5)
 */
function timeStringToDecimal(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h + m / 60;
}

/**
 * Retourne les plages horaires disponibles pour un jour donne
 * en combinant TOUTES les equipes actives
 */
function getAvailableRangesForDay(day) {
    const ranges = [];
    scheduleConfig.shifts.filter(s => s.active && s.schedules && s.schedules[day]).forEach(shift => {
        const schedule = shift.schedules[day];
        ranges.push({
            shiftId: shift.id,
            shiftName: shift.name,
            start: timeStringToDecimal(schedule.start),
            end: timeStringToDecimal(schedule.end)
        });
    });
    // Trier par heure de debut
    return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Retourne toutes les pauses actives pour un jour
 */
function getActiveBreaksForDay(day) {
    return scheduleConfig.breaks.filter(b => b.active && b.days && b.days.includes(day));
}

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

            // Soustraire les pauses actives qui chevauchent cette plage
            getActiveBreaksForDay(day).forEach(b => {
                const breakStart = timeStringToDecimal(b.start);
                const breakEnd = timeStringToDecimal(b.end);

                // Si la pause chevauche cette plage
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
    const dejeuner = scheduleConfig.breaks.find(b => b.active && b.id === 'dejeuner');
    if (dejeuner) {
        return {
            start: dejeuner.start,
            end: dejeuner.end,
            duration: timeStringToDecimal(dejeuner.end) - timeStringToDecimal(dejeuner.start)
        };
    }
    // Retourner une valeur par defaut si pas de pause dejeuner active
    return { start: '12:30', end: '13:00', duration: 0.5 };
}

/**
 * Construit la config horaire dynamique pour un jour
 */
function buildScheduleConfigForDay(day) {
    const ranges = getAvailableRangesForDay(day);
    if (ranges.length === 0) return null;

    const breaks = getActiveBreaksForDay(day);
    const overtime = scheduleConfig.overtime;
    const overtimeSlot = overtime && overtime.enabled ? overtime.slots.find(s => s.days.includes(day)) : null;

    // Plage totale = du debut de la premiere equipe a la fin de la derniere
    const dayStart = Math.min(...ranges.map(r => r.start));
    const dayEnd = Math.max(...ranges.map(r => r.end));
    const overtimeEnd = overtimeSlot ? timeStringToDecimal(overtimeSlot.end) : dayEnd;

    // Pauses pour ce jour
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
        CR_THRESHOLD: SCHEDULE_CONFIG.CR_THRESHOLD || 1.05,
        CR_FORCE_THRESHOLD: SCHEDULE_CONFIG.CR_FORCE_THRESHOLD || 0.95,
        MAX_DISPLACEMENTS_NORMAL: SCHEDULE_CONFIG.MAX_DISPLACEMENTS_NORMAL || 5,
        MAX_DISPLACEMENTS_FORCE: SCHEDULE_CONFIG.MAX_DISPLACEMENTS_FORCE || 20,
        SEARCH_HORIZON_DAYS: SCHEDULE_CONFIG.SEARCH_HORIZON_DAYS || 14
    };
}

/**
 * Recharge les tableaux d'horaires depuis scheduleConfig
 */
function reloadScheduleArrays() {
    // Recalculer HOURS_PER_DAY depuis scheduleConfig.shifts
    HOURS_PER_DAY = calculateHoursPerDay();

    // Recalculer LUNCH_BREAK depuis scheduleConfig.breaks
    LUNCH_BREAK = getActiveLunchBreak();

    // Recalculer SCHEDULE_CONFIG
    SCHEDULE_CONFIG = buildScheduleConfig();

    // Recalculer TOTAL_HOURS_PER_WEEK
    TOTAL_HOURS_PER_WEEK = Object.values(HOURS_PER_DAY).reduce((a, b) => a + b, 0);

    console.log('[ScheduleConfig] Arrays recharges:', {
        HOURS_PER_DAY,
        LUNCH_BREAK,
        TOTAL_HOURS_PER_WEEK
    });
}

/**
 * Verifie et desaffecte les operations hors des nouveaux horaires
 */
function checkAndUnassignOutOfScheduleOperations() {
    let unassignedCount = 0;

    commandes.forEach(cmd => {
        cmd.operations?.forEach(op => {
            if (!op.slots || op.slots.length === 0) return;

            op.slots = op.slots.filter(slot => {
                const dayConfig = buildScheduleConfigForDay(slot.jour);
                if (!dayConfig) {
                    unassignedCount++;
                    return false; // Jour non travaille
                }

                const slotStart = timeToDecimalHours(slot.heureDebut);
                const slotEnd = slotStart + slot.duree;

                // Verifier si le slot est dans les plages valides
                const isValid = dayConfig.ranges.some(range =>
                    slotStart >= range.start && slotEnd <= range.end
                ) || (slotStart >= dayConfig.start && slotEnd <= dayConfig.overtimeEnd);

                if (!isValid) unassignedCount++;
                return isValid;
            });
        });

        // Mettre a jour statut si plus d'operations placees
        if (cmd.statut === 'Planifiee') {
            const hasPlacedOps = cmd.operations?.some(op => op.slots && op.slots.length > 0);
            if (!hasPlacedOps) cmd.statut = 'En attente';
        }
    });

    if (unassignedCount > 0) {
        syncManager.saveLocalData();
        Toast.warning(`${unassignedCount} operation(s) desaffectee(s) (hors nouveaux horaires)`);
    }

    return unassignedCount;
}

/**
 * Ouvre le gestionnaire d'horaires
 */
function openScheduleManager() {
    document.getElementById('modalSchedule').style.display = 'flex';
    renderScheduleManager();
}

/**
 * Ferme le gestionnaire d'horaires
 */
function closeScheduleManager() {
    document.getElementById('modalSchedule').style.display = 'none';
}

/**
 * Affiche le contenu du gestionnaire d'horaires
 */
function renderScheduleManager() {
    // Render shifts
    const shiftsList = document.getElementById('shiftsList');
    if (scheduleConfig.shifts && scheduleConfig.shifts.length > 0) {
        shiftsList.innerHTML = scheduleConfig.shifts.map(shift => {
            const daysHtml = shift.days.map(d => `<span class="shift-day">${d.substring(0, 3)}</span>`).join('');
            const statusClass = shift.active ? 'status-active' : 'status-inactive';
            const statusText = shift.active ? 'Active' : 'Inactive';

            // Calculer les horaires representatifs (premier jour)
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
    if (scheduleConfig.breaks && scheduleConfig.breaks.length > 0) {
        breaksList.innerHTML = scheduleConfig.breaks.map(brk => {
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
        toggleOvertime.checked = scheduleConfig.overtime && scheduleConfig.overtime.enabled;
    }

    if (overtimeConfig && scheduleConfig.overtime) {
        overtimeConfig.classList.toggle('disabled', !scheduleConfig.overtime.enabled);

        let slotsHtml = '';
        if (scheduleConfig.overtime.slots) {
            slotsHtml = scheduleConfig.overtime.slots.map(slot => `
                <div class="overtime-slot">
                    <span class="overtime-slot-days">${slot.days.join(', ')}</span>
                    <span class="overtime-slot-time">${slot.start} - ${slot.end}</span>
                </div>
            `).join('');
        }

        overtimeConfig.innerHTML = `
            ${slotsHtml}
            <div style="margin-top: 8px; font-size: 12px; color: var(--color-text-secondary);">
                Max: ${scheduleConfig.overtime.maxDailyHours}h/jour, ${scheduleConfig.overtime.maxWeeklyHours}h/semaine
            </div>
        `;
    }
}

/**
 * Ouvre le modal d'edition d'equipe
 */
function openShiftEdit(shiftId = null) {
    const modal = document.getElementById('modalShiftEdit');
    const title = document.getElementById('shiftEditTitle');
    const deleteBtn = document.getElementById('btnDeleteShift');
    const form = document.getElementById('formShiftEdit');

    form.reset();

    if (shiftId) {
        // Mode edition
        const shift = scheduleConfig.shifts.find(s => s.id === shiftId);
        if (!shift) return;

        title.textContent = "Modifier l'equipe";
        deleteBtn.style.display = 'block';

        document.getElementById('shiftEditId').value = shift.id;
        document.getElementById('shiftEditName').value = shift.name;
        document.getElementById('shiftEditActive').value = shift.active ? 'true' : 'false';

        // Cocher les jours
        document.querySelectorAll('#shiftDaysCheckboxes input[name="shiftDay"]').forEach(cb => {
            cb.checked = shift.days.includes(cb.value);
        });

        // Afficher les horaires par jour
        updateShiftSchedulesDisplay(shift.schedules || {});
    } else {
        // Mode ajout
        title.textContent = "Ajouter une equipe";
        deleteBtn.style.display = 'none';
        document.getElementById('shiftEditId').value = '';

        // Cocher tous les jours par defaut
        document.querySelectorAll('#shiftDaysCheckboxes input[name="shiftDay"]').forEach(cb => {
            cb.checked = true;
        });

        updateShiftSchedulesDisplay({});
    }

    modal.style.display = 'flex';
}

/**
 * Met a jour l'affichage des horaires par jour
 */
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

/**
 * Ferme le modal d'edition d'equipe
 */
function closeShiftEdit() {
    document.getElementById('modalShiftEdit').style.display = 'none';
}

/**
 * Sauvegarde l'equipe editee
 */
function saveShiftEdit() {
    const shiftId = document.getElementById('shiftEditId').value;
    const name = document.getElementById('shiftEditName').value.trim();
    const active = document.getElementById('shiftEditActive').value === 'true';

    if (!name) {
        Toast.error('Veuillez entrer un nom');
        return;
    }

    // Recuperer les jours selectionnes
    const days = Array.from(document.querySelectorAll('#shiftDaysCheckboxes input[name="shiftDay"]:checked'))
        .map(cb => cb.value);

    if (days.length === 0) {
        Toast.error('Selectionnez au moins un jour');
        return;
    }

    // Recuperer les horaires par jour
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
        // Mode edition
        const index = scheduleConfig.shifts.findIndex(s => s.id === shiftId);
        if (index !== -1) {
            scheduleConfig.shifts[index] = {
                ...scheduleConfig.shifts[index],
                name,
                active,
                days,
                schedules
            };
            Toast.success('Equipe modifiee');
        }
    } else {
        // Mode ajout
        const newId = `shift-${Date.now()}`;
        scheduleConfig.shifts.push({
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

/**
 * Supprime une equipe
 */
function deleteShift() {
    const shiftId = document.getElementById('shiftEditId').value;
    if (!shiftId) return;

    if (!confirm('Etes-vous sur de vouloir supprimer cette equipe ?')) return;

    const index = scheduleConfig.shifts.findIndex(s => s.id === shiftId);
    if (index !== -1) {
        scheduleConfig.shifts.splice(index, 1);

        saveScheduleConfig();
        reloadScheduleArrays();
        checkAndUnassignOutOfScheduleOperations();
        closeShiftEdit();
        renderScheduleManager();
        refresh();
        Toast.success('Equipe supprimee');
    }
}

/**
 * Ouvre le modal d'edition de pause
 */
function openBreakEdit(breakId = null) {
    const modal = document.getElementById('modalBreakEdit');
    const title = document.getElementById('breakEditTitle');
    const deleteBtn = document.getElementById('btnDeleteBreak');
    const form = document.getElementById('formBreakEdit');

    form.reset();

    if (breakId) {
        // Mode edition
        const brk = scheduleConfig.breaks.find(b => b.id === breakId);
        if (!brk) return;

        title.textContent = 'Modifier la pause';
        deleteBtn.style.display = 'block';

        document.getElementById('breakEditId').value = brk.id;
        document.getElementById('breakEditName').value = brk.name;
        document.getElementById('breakEditStart').value = brk.start;
        document.getElementById('breakEditEnd').value = brk.end;
        document.getElementById('breakEditActive').value = brk.active ? 'true' : 'false';

        // Cocher les jours
        document.querySelectorAll('#breakDaysCheckboxes input[name="breakDay"]').forEach(cb => {
            cb.checked = brk.days.includes(cb.value);
        });
    } else {
        // Mode ajout
        title.textContent = 'Ajouter une pause';
        deleteBtn.style.display = 'none';
        document.getElementById('breakEditId').value = '';
        document.getElementById('breakEditStart').value = '10:00';
        document.getElementById('breakEditEnd').value = '10:15';

        // Cocher tous les jours par defaut
        document.querySelectorAll('#breakDaysCheckboxes input[name="breakDay"]').forEach(cb => {
            cb.checked = true;
        });
    }

    modal.style.display = 'flex';
}

/**
 * Ferme le modal d'edition de pause
 */
function closeBreakEdit() {
    document.getElementById('modalBreakEdit').style.display = 'none';
}

/**
 * Sauvegarde la pause editee
 */
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

    // Recuperer les jours selectionnes
    const days = Array.from(document.querySelectorAll('#breakDaysCheckboxes input[name="breakDay"]:checked'))
        .map(cb => cb.value);

    if (days.length === 0) {
        Toast.error('Selectionnez au moins un jour');
        return;
    }

    if (breakId) {
        // Mode edition
        const index = scheduleConfig.breaks.findIndex(b => b.id === breakId);
        if (index !== -1) {
            scheduleConfig.breaks[index] = {
                ...scheduleConfig.breaks[index],
                name,
                start,
                end,
                days,
                active
            };
            Toast.success('Pause modifiee');
        }
    } else {
        // Mode ajout
        const newId = `break-${Date.now()}`;
        scheduleConfig.breaks.push({
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

/**
 * Supprime une pause
 */
function deleteBreak() {
    const breakId = document.getElementById('breakEditId').value;
    if (!breakId) return;

    if (!confirm('Etes-vous sur de vouloir supprimer cette pause ?')) return;

    const index = scheduleConfig.breaks.findIndex(b => b.id === breakId);
    if (index !== -1) {
        scheduleConfig.breaks.splice(index, 1);

        saveScheduleConfig();
        reloadScheduleArrays();
        closeBreakEdit();
        renderScheduleManager();
        refresh();
        Toast.success('Pause supprimee');
    }
}

/**
 * Toggle heures supplementaires
 */
function toggleOvertimeEnabled() {
    scheduleConfig.overtime.enabled = document.getElementById('toggleOvertime').checked;
    saveScheduleConfig();
    reloadScheduleArrays();
    renderScheduleManager();
    refresh();
}

/**
 * Reinitialise la configuration des horaires
 */
function resetScheduleConfig() {
    if (!confirm('Etes-vous sur de vouloir reinitialiser les horaires ?\n\nCela restaurera les horaires par defaut.')) {
        return;
    }

    localStorage.removeItem(SCHEDULE_STORAGE_KEY);
    scheduleConfig = JSON.parse(JSON.stringify(SCHEDULE_DEFAULT_CONFIG));
    reloadScheduleArrays();
    checkAndUnassignOutOfScheduleOperations();
    renderScheduleManager();
    refresh();
    Toast.success('Horaires reinitialises');
}

/**
 * Exporte la configuration des horaires en fichier JSON
 */
function exportScheduleConfig() {
    const dataStr = JSON.stringify(scheduleConfig, null, 2);
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

/**
 * Initialise les event listeners du gestionnaire d'horaires
 */
function initScheduleManagerHandlers() {
    // Bouton ouvrir
    document.getElementById('btnManageSchedule')?.addEventListener('click', openScheduleManager);

    // Boutons fermer modal principal
    document.getElementById('btnCloseSchedule')?.addEventListener('click', closeScheduleManager);
    document.getElementById('btnCloseScheduleBottom')?.addEventListener('click', closeScheduleManager);

    // Boutons actions
    document.getElementById('btnResetSchedule')?.addEventListener('click', resetScheduleConfig);
    document.getElementById('btnExportSchedule')?.addEventListener('click', exportScheduleConfig);

    // Boutons ajouter
    document.getElementById('btnAddShift')?.addEventListener('click', () => openShiftEdit(null));
    document.getElementById('btnAddBreak')?.addEventListener('click', () => openBreakEdit(null));

    // Toggle overtime
    document.getElementById('toggleOvertime')?.addEventListener('change', toggleOvertimeEnabled);

    // Modal edition equipe
    document.getElementById('btnCloseShiftEdit')?.addEventListener('click', closeShiftEdit);
    document.getElementById('btnCancelShiftEdit')?.addEventListener('click', closeShiftEdit);
    document.getElementById('btnDeleteShift')?.addEventListener('click', deleteShift);
    document.getElementById('formShiftEdit')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveShiftEdit();
    });

    // Mise a jour dynamique des horaires quand on change les jours
    document.getElementById('shiftDaysCheckboxes')?.addEventListener('change', () => {
        const shiftId = document.getElementById('shiftEditId').value;
        const shift = shiftId ? scheduleConfig.shifts.find(s => s.id === shiftId) : null;
        updateShiftSchedulesDisplay(shift?.schedules || {});
    });

    // Modal edition pause
    document.getElementById('btnCloseBreakEdit')?.addEventListener('click', closeBreakEdit);
    document.getElementById('btnCancelBreakEdit')?.addEventListener('click', closeBreakEdit);
    document.getElementById('btnDeleteBreak')?.addEventListener('click', deleteBreak);
    document.getElementById('formBreakEdit')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveBreakEdit();
    });

    // Fermer modals en cliquant en dehors
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

// Exposer les fonctions globalement pour le HTML
window.openShiftEdit = openShiftEdit;
window.closeShiftEdit = closeShiftEdit;
window.openBreakEdit = openBreakEdit;
window.closeBreakEdit = closeBreakEdit;

// ===================================
// PLANIFIER SEMI-AUTO (VUE SEMAINE)
// ===================================

/**
 * État global du modal planifier semi-auto
 */
let planifierSemiAutoState = {
    commandeId: null,
    commande: null,
    targetWeek: null,
    targetYear: null,
    selectedMachines: {},  // { opIndex: machineName }
    selectedDay: null,
    selectedTime: null,
    calculatedSlots: [],   // Résultat du calcul
    timeSlots: []          // Créneaux horaires disponibles
};

/**
 * Ouvre le modal de planification semi-automatique
 * @param {string} commandeId - ID de la commande
 * @param {number} targetWeek - Semaine cible
 * @param {number} targetYear - Année cible
 */
function openPlanifierSemiAutoModal(commandeId, targetWeek, targetYear) {
    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        return;
    }

    // Initialiser l'état
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

    // Initialiser le modal
    initPlanifierModal(cmd, targetWeek, targetYear);

    // Afficher le modal (étape 1)
    document.getElementById('planifierStep1').classList.add('active');
    document.getElementById('planifierStep2').classList.remove('active');
    document.getElementById('modalPlanifierSemiAuto').classList.add('active');
}

/**
 * Initialise le contenu du modal
 */
function initPlanifierModal(cmd, targetWeek, targetYear) {
    // Titre
    document.getElementById('planifierModalTitle').textContent = `Planifier ${cmd.id}`;

    // Info client
    document.getElementById('planifierClientInfo').innerHTML = `
        <strong>Client:</strong> ${cmd.client} |
        <strong>Livraison:</strong> ${formatDate(cmd.dateLivraison)}
    `;

    // Opérations à placer
    renderPlanifierOperations(cmd);

    // Afficher/cacher l'option parallèle selon les opérations à placer
    const opsAPlacer = cmd.operations.filter(op => !op.slots || op.slots.length === 0);
    const hasPoinconnage = opsAPlacer.some(op => op.type === 'Poinçonnage');
    const hasPliage = opsAPlacer.some(op => op.type === 'Pliage');
    const parallelOption = document.getElementById('planifierParallelOption');
    const parallelCheckbox = document.getElementById('planifierParallelCheckbox');

    if (hasPoinconnage && hasPliage) {
        parallelOption.style.display = 'block';
        parallelCheckbox.checked = false; // Reset checkbox
    } else {
        parallelOption.style.display = 'none';
        parallelCheckbox.checked = false;
    }

    // Jours de la semaine
    renderPlanifierDayOptions(targetWeek, targetYear);

    // Slider heure
    initPlanifierTimeSlider();
}

/**
 * Génère les créneaux horaires (pas de 30 min)
 */
function generateTimeSlots() {
    const slots = [];
    // De 07:00 à 18:00 par pas de 30 min
    for (let h = 7; h <= 18; h++) {
        for (let m = 0; m < 60; m += 30) {
            if (h === 18 && m > 0) break;
            const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
            slots.push(timeStr);
        }
    }
    return slots;
}

/**
 * Affiche les opérations avec sélecteur de machine
 */
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
        const duration = hasTimeOverride(op) ? op.dureeOverride : op.dureeTotal;

        // Pré-sélectionner la première machine disponible
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

/**
 * Retourne les machines disponibles pour un type d'opération
 */
function getMachinesForOperationType(opType) {
    const type = opType.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (type === 'cisaillage') {
        return machinesConfig.cisaillage.filter(m => m.active).map(m => m.name);
    } else if (type === 'poinconnage') {
        return machinesConfig.poinconnage.filter(m => m.active).map(m => m.name);
    } else if (type === 'pliage') {
        return machinesConfig.pliage.filter(m => m.active).map(m => m.name);
    }
    return [];
}

/**
 * Rendu de la jauge de charge inline
 */
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

/**
 * Met à jour la sélection de machine pour une opération
 */
function updatePlanifierMachineSelection(opIndex, machineName) {
    planifierSemiAutoState.selectedMachines[opIndex] = machineName;

    // Mettre à jour la jauge
    const gaugeContainer = document.getElementById(`planifierGauge_${opIndex}`);
    if (gaugeContainer) {
        gaugeContainer.innerHTML = renderMachineGaugeInline(
            machineName,
            planifierSemiAutoState.targetWeek,
            planifierSemiAutoState.targetYear
        );
    }
}

/**
 * Affiche les options de jours pour la semaine cible
 */
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
    select.value = '0'; // Lundi par défaut
    planifierSemiAutoState.selectedDay = 0;

    select.addEventListener('change', (e) => {
        planifierSemiAutoState.selectedDay = parseInt(e.target.value);
        updateTimeSliderForDay();
    });
}

/**
 * Retourne les dates de la semaine
 */
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

/**
 * Initialise le slider d'heure
 */
function initPlanifierTimeSlider() {
    const slider = document.getElementById('planifierTimeSlider');
    const display = document.getElementById('planifierTimeDisplay');

    // Configurer le slider selon le jour (Vendredi a des horaires différents)
    updateTimeSliderForDay();

    slider.addEventListener('input', (e) => {
        const index = parseInt(e.target.value);
        const time = planifierSemiAutoState.timeSlots[index] || '07:30';
        display.textContent = time;
        planifierSemiAutoState.selectedTime = time;
    });

    // Valeur initiale
    slider.value = 1; // 07:30 par défaut
    display.textContent = planifierSemiAutoState.timeSlots[1] || '07:30';
    planifierSemiAutoState.selectedTime = planifierSemiAutoState.timeSlots[1] || '07:30';
}

/**
 * Met à jour le slider selon le jour sélectionné
 */
function updateTimeSliderForDay() {
    const slider = document.getElementById('planifierTimeSlider');
    const dayIndex = planifierSemiAutoState.selectedDay;
    const dayName = DAYS_OF_WEEK[dayIndex];

    // Générer les créneaux selon le jour
    let slots = [];
    if (dayName === 'Vendredi') {
        // Vendredi: 07:00 - 14:00 (avec heures sup)
        for (let h = 7; h <= 14; h++) {
            for (let m = 0; m < 60; m += 30) {
                if (h === 14 && m > 0) break;
                slots.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
            }
        }
    } else {
        // Lundi-Jeudi: 07:30 - 18:00 (avec heures sup)
        for (let h = 7; h <= 18; h++) {
            for (let m = 0; m < 60; m += 30) {
                if (h === 7 && m === 0) continue; // Pas de 07:00 sauf vendredi
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

/**
 * Calcule le placement semi-automatique
 * Support du placement parallèle Poinçonnage/Pliage
 * Prend en compte les opérations déjà placées (ex: Cisaillage)
 */
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

    // Vérifier l'option parallèle
    const placeInParallel = document.getElementById('planifierParallelCheckbox')?.checked || false;

    // Construire la contrainte de départ
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

    // Contrainte après Cisaillage pour le placement parallèle
    let constraintAfterCisaillage = null;

    // Vérifier si Cisaillage est déjà placé (contrainte obligatoire pour Poinçonnage/Pliage)
    const cisaillageOp = cmd.operations.find(op => op.type === 'Cisaillage');
    if (cisaillageOp && cisaillageOp.slots && cisaillageOp.slots.length > 0) {
        // Trouver la fin de Cisaillage
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

        // Comparer avec la contrainte utilisateur et prendre la plus tardive
        const userDate = getDateFromWeekDay(startWeek, startDay, startTime, startYear);
        const cisaillageEndDate = getDateFromWeekDay(
            cisaillageEndConstraint.week,
            DAYS_OF_WEEK[cisaillageEndConstraint.dayIndex],
            cisaillageEndConstraint.timeStr,
            cisaillageEndConstraint.year
        );

        if (cisaillageEndDate > userDate) {
            // Cisaillage se termine après l'heure choisie par l'utilisateur
            currentConstraint = cisaillageEndConstraint;
            console.log(`⚠️ Cisaillage déjà placé: contrainte ajustée à S${currentConstraint.week} ${DAYS_OF_WEEK[currentConstraint.dayIndex]} ${currentConstraint.timeStr}`);
            Toast.info(`Contrainte ajustée: Cisaillage se termine à ${cisaillageEndConstraint.timeStr}`);
        }

        // Pour le mode parallèle, utiliser cette contrainte
        constraintAfterCisaillage = currentConstraint;
    }

    // Pour chaque opération, trouver le créneau
    for (let i = 0; i < opsAPlacer.length; i++) {
        const op = opsAPlacer[i];
        const selectedMachine = state.selectedMachines[i];
        const duration = hasTimeOverride(op) ? op.dureeOverride : op.dureeTotal;

        // En mode parallèle, Poinçonnage et Pliage démarrent au même endroit (après Cisaillage)
        let constraintToUse = currentConstraint;
        if (placeInParallel && (op.type === 'Poinçonnage' || op.type === 'Pliage')) {
            constraintToUse = constraintAfterCisaillage || currentConstraint;
            console.log(`🔀 Mode parallèle: ${op.type} démarre à S${constraintToUse.week} ${DAYS_OF_WEEK[constraintToUse.dayIndex]} ${constraintToUse.timeStr}`);
        }

        // Trouver les créneaux pour cette opération
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

        // Sauvegarder la contrainte après Cisaillage pour le mode parallèle
        if (op.type === 'Cisaillage' && placeInParallel) {
            const lastSlot = slotsForOp[slotsForOp.length - 1];
            constraintAfterCisaillage = {
                week: lastSlot.semaine,
                year: lastSlot.year || startYear,
                dayIndex: DAYS_OF_WEEK.indexOf(lastSlot.jour),
                timeStr: lastSlot.heureFin
            };

            // Si on dépasse la journée, passer au jour suivant
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

        // Mettre à jour la contrainte pour l'opération suivante (mode séquentiel uniquement)
        if (!placeInParallel || op.type === 'Cisaillage') {
            const lastSlot = slotsForOp[slotsForOp.length - 1];
            currentConstraint = {
                week: lastSlot.semaine,
                year: lastSlot.year || startYear,
                dayIndex: DAYS_OF_WEEK.indexOf(lastSlot.jour),
                timeStr: lastSlot.heureFin
            };

            // Si on dépasse la journée, passer au jour suivant
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

    // Stocker le résultat et afficher le récapitulatif
    state.calculatedSlots = calculatedSlots;
    showPlanifierRecap(calculatedSlots, cmd);
}

/**
 * Retourne l'heure de fin de journée selon le jour
 */
function getEndOfDayHour(dayName) {
    if (dayName === 'Vendredi') return 12;
    return 16.5;
}

/**
 * Retourne l'heure de début de journée selon le jour
 */
function getDayStartTime(dayName) {
    if (dayName === 'Vendredi') return '07:00';
    return '07:30';
}

/**
 * Trouve les créneaux pour une opération (peut être multi-jours)
 */
function findSlotsForOperationSemiAuto(operation, machine, duration, constraint, cmd) {
    const slots = [];
    let remainingDuration = duration;
    let currentWeek = constraint.week;
    let currentYear = constraint.year;
    let currentDayIndex = constraint.dayIndex;
    let currentTimeStr = constraint.timeStr;

    const maxIterations = 20; // Sécurité anti-boucle infinie
    let iterations = 0;

    while (remainingDuration > 0.01 && iterations < maxIterations) {
        iterations++;
        const dayName = DAYS_OF_WEEK[currentDayIndex];

        // Trouver le prochain gap disponible
        const gap = findNextGap(machine, dayName, currentWeek, currentTimeStr, currentYear);

        if (!gap) {
            // Pas de gap ce jour, passer au suivant
            const next = getNextWorkDay(dayName, currentWeek, currentYear);
            currentWeek = next.week;
            currentYear = next.year;
            currentDayIndex = DAYS_OF_WEEK.indexOf(next.day);
            currentTimeStr = getDayStartTime(next.day);
            continue;
        }

        // Calculer combien on peut placer
        const usableDuration = Math.min(gap.duration || 0, remainingDuration);

        if (usableDuration < 0.1 || isNaN(usableDuration)) {
            // Gap trop petit ou invalide, chercher le suivant
            const endTime = addHoursToTime(gap.startTime, gap.duration || 0);
            currentTimeStr = endTime;
            continue;
        }

        // Créer le slot
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

        // Mettre à jour pour la prochaine itération
        if (remainingDuration > 0.01) {
            // Vérifier si on est en fin de journée
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

/**
 * Ajoute des heures à une heure au format HH:MM
 */
function addHoursToTime(timeStr, hours) {
    const [h, m] = timeStr.split(':').map(Number);
    const totalMinutes = h * 60 + m + Math.round(hours * 60);
    const newH = Math.floor(totalMinutes / 60);
    const newM = totalMinutes % 60;
    return `${newH.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`;
}

/**
 * Crée une date à partir de semaine/jour/heure
 */
function getDateFromWeekDayTime(week, dayName, timeStr, year) {
    const date = getDateFromWeekDay(week, dayName, timeStr);
    // S'assurer que l'année est correcte
    if (year && date.getFullYear() !== year) {
        date.setFullYear(year);
    }
    return date;
}

/**
 * Affiche le récapitulatif (étape 2)
 */
function showPlanifierRecap(calculatedSlots, cmd) {
    const recapList = document.getElementById('planifierRecapList');
    const warningDiv = document.getElementById('planifierWarningLivraison');

    // Vérifier dépassement date livraison
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

    // Construire le récapitulatif
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

    // Passer à l'étape 2
    document.getElementById('planifierStep1').classList.remove('active');
    document.getElementById('planifierStep2').classList.add('active');
}

/**
 * Formate jour + date
 */
function formatDayDate(jour, semaine, year) {
    const dates = getWeekDates(semaine, year || anneeSelectionnee);
    const dayIndex = DAYS_OF_WEEK.indexOf(jour);
    const date = dates[dayIndex];
    if (date) {
        return `${jour} ${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
    }
    return jour;
}

/**
 * Formate une date en français
 */
function formatDateFr(date) {
    return date.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Confirme et applique le placement
 */
function confirmerPlacementSemiAuto() {
    const state = planifierSemiAutoState;

    if (!state.calculatedSlots || state.calculatedSlots.length === 0) {
        Toast.error('Aucun placement à confirmer');
        return;
    }

    const cmd = commandes.find(c => c.id === state.commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        return;
    }

    const cmdId = cmd.id;

    // Copier les slots calculés AVANT de fermer le modal (qui reset l'état)
    const slotsToApply = [...state.calculatedSlots];

    // Fermer le modal
    closePlanifierModal();

    // Appliquer les slots calculés
    slotsToApply.forEach(item => {
        const operation = cmd.operations[item.opIndex];
        if (operation) {
            if (!operation.slots) {
                operation.slots = [];
            }
            item.slots.forEach(slot => {
                // S'assurer que duree est un nombre valide
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
            // Mettre à jour le statut de l'opération
            operation.statut = "Planifiée";
        }
    });

    // Mettre à jour le statut de la commande
    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
    if (allPlaced) {
        cmd.statut = "Planifiée";
    } else {
        cmd.statut = "En cours";
    }

    // Sauvegarder l'état pour undo
    if (typeof historyManager !== 'undefined') {
        historyManager.saveState(`Planifier semi-auto ${cmdId}`);
    }

    // Sauvegarder et rafraîchir
    if (typeof syncManager !== 'undefined') {
        syncManager.saveLocalData();
    }
    refresh();
    Toast.success(`${cmdId} planifié avec succès`);
}

/**
 * Retour à l'étape 1
 */
function backToPlanifierStep1() {
    document.getElementById('planifierStep2').classList.remove('active');
    document.getElementById('planifierStep1').classList.add('active');
}

/**
 * Ferme le modal sans action
 */
function closePlanifierModal() {
    document.getElementById('modalPlanifierSemiAuto').classList.remove('active');

    // Réinitialiser l'état
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

/**
 * Initialise les event listeners du modal planifier
 */
function initPlanifierSemiAutoHandlers() {
    // Boutons fermer
    document.getElementById('btnClosePlanifier')?.addEventListener('click', closePlanifierModal);
    document.getElementById('btnClosePlanifierStep2')?.addEventListener('click', closePlanifierModal);
    document.getElementById('btnCancelPlanifier')?.addEventListener('click', closePlanifierModal);

    // Bouton calculer
    document.getElementById('btnCalculerPlacement')?.addEventListener('click', calculerPlacementSemiAuto);

    // Boutons étape 2
    document.getElementById('btnBackToStep1')?.addEventListener('click', backToPlanifierStep1);
    document.getElementById('btnConfirmerPlacement')?.addEventListener('click', confirmerPlacementSemiAuto);

    // Fermer en cliquant en dehors
    document.getElementById('modalPlanifierSemiAuto')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalPlanifierSemiAuto') {
            closePlanifierModal();
        }
    });
}

// Exposer les fonctions globalement pour le HTML
window.openPlanifierSemiAutoModal = openPlanifierSemiAutoModal;
window.updatePlanifierMachineSelection = updatePlanifierMachineSelection;
window.closePlanifierModal = closePlanifierModal;

// Initialiser les handlers au chargement
document.addEventListener('DOMContentLoaded', () => {
    initPlanifierSemiAutoHandlers();
});

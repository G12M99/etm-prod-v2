// ===================================
// ETM PROD V2 - Application Logic
// ===================================

// Configuration
const MACHINES = {
    cisailles: ['Cisaille A', 'Cisaille B'],
    poinconneuses: ['Poinçonneuse M', 'Poinçonneuse T'],
    plieuses: ['Plieuse Lo', 'Plieuse Mik', 'Plieuse Mok']
};

const ALL_MACHINES = [
    ...MACHINES.cisailles,
    ...MACHINES.poinconneuses,
    ...MACHINES.plieuses
];

const HOURS_PER_DAY = {
    'Lundi': 8.5,      // 07:30-12:30 (5h) + 13:00-16:30 (3.5h)
    'Mardi': 8.5,
    'Mercredi': 8.5,
    'Jeudi': 8.5,
    'Vendredi': 5      // 07:00-12:00
};

const DAYS_OF_WEEK = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
const TOTAL_HOURS_PER_WEEK = 39; // 8.5*4 + 5

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

// Lunch break configuration (Monday-Thursday only)
const LUNCH_BREAK = {
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
// CSV Parsing Functions
// ===================================

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
    console.warn('⚠️ CSV parsing disabled - Using Google Sheets only');
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
            order.operations.push({
                type: opConfig.type,
                dureeTotal: duration,
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

        const operation = {
            type: opType,
            dureeTotal: timeToDecimalHours(row[`Op ${i} Durée`]),
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
        if (typeof syncManager !== 'undefined') syncManager.saveLocalData(); // Persist
    }
    
    // Update UI (optional buttons?)
    updateUI() {
        // Could enable/disable undo/redo buttons if we had them
    }
}

const historyManager = new HistoryManager();

// ===================================
// Data Loading
// ===================================

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx-HR3xMw0d6S9MKZQBqKfOzQ4Ta5OVq3UjBwOiYEuP9cFLQfzOg4h0H5uwBnS98dA/exec';

/**
 * Fetch orders from Google Apps Script
 * Returns the data instead of setting global state directly
 */
async function fetchOrdersFromGoogleSheet() {
    if (GOOGLE_SCRIPT_URL === 'YOUR_GOOGLE_SCRIPT_URL_HERE') {
        console.warn('⚠️ Google Script URL not set.');
        throw new Error('URL not configured');
    }

    console.time('FetchGoogleSheet');
    console.log(`📡 Fetching data from Google Sheet at ${new Date().toLocaleTimeString()}...`);

    try {
        // Timeout de 20 secondes
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        
        // Add cache-busting timestamp to prevent caching old data
        const response = await fetch(`${GOOGLE_SCRIPT_URL}?t=${new Date().getTime()}`, {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        console.timeEnd('FetchGoogleSheet');
        
        // Read text first to debug if it's not JSON
        const responseText = await response.text();
        
        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.status} ${response.statusText}`);
        }

        // Check if response is HTML (error page) instead of JSON
        if (responseText.trim().startsWith('<')) {
            console.error('❌ Google Script returned HTML instead of JSON.');
            throw new Error('Invalid JSON response (HTML received)');
        }
        
        const jsonResponse = JSON.parse(responseText);
        
        // Handle different JSON structures (Array vs Object with data property)
        let data = [];
        if (Array.isArray(jsonResponse)) {
            data = jsonResponse;
        } else if (jsonResponse.data && Array.isArray(jsonResponse.data)) {
            data = jsonResponse.data;
        } else {
            console.error('❌ Unexpected JSON structure:', Object.keys(jsonResponse));
            throw new Error('JSON response does not contain an array of data');
        }

        console.log(`✅ Data fetched from Google Sheet: ${data.length} rows`);

        const fetchedOrders = data
            .map(row => mapGoogleSheetRowToOrder(row))
            .filter(cmd => {
                if (!cmd.statut) return false;
                
                // Normalisation plus stricte pour comparaison
                // Enlève les accents pour être sûr (prépa -> prepa)
                const status = cmd.statut.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
                
                // Filtre permissif : si le mot clé est DEDANS, on prend
                if (status.includes('cours')) return true;   // En cours, En-cours...
                if (status.includes('prepa')) return true;   // En prépa, Préparation...
                if (status.includes('planifi')) return true; // Planifiée, Planifié...
                
                return false;
            });

        console.log(`✅ Orders fetched (Live): ${fetchedOrders.length} active orders`);
        
        if (fetchedOrders.length === 0 && data.length > 0) {
            console.warn("⚠️ Attention : 0 commande chargée alors que le Sheet contient des données. Vérifiez les statuts.");
        }

        return fetchedOrders;

    } catch (error) {
        console.error('❌ Error fetching from Google Sheet:', error);
        throw error; // Re-throw for SyncManager
    }
}

/**
 * Load orders from local CSV (Legacy/Fallback) - DISABLED
 */
function loadLocalOrders() {
    console.log('⚠️ Local CSV fallback disabled - Using Google Sheets only');
    commandes = [];
}

/**
 * Main load function
 */
function loadOrders() {
    // Attempt to fetch from web first
    fetchOrdersFromGoogleSheet();
}

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
 * Find first available time gap in a day for an operation
 * Takes into account lunch break (12:30-13:00 Mon-Thu)
 * @param {string} minTimeStr - Optional minimum start time (HH:MM)
 * @returns {string|null} Start time (HH:MM) or null if no gap found
 */
/**
 * Helper: Calculate End Time accounting for Lunch Break (Mon-Thu 12:30-13:00)
 */
function calculateEndTimeWithLunch(startDec, duration, day) {
    if (day === 'Vendredi') return startDec + duration;

    const lunchStart = 12.5;
    const lunchEnd = 13.0;
    
    // If we start after lunch, no impact
    if (startDec >= lunchStart) {
        // But if we start strictly inside lunch (should be prevented by search logic, but for safety)
        if (startDec < lunchEnd) return lunchEnd + duration;
        return startDec + duration;
    }

    // We start before lunch. Check if we hit it.
    const tentativeEnd = startDec + duration;
    if (tentativeEnd > lunchStart) {
        // We span lunch. Add the break duration (0.5) to the end.
        return tentativeEnd + 0.5;
    }

    return tentativeEnd;
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

    // Add System Events (Maintenance or Factory Closures)
    systemEvents
        .filter(e => {
            if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== jour || e.week !== semaine) return false;

            // 🔒 CRITICAL: Filter by year to avoid showing events from different years
            const eventYear = getISOWeekYear(e.dateStr);
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

    const lunchStart = 12.5;
    const lunchEnd = 13.0;

    // 4. Iterate to find a slot
    // We treat machineSlots as obstacles. We jump over them.
    
    // Optimization: Merge contiguous machine slots to simplify jumping
    // (Optional but good for performance)

    while (currentSearch + durationNeeded <= dayEnd + 0.001) { // 0.001 epsilon
        
        // A. Handle Lunch Constraint for Start Time
        if (jour !== 'Vendredi') {
            // Cannot start INSIDE lunch
            if (currentSearch > lunchStart && currentSearch < lunchEnd) {
                currentSearch = lunchEnd;
            }
            // Check "Small Op" Rule: If < 30min and hits lunch, push to after lunch
            if (durationNeeded < 0.5 && currentSearch < lunchStart && (currentSearch + durationNeeded > lunchStart)) {
                currentSearch = lunchEnd;
            }
        }

        // B. Calculate Required End Time (including lunch span if needed)
        const requiredEnd = calculateEndTimeWithLunch(currentSearch, durationNeeded, jour);

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

    // Add System Events (Maintenance or Factory Closures)
    systemEvents
        .filter(e => {
            if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== jour || e.week !== semaine) return false;

            // 🔒 CRITICAL: Filter by year to avoid showing events from different years
            const eventYear = getISOWeekYear(e.dateStr);
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
// 🔒 ORDRE CHRONOLOGIQUE - RÈGLE CRITIQUE
// ===================================
// ORDRE CHRONOLOGIQUE OBLIGATOIRE: Cisaille → Poinçon → Pliage
// Les opérations peuvent être PLACÉES dans n'importe quel ordre
// MAIS dans le planning, Cisaille doit SE TERMINER avant Poinçonnage,
// et Poinçonnage doit SE TERMINER avant Pliage

/**
 * 🔒 RÈGLE CRITIQUE: Valide l'ordre strict des opérations
 * @param {Object} commande - La commande à valider
 * @returns {Object} { valid: boolean, message: string }
 */
function validateOperationOrder(commande) {
    const operations = commande.operations;

    // Define canonical order priority
    const priority = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };

    // Check if operations are sorted by priority
    for (let i = 0; i < operations.length - 1; i++) {
        const currentOp = operations[i];
        const nextOp = operations[i + 1];
        
        const currentP = priority[currentOp.type] || 0;
        const nextP = priority[nextOp.type] || 0;

        if (currentP >= nextP) {
             return {
                valid: false,
                message: `⛔ ORDRE DE PRODUCTION INVALIDE\n\nL'opération "${currentOp.type}" ne peut pas être après ou au même niveau que "${nextOp.type}".\n\nOrdre requis: Cisaillage → Poinçonnage → Pliage`
            };
        }
    }

    return { valid: true, message: '' };
}

/**
 * 🔒 RÈGLE CRITIQUE: Vérifie si une opération peut être placée à une date donnée
 * L'ordre CHRONOLOGIQUE doit être respecté: Cisaillage → Poinçonnage → Pliage
 * Mais on peut placer les opérations dans n'importe quel ordre (ex: placer Pliage avant Cisaillage)
 * @param {Object} commande - La commande
 * @param {Object} operation - L'opération à placer
 * @param {number} targetWeek - Semaine cible
 * @param {string} targetDay - Jour cible
 * @param {string} targetStartTime - Heure de début (optionnel, par défaut '09:00')
 * @returns {Object} { valid: boolean, message: string }
 */
function canPlaceOperation(commande, operation, targetWeek, targetDay, targetStartTime = '09:00', targetYear = anneeSelectionnee) {
    const operations = commande.operations;

    // Define canonical order priority
    const priority = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };

    // Create a sorted list of operations present in this command
    // This ensures we always check against the correct logical predecessor/successor
    const sortedOps = [...operations].sort((a, b) => {
        return (priority[a.type] || 99) - (priority[b.type] || 99);
    });

    const operationIndex = sortedOps.indexOf(operation);

    if (operationIndex === -1) {
        return { valid: false, message: 'Opération non trouvée dans la commande' };
    }

    // Calculer la date de début cible AVEC L'ANNÉE CIBLE
    const targetStartDate = getDateFromWeekDay(targetWeek, targetDay, targetStartTime, targetYear);

    // Calculer la date de fin approximative (on utilisera la durée de l'opération)
    const targetEndDate = new Date(targetStartDate);
    targetEndDate.setHours(targetEndDate.getHours() + operation.dureeTotal);

    // 🔒 RÈGLE 1: Si l'opération PRÉCÉDENTE est placée, elle doit SE TERMINER AVANT le début de celle-ci
    if (operationIndex > 0) {
        const previousOp = sortedOps[operationIndex - 1]; // Use sorted list

        if (previousOp.slots && previousOp.slots.length > 0) {
            // Trouver la date de fin de la dernière slot de l'opération précédente
            // We need the absolute latest end time across all slots
            const previousLastSlot = [...previousOp.slots].sort((a,b) => {
                 if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                 const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
                 if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                 return a.heureFin.localeCompare(b.heureFin);
            }).pop();
            
            const previousEndDate = new Date(previousLastSlot.dateFin || getDateFromWeekDay(previousLastSlot.semaine, previousLastSlot.jour, previousLastSlot.heureFin));


            // Comparaison stricte: début actuel doit être >= fin précédente
            if (targetStartDate < previousEndDate) {
                // Calculer l'écart de temps
                const timeDiff = Math.round((previousEndDate - targetStartDate) / (1000 * 60)); // en minutes

                // Calculer l'heure suggérée (arrondie à l'heure supérieure complète)
                const endHourFloat = parseInt(previousLastSlot.heureFin.split(':')[0]) + parseInt(previousLastSlot.heureFin.split(':')[1]) / 60;
                const suggestedHour = Math.ceil(endHourFloat);
                const suggestedTime = `${suggestedHour.toString().padStart(2, '0')}:00`;

                return {
                    valid: false,
                    message: `⛔ ORDRE CHRONOLOGIQUE INVALIDE\n\n"${operation.type}" ne peut pas commencer AVANT la fin de "${previousOp.type}"\n\n📅 ${previousOp.type} se termine:\n   → S${previousLastSlot.semaine} ${previousLastSlot.jour} à ${previousLastSlot.heureFin}\n\n📅 ${operation.type} commence:\n   → S${targetWeek} ${targetDay} à ${targetStartTime}\n\n⏰ Conflit: ${timeDiff} minutes de chevauchement\n\n💡 Solution: Placez "${operation.type}" à partir de ${suggestedTime} (heure complète suivante)\n\n❌ Respectez l'ordre chronologique dans le planning!`
                };
            }
        }
    }

    // 🔒 RÈGLE 2: Si l'opération SUIVANTE est placée, celle-ci doit SE TERMINER AVANT son début
    if (operationIndex < sortedOps.length - 1) {
        const nextOp = sortedOps[operationIndex + 1]; // Use sorted list

        if (nextOp.slots && nextOp.slots.length > 0) {
            // Trouver la date de début de la première slot de l'opération suivante
            // We need the absolute earliest start time
            const nextFirstSlot = [...nextOp.slots].sort((a,b) => {
                 if (a.semaine !== b.semaine) return a.semaine - b.semaine;
                 const days = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
                 if (a.jour !== b.jour) return days.indexOf(a.jour) - days.indexOf(b.jour);
                 return a.heureDebut.localeCompare(b.heureDebut);
            })[0];
            
            const nextStartDate = new Date(nextFirstSlot.dateDebut || getDateFromWeekDay(nextFirstSlot.semaine, nextFirstSlot.jour, nextFirstSlot.heureDebut));

            // Comparaison stricte: fin actuelle doit être <= début suivante
            if (targetEndDate > nextStartDate) {
                // Calculer l'heure de fin estimée
                const endHour = parseInt(targetStartTime.split(':')[0]) + Math.floor(operation.dureeTotal);
                const endMinute = Math.round((operation.dureeTotal % 1) * 60);
                const estimatedEndTime = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;

                // Calculer l'écart de temps
                const timeDiff = Math.round((targetEndDate - nextStartDate) / (1000 * 60)); // en minutes

                // Calculer l'heure de début maximale (en arrondissant vers le bas)
                // Il faut que cette opération se termine avant nextStart
                const nextStartHour = parseInt(nextFirstSlot.heureDebut.split(':')[0]) + parseInt(nextFirstSlot.heureDebut.split(':')[1]) / 60;
                const maxStartHour = Math.floor(nextStartHour - operation.dureeTotal);
                const minWorkHour = nextFirstSlot.jour === 'Vendredi' ? 7 : 7.5;
                const suggestedMaxTime = maxStartHour >= minWorkHour ? `${maxStartHour.toString().padStart(2, '0')}:00` : 'impossible ce jour';

                return {
                    valid: false,
                    message: `⛔ ORDRE CHRONOLOGIQUE INVALIDE\n\n"${operation.type}" doit SE TERMINER AVANT le début de "${nextOp.type}"\n\n📅 ${operation.type} se termine:\n   → S${targetWeek} ${targetDay} à ${estimatedEndTime} (estimé)\n\n📅 ${nextOp.type} commence:\n   → S${nextFirstSlot.semaine} ${nextFirstSlot.jour} à ${nextFirstSlot.heureDebut}\n\n⏰ Conflit: ${timeDiff} minutes de chevauchement\n\n💡 Solution: Placez "${operation.type}" au plus tard à ${suggestedMaxTime}\n\n❌ Respectez l'ordre chronologique dans le planning!`
                };
            }
        }
    }

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

    // Rows for each machine
    ALL_MACHINES.forEach(machine => {
        html += '<div class="semaine-row">';

        // Machine name + average capacity across displayed weeks
        let totalHours = 0;
        weeksToDisplay.forEach(item => {
            const capacity = calculerCapaciteMachine(machine, item.week, item.year);
            totalHours += capacity.heuresUtilisees;
        });
        const avgHours = Math.round(totalHours / 3 * 10) / 10;
        const avgPct = Math.round((avgHours / TOTAL_HOURS_PER_WEEK) * 100);
        const capacityClass = getCapacityColorClass(avgPct);

        html += `
            <div class="machine-cell">
                <div class="machine-name">${machine}</div>
                <div class="capacity-gauge">
                    <div class="capacity-bar">
                        <div class="capacity-fill ${capacityClass}" style="width: ${Math.min(100, avgPct)}%"></div>
                    </div>
                    <div class="capacity-label">${avgHours}h/37h (${avgPct}%)</div>
                </div>
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
            
            html += `<div class="week-cell ${weekSeparatorClass}" data-machine="${machine}" data-week="${item.week}" data-year="${item.year}">`;

            commandsInWeek.forEach(cmd => {
                html += `
                    <span class="command-badge">
                        <span class="badge-id">${cmd.id.substring(5)}</span>
                        <span class="badge-client">${cmd.client}</span>
                    </span>
                `;
            });

            // Display System Events (Maintenance/Closure)
            const weekEvents = systemEvents.filter(e => {
                if ((e.machine !== machine && e.machine !== 'ALL') || e.week !== item.week) return false;

                // 🔒 CRITICAL: Filter by year to avoid showing events from different years
                const eventYear = getISOWeekYear(e.dateStr);
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
            const week = parseInt(e.currentTarget.getAttribute('data-week'));
            const year = parseInt(e.currentTarget.getAttribute('data-year'));
            
            // Update both week and year global state
            semaineSelectionnee = week;
            anneeSelectionnee = year;
            
            toggleVue('journee');
        });
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
                Retour Vue Semaine
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
            const timeRange = day === 'Vendredi' ? '07h-12h' : '07h30-16h30';

            // Calculer la date pour ce jour
            const dateObj = getDateFromWeekDay(semaineSelectionnee, day, "00:00", anneeSelectionnee);
            const dayNum = dateObj.getDate().toString().padStart(2, '0');
            const monthNum = (dateObj.getMonth() + 1).toString().padStart(2, '0');
            const formattedDate = `${dayNum}/${monthNum}`;

            headersHtml += `
                <div class="day-header-cell day-col ${day === 'Vendredi' ? 'friday' : ''}">
                    <div class="day-name">${day} <span style="font-weight: normal; opacity: 0.8; font-size: 0.9em;">${formattedDate}</span></div>
                    <div class="day-capacity">${timeRange} (${capacity}h)</div>
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

            // Timeline hours: Fri 07:00-12:00, Mon-Thu 07:30-16:30
            const startHourTimeline = day === 'Vendredi' ? 7 : 7.5;
            const endHourTimeline = day === 'Vendredi' ? 12 : 16.5;

            html += `
                <div class="day-cell ${day === 'Vendredi' ? 'friday' : ''}"
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
                            <span>${isOverCapacity ? '🔥 HEURES SUP' : ''}</span>
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
            
            // Generate time slots based on day
            if (day === 'Vendredi') {
                // Friday: 07:00-12:00 + Overtime up to 14:00
                // Render up to 14:00 to show overtime slots if any
                for (let hour = 7; hour < 14; hour++) {
                    const timeSlot = `${hour.toString().padStart(2, '0')}:00`;
                    html += `
                        <div class="time-slot drop-zone"
                             data-machine="${machine}"
                             data-day="${day}"
                             data-week="${semaineSelectionnee}"
                             data-hour="${hour}"
                             data-time="${timeSlot}">
                            <div class="time-label">${timeSlot}</div>
                        </div>
                    `;
                }
            } else {
                // Mon-Thu: 07:30-16:30 + Overtime up to 18:00
                // Render up to 18:00
                for (let i = 0; i < 11; i++) { // 7.5 to 17.5 (18:00 end)
                    const hourDecimal = 7.5 + i; 
                    const hour = Math.floor(hourDecimal);
                    const minute = (hourDecimal % 1 === 0.5) ? '30' : '00';
                    const timeSlot = `${hour.toString().padStart(2, '0')}:${minute}`;
                    html += `
                        <div class="time-slot drop-zone"
                             data-machine="${machine}"
                             data-day="${day}"
                             data-week="${semaineSelectionnee}"
                             data-hour="${hourDecimal}"
                             data-time="${timeSlot}">
                            <div class="time-label">${timeSlot}</div>
                        </div>
                    `;
                }
            }
            html += '</div>';

            // Overlay operations with absolute positioning
            html += '<div class="operations-overlay">';

            // 0. Add System Events (Maintenance / Closure)
            systemEvents
                .filter(e => {
                    if ((e.machine !== machine && e.machine !== 'ALL') || e.day !== day || e.week !== semaineSelectionnee) return false;

                    // 🔒 CRITICAL: Filter by year to avoid showing events from different years
                    const eventYear = getISOWeekYear(e.dateStr);
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

            // 1. Add lunch break visual
            if (day !== 'Vendredi') {
                const lunchStartDecimal = 12.5; 
                const lunchEndDecimal = 13.0;   
                const topLunch = (lunchStartDecimal - startHourTimeline) * 60;
                const heightLunch = (lunchEndDecimal - lunchStartDecimal) * 60;
                html += `<div class="lunch-break" style="top: ${topLunch}px; height: ${heightLunch}px;"></div>`;
            }

            // 2. Add Overtime Separator
            // Mon-Thu: 16:30 (16.5), Fri: 12:00 (12.0)
            const separatorTime = day === 'Vendredi' ? 12 : 16.5;
            const separatorTop = (separatorTime - startHourTimeline) * 60;
            html += `<div class="overtime-separator" style="top: ${separatorTop}px;"></div>`;

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

                const lunchStart = 12.5;
                const lunchEnd = 13.0;
                const crossesLunch = day !== 'Vendredi' && startDecimal < lunchStart && endDecimal > lunchEnd;

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
                            
                            <div class="slot-time">${slot.heureDebut}-${slot.heureFin}</div>
                            <div class="slot-label">[${slot.commandeId.substring(5)}]</div>
                            <div class="slot-client">${slot.client}</div>
                            <div class="slot-type">${slot.operationType}</div>
                        </div>
                    `;
                };

                if (crossesLunch) {
                    // Render Part 1: Start -> 12:30
                    html += renderSlotDiv(startDecimal, lunchStart, true);
                    // Render Part 2: 13:00 -> End
                    html += renderSlotDiv(lunchEnd, endDecimal, true);
                } else {
                    // Render Normal
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

/**
 * Render unplaced orders
 * @param {string} searchQuery - Optional search query to filter commands
 */
function renderCommandesNonPlacees(searchQuery = '') {
    const container = document.getElementById('unplacedOrdersContainer');
    const unplacedOrders = getUnplacedOrders();

    // Sort by dateLivraison (urgent first)
    unplacedOrders.sort((a, b) => {
        const dateA = a.dateLivraison ? new Date(a.dateLivraison) : new Date(8640000000000000); // Max Date
        const dateB = b.dateLivraison ? new Date(b.dateLivraison) : new Date(8640000000000000);
        
        if (isNaN(dateA.getTime())) return 1; // A is invalid -> push to bottom
        if (isNaN(dateB.getTime())) return -1; // B is invalid -> push A to top
        
        return dateA - dateB;
    });

    // Apply search filter if query exists
    let filteredOrders = unplacedOrders;
    if (searchQuery && searchQuery.trim() !== '') {
        filteredOrders = filterCommandesBySearch(unplacedOrders, searchQuery);
        updateSearchResultCount(filteredOrders.length, unplacedOrders.length);
    }

    if (unplacedOrders.length === 0) {
        container.innerHTML = '<p class="no-orders">Aucune commande à placer</p>';
        return;
    }

    // Check if search returned no results
    if (searchQuery && searchQuery.trim() !== '' && filteredOrders.length === 0) {
        container.innerHTML = `
            <div class="no-search-results">
                <svg viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                    <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>Aucun résultat pour <span class="search-term">"${escapeHtml(searchQuery)}"</span></p>
                <p style="margin-top: 8px; font-size: 12px;">Essayez un autre terme de recherche</p>
            </div>
        `;
        return;
    }

    let html = '';
    let cardsRendered = 0;

    filteredOrders.forEach(cmd => {
        const urgencyLevel = getUrgencyLevel(cmd.dateLivraison);
        const livraison = new Date(cmd.dateLivraison);
        const daysUntil = Math.ceil((livraison - currentTime) / (1000 * 60 * 60 * 24));

        // Build operations HTML for UNPLACED operations only
        let operationsHtml = '';
        let hasUnplacedOps = false;

        cmd.operations.forEach(op => {
            // Only show operations that are NOT placed
            if (!op.slots || op.slots.length === 0) {
                hasUnplacedOps = true;
                const typeClass = op.type.toLowerCase().replace('ç', 'c').replace('é', 'e');
                operationsHtml += `
                    <div class="operation-item-sidebar ${typeClass} draggable-from-sidebar"
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
                            <div class="op-duration">${formatHours(op.dureeTotal)}</div>
                        </div>
                    </div>
                `;
            }
        });

        // Skip card if no unplaced operations (Issue #4 fix)
        if (!hasUnplacedOps || operationsHtml === '') {
            return;
        }

        html += `
            <div class="commande-non-placee ${urgencyLevel}">
                <div class="commande-header">
                    <span class="commande-id">${cmd.id}</span>
                    <span class="commande-client">${cmd.client}</span>
                </div>
                <div class="commande-details">
                    <div class="detail-item">
                        <strong>Poids:</strong> ${cmd.poids}kg ${cmd.materiau}
                    </div>
                    <div class="detail-item">
                        <strong>Livraison:</strong> ${formatDate(cmd.dateLivraison)} (${daysUntil} jours)
                        ${urgencyLevel === 'urgente' ? ' ❌ URGENT' : urgencyLevel === 'attention' ? ' ⚠️' : ' ✓'}
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
                    <button class="btn btn-sm btn-secondary" onclick="showCommandeDetails('${cmd.id}')">
                        Détails
                    </button>
                </div>
            </div>
        `;
        cardsRendered++;
    });

    // Show message if no cards to display
    if (cardsRendered === 0) {
        container.innerHTML = '<p class="no-orders">Aucune opération à placer</p>';
    } else {
        container.innerHTML = html;

        // Initialize drag for sidebar operations
        document.querySelectorAll('.draggable-from-sidebar').forEach(op => {
            op.addEventListener('dragstart', handleSidebarDragStart);
            op.addEventListener('dragend', handleDragEnd);
        });
    }
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
 */
function replanifierOperationsSuivantes(cmd, modifiedOp) {
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
            console.log(`🔄 Cascade: Décalage nécessaire pour ${currentType} (Conflit avec ${previousOp.type})`);
            
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
}

/**
 * Handle drop on sidebar (Unplan operation)
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

    if (!confirm(`Retirer ${operation.type} de la commande ${cmd.id} du planning ?\nCela retirera également les opérations suivantes (ordre chronologique).`)) {
        return;
    }

    // UNPLAN LOGIC: Remove this op AND all subsequent ops
    // Order: Cisaillage -> Poinçonnage -> Pliage
    const priority = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
    const currentPriority = priority[operation.type] || 99;

    let removedCount = 0;

    cmd.operations.forEach(op => {
        const opPriority = priority[op.type] || 99;
        
        // If this operation is the one dragged OR comes AFTER it in sequence
        if (opPriority >= currentPriority) {
            if (op.slots && op.slots.length > 0) {
                op.slots = [];
                op.statut = "Non placée";
                op.progressionReelle = 0;
                removedCount++;
            }
        }
    });

    // Update main command status
    const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
    const anyPlaced = cmd.operations.some(op => op.slots && op.slots.length > 0);
    
    if (allPlaced) cmd.statut = "Planifiée";
    else if (anyPlaced) cmd.statut = "En cours"; // Partially placed
    else cmd.statut = "Non placée";

    historyManager.saveState(`Unplan ${cmd.id} (${removedCount} ops)`);
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

    // Check working hours
    const dayStart = day === 'Vendredi' ? 7 : 7.5;
    const dayEnd = day === 'Vendredi' ? 12 : 16.5;

    if (start < dayStart - EPSILON) {
        return { valid: false, reason: `L'horaire de début (${startTime}) est avant l'ouverture (${formatDecimalTime(dayStart)}).` };
    }
    if (end > dayEnd + EPSILON) {
        return { valid: false, reason: `L'opération se termine à ${formatDecimalTime(end)}, ce qui dépasse la fermeture (${formatDecimalTime(dayEnd)}).` };
    }

    // Check lunch break
    if (day !== 'Vendredi') {
        const lunchStart = 12.5; // 12:30
        const lunchEnd = 13.0;   // 13:00
        
        // If operation is FULLY inside lunch, that's invalid
        if (start >= lunchStart && end <= lunchEnd) {
             return { valid: false, reason: `L'opération ne peut pas être placée entièrement pendant la pause déjeuner.` };
        }
        
        // We now ALLOW spanning across lunch (e.g. 11:00 to 14:00)
        // The duration check logic in handleDrop will adjust end time.
        // But here we must check if the *machine* is physically available during the WORK time parts.
        // Actually, existing slots might also span lunch. 
        // If I put 11:00-14:30 (3h work), the slot in DB says 11:00-14:30.
        // My isMachineAvailable check compares 11:00-14:30 against existing slots.
        // Overlap logic still holds.
        // The only "forbidden" time is starting/ending *inside* the break? 
        // Let's say we allow it for now, handleDrop fixes the timing.
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

function handleDrop(e) {
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

    const priorityMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
    const sortedOps = [...cmd.operations].sort((a,b) => (priorityMap[a.type]||9) - (priorityMap[b.type]||9));
    const currentOpIdx = sortedOps.indexOf(operation);

    // Check Predecessor
    for (let i = currentOpIdx - 1; i >= 0; i--) {
        const prev = sortedOps[i];
        if (prev.slots && prev.slots.length > 0) {
            const lastSlot = [...prev.slots].sort((a,b) => a.dateFin.localeCompare(b.dateFin)).pop();
            const prevEndDate = new Date(lastSlot.dateFin);
            
            if (prevEndDate.getTime() > targetDateEnd.getTime() - 60000) {
                restoreAndAlert(`⛔ IMPOSSIBLE : L'opération précédente (${prev.type}) termine après ce jour.`);
                return;
            }
            if (prevEndDate.getTime() > targetDateStart.getTime()) {
                chronologyMinDecimal = prevEndDate.getHours() + prevEndDate.getMinutes()/60;
            }
            break; 
        }
    }

    // Check Successor
    let successorMaxDecimal = 24;
    for (let i = currentOpIdx + 1; i < sortedOps.length; i++) {
        const next = sortedOps[i];
        if (next.slots && next.slots.length > 0) {
            const firstSlot = [...next.slots].sort((a,b) => a.dateDebut.localeCompare(b.dateDebut))[0];
            const nextStartDate = new Date(firstSlot.dateDebut);
            if (nextStartDate.getTime() < targetDateStart.getTime()) {
                restoreAndAlert(`⛔ IMPOSSIBLE : L'opération suivante (${next.type}) commence avant ce jour.`);
                return;
            }
            if (nextStartDate.getTime() < targetDateEnd.getTime()) {
                successorMaxDecimal = nextStartDate.getHours() + nextStartDate.getMinutes()/60;
            }
            break;
        }
    }

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

        // Successor check on the final calculated end time
        if (endDec > successorMaxDecimal + 0.001) {
             operation.slots = slotsBackup;
             restoreAndAlert(`⛔ IMPOSSIBLE : L'opération se terminerait après le début de l'opération suivante (${formatDecimalTime(successorMaxDecimal)}).`);
             return;
        }

        // Apply new slot
        operation.slots = [{
            machine: targetMachine,
            duree: operation.dureeTotal,
            semaine: searchWeek,
            jour: searchDay,
            heureDebut: gapStart,
            heureFin: formatDecimalTime(endDec),
            dateDebut: getDateFromWeekDay(searchWeek, searchDay, gapStart, searchYear).toISOString(),
            dateFin: getDateFromWeekDay(searchWeek, searchDay, formatDecimalTime(endDec), searchYear).toISOString(),
            overtime: startDec >= (searchDay === 'Vendredi' ? 12 : 16.5)
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
        saveData();
        Toast.success(`Opération déplacée et regroupée à ${gapStart}`);
    } else {
        operation.slots = slotsBackup;
        restoreAndAlert(`Impossible de déplacer l'opération : pas de créneau contigu de ${formatHours(operation.dureeTotal)} trouvé.`);
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
 */
function placerAutomatiquement(commandeId) {
    const cmd = commandes.find(c => c.id === commandeId);
    if (!cmd) return;

    // 🔒 VALIDATION CRITIQUE: Vérifier que la commande a les 3 opérations dans le bon ordre
    const orderValidation = validateOperationOrder(cmd);
    if (!orderValidation.valid) {
        alert('⛔ ORDRE DE PRODUCTION INVALIDE\n\n' + orderValidation.message);
        return;
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

        // Loop to place chunks until full duration is scheduled
        while (remainingDuration > 0.01) { // 0.01 tolerance for float math

            // 🎯 Find best slot for remaining duration (or largest available chunk)
            // Pass globalMinStart to constrain search
            let machineList = availableMachines;
            let searchConstraint = globalMinStart;

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
                console.log(`🎯 Machine assignée pour ${operation.type}: ${assignedMachine}`);
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
                        const remainingAfterOvertime = remainingDuration - placedDuration - overtimeNeeded;
                        const overtimeMessage = `⏰ HEURES SUPPLÉMENTAIRES NÉCESSAIRES\n\n` +
                            `Opération: ${operation.type}\n` +
                            `Machine: ${assignedMachine}\n` +
                            `Jour: ${bestSlot.day}\n\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                            `✅ Temps placé aujourd'hui: ${formatHours(placedDuration)}\n` +
                            `⏰ Heures sup proposées: ${formatHours(overtimeNeeded)}\n` +
                            (remainingAfterOvertime > 0.01 ? `📅 Suite demain: ${formatHours(remainingAfterOvertime)}\n` : `✓ Opération terminée après heures sup\n`) +
                            `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                            `➡️ Cliquez OK pour ACCEPTER les heures supplémentaires\n` +
                            `➡️ Cliquez ANNULER pour REFUSER (suite demain)`;

                        if (confirm(overtimeMessage)) {
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
            ${cmd.operations.map(op => `
                <div class="operation-item ${op.type.toLowerCase().replace('ç', 'c').replace('é', 'e')}">
                    <div class="operation-item-header">${op.type} - ${formatHours(op.dureeTotal)}</div>
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
                </div>
            `).join('')}
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

    // Méthode 1: Initialisation
    async init() {
        // 1. Charger données locales (localStorage) IMMÉDIATEMENT
        this.loadLocalData();
        
        // 2. Tenter sync Google Sheets en arrière-plan (SANS AWAIT pour ne pas bloquer l'UI)
        this.syncWithGoogleSheets();
        
        // 3. Démarrer auto-sync périodique (toutes les 5 minutes)
        this.startAutoSync();
    }

    // Méthode 2: Chargement local
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
                console.log('ℹ️ No local data found. Waiting for Google Sheets sync...');
                commandes = []; // FIX: Juste un tableau vide
                this.updateSyncIndicator('syncing', 'En attente de sync...');
            }
        } catch (e) {
            console.error('❌ Error loading local data:', e);
            commandes = []; // FIX: Tableau vide au lieu de loadLocalOrders()
            this.updateSyncIndicator('error', 'Erreur chargement local');
        }
    }

    cleanupPastSystemEvents() {
        const now = new Date();
        const currentWeek = getWeekNumber(now);
        
        systemEvents = systemEvents.filter(event => {
            let evtW = event.week;
            const curW = currentWeek;

            // Handle year wrap-around (e.g. Current 50, Event 2 -> Future)
            if (curW > 40 && evtW < 10) {
                evtW += 52; 
            }
            // Handle reverse wrap-around (e.g. Current 2, Event 50 -> Past)
            else if (curW < 10 && evtW > 40) {
                 evtW -= 52; 
            }

            // Keep events from previous week (-1 buffer) and all future
            if (evtW >= curW - 1) return true;
            return false;
        });
    }

    // Méthode 3: Sync avec Google Sheets
    async syncWithGoogleSheets() {
        this.updateSyncIndicator('syncing', 'Synchronisation...');
        
        try {
            const remoteData = await fetchOrdersFromGoogleSheet();
            
            if (remoteData && remoteData.length > 0) {
                // Merge logic
                this.mergeData(commandes, remoteData);
                
                this.saveLocalData();
                this.updateSyncIndicator('synced', 'Synchronisé');
                this.lastSyncTime = new Date();
                refresh();
                Toast.success('Données synchronisées avec succès');
            } else {
                throw new Error('No data received');
            }
        } catch (error) {
            console.error('Sync failed:', error);
            this.updateSyncIndicator('error', 'Erreur Sync (Mode Hors ligne)');
            Toast.warning('Synchronisation échouée. Mode hors ligne activé.');
        }
    }

    // Méthode 5: Merge intelligent
    mergeData(localData, remoteData) {
        // Stratégie:
        // - Remote est maître pour la liste des commandes et leurs détails (poids, délais)
        // - Local est maître pour le PLANNING (slots) car le Sheet V1 ne les a pas
        
        const localMap = new Map(localData.map(c => [c.id, c]));
        let updatedCount = 0;
        let newCount = 0;
        
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

                // La commande existe déjà en local -> On préserve le planning (slots)
                remoteCmd.operations.forEach(remoteOp => {
                    const localOp = localCmd.operations.find(op => op.type === remoteOp.type);
                    if (localOp && localOp.slots && localOp.slots.length > 0) {
                        // On garde les slots locaux
                        remoteOp.slots = localOp.slots;
                        remoteOp.statut = localOp.statut;
                        remoteOp.progressionReelle = localOp.progressionReelle;
                    }
                });
                
                // Si la commande était "Planifiée" localement, on garde ce statut global
                // sauf si le remote dit "Livrée" ou "Terminée" (force override)
                if (localCmd.statut === 'Planifiée' && remoteCmd.statut !== 'Livrée' && remoteCmd.statut !== 'Terminée') {
                    remoteCmd.statut = 'Planifiée';
                }
            } else {
                newCount++;
            }
            return remoteCmd;
        });
        
        commandes = merged;
        console.log(`✅ Merge: ${newCount} nouvelles, ${updatedCount} mises à jour.`);
        
        if (newCount > 0 || updatedCount > 0) {
            Toast.success(`Sync: ${newCount} nouvelles, ${updatedCount} mises à jour.`);
        } else {
            Toast.info('Sync: Aucune modification de données détectée.');
        }
    }

    // Méthode 6: Sauvegarde locale
    saveLocalData() {
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
    }

    // Méthode 7: Auto-sync périodique
    startAutoSync() {
        if (this.syncInterval) clearInterval(this.syncInterval);
        this.syncInterval = setInterval(() => {
            this.syncWithGoogleSheets();
        }, 5 * 60 * 1000); // 5 minutes
    }

    // Méthode 8: Sync manuelle
    manualSync() {
        Toast.info('Synchronisation en cours...');
        this.syncWithGoogleSheets();
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
    
    // Toggle dropdown menu
    document.getElementById('btnDataMenu')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelector('.dropdown')?.classList.toggle('active');
    });
    
    // Fermer dropdown si clic ailleurs
    document.addEventListener('click', () => {
        document.querySelector('.dropdown.active')?.classList.remove('active');
    });
}

// ===================================
// ⚙️ SYSTEM EVENTS (MAINTENANCE & CLOSURES)
// ===================================

function saveSystemEvents() {
    localStorage.setItem('etm_system_events', JSON.stringify(systemEvents));
}

function loadSystemEvents() {
    const stored = localStorage.getItem('etm_system_events');
    if (stored) {
        systemEvents = JSON.parse(stored);
        // Optional: Cleanup old events logic can be re-added here if needed
        // For now, we keep everything to ensure persistence is visible
    }
}

function toggleMachineSelect() {
    const type = document.getElementById('sysEventType').value;
    const group = document.getElementById('sysMachineGroup');
    group.style.display = (type === 'fermeture') ? 'none' : 'block';
}

// Make globally accessible for the onchange in HTML
window.toggleMachineSelect = toggleMachineSelect;

function openSystemEventsModal() {
    const modal = document.getElementById('modalSystemEvents');
    const machineSelect = document.getElementById('sysMachine');
    
    // Populate machines
    machineSelect.innerHTML = ALL_MACHINES.map(m => `<option value="${m}">${m}</option>`).join('');
    
    // Set default dates to Today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('sysDateStart').value = today;
    document.getElementById('sysDateEnd').value = today;
    
    renderSystemEventsList();
    modal.classList.add('active');
}

function addSystemEvent() {
    const type = document.getElementById('sysEventType').value;
    const machine = (type === 'fermeture') ? 'ALL' : document.getElementById('sysMachine').value;
    const sDateVal = document.getElementById('sysDateStart').value;
    const eDateVal = document.getElementById('sysDateEnd').value;
    const startTime = document.getElementById('sysStart').value;
    const endTime = document.getElementById('sysEnd').value;
    const reason = document.getElementById('sysReason').value || (type === 'maintenance' ? 'Maintenance' : 'Fermeture');

    if (!sDateVal || !eDateVal || !startTime || !endTime) {
        alert("Veuillez saisir les dates et les horaires.");
        return;
    }

    const startDec = timeToDecimalHours(startTime);
    const endDec = timeToDecimalHours(endTime);

    if (endDec <= startDec) {
        alert("L'heure de fin doit être après l'heure de début.");
        return;
    }

    const startDate = new Date(sDateVal);
    const endDate = new Date(eDateVal);

    if (startDate > endDate) {
        alert("La date de fin doit être après la date de début.");
        return;
    }

    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    let addedCount = 0;
    let totalDisplaced = 0;
    
    // Loop through dates
    let current = new Date(startDate);
    while (current <= endDate) {
        const dayIdx = current.getDay();
        const dayName = dayNames[dayIdx];
        
        // Skip Weekends (Samedi=6, Dimanche=0) to avoid invisible events
        if (dayIdx !== 0 && dayIdx !== 6) {
            const weekNum = getWeekNumber(current);
            const dateStr = current.toISOString().split('T')[0]; // Store YYYY-MM-DD
            
            // Smart Schedule Adjustment for Friday
            let thisStart = startTime;
            let thisEnd = endTime;

            if (dayName === 'Vendredi') {
                if (startTime === '07:30') thisStart = '07:00';
                if (endTime === '16:30') thisEnd = '12:00';
            }

            const newEvent = {
                id: 'SYS-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                type,
                machine,
                week: weekNum,
                year: getISOWeekYear(current),
                day: dayName,
                dateStr: dateStr,
                startTime: thisStart,
                endTime: thisEnd,
                reason
            };
            
            // Check and resolve conflicts immediately
            const displaced = resolveSystemEventConflicts(newEvent);
            if (displaced > 0) totalDisplaced += displaced;

            systemEvents.push(newEvent);
            addedCount++;
        }
        
        // Next day
        current.setDate(current.getDate() + 1);
    }

    if (addedCount === 0) {
        alert("Aucun jour ouvrable (Lundi-Vendredi) dans la période sélectionnée.");
        return;
    }

    saveSystemEvents();
    
    renderSystemEventsList();
    refresh();
    
    if (totalDisplaced > 0) {
        alert(`⚠️ ${totalDisplaced} opération(s) ont été déplacées vers "Commandes à placer" suite à ce blocage.`);
    } else {
        Toast.success(`${addedCount} jour(s) bloqué(s)`);
    }
    
    // Reset reason
    document.getElementById('sysReason').value = '';
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

function deleteSystemEvent(id) {
    systemEvents = systemEvents.filter(e => e.id !== id);
    saveSystemEvents(); // Use standalone save
    renderSystemEventsList();
    refresh();
    Toast.info("Blocage supprimé");
}

function renderSystemEventsList() {
    const container = document.getElementById('systemEventsList');
    
    if (systemEvents.length === 0) {
        container.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:#999;">Aucun blocage actif</td></tr>';
        return;
    }

    // Sort by week, day, time
    const daysOrder = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
    const sorted = [...systemEvents].sort((a,b) => {
        if (a.week !== b.week) return a.week - b.week;
        if (a.day !== b.day) return daysOrder.indexOf(a.day) - daysOrder.indexOf(b.day);
        return a.startTime.localeCompare(b.startTime);
    });

    container.innerHTML = sorted.map(e => `
        <tr style="border-bottom: 1px solid #eee;">
            <td style="padding:10px;">
                <span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.85em; background:${e.type === 'fermeture' ? '#f8d7da' : '#fff3cd'}; color:${e.type === 'fermeture' ? '#721c24' : '#856404'};">
                    ${e.type === 'fermeture' ? 'Fermeture' : 'Maintenance'}
                </span>
            </td>
            <td style="padding:10px; font-weight:500;">${e.machine === 'ALL' ? 'Toutes les machines' : e.machine}</td>
            <td style="padding:10px;">
                ${e.dateStr ? `<span style="font-weight:bold">${new Date(e.dateStr).toLocaleDateString('fr-FR', {day: '2-digit', month: '2-digit'})}</span>` : ''} 
                S${e.week} ${e.day} <br><small>${e.startTime} - ${e.endTime}</small>
            </td>
            <td style="padding:10px; color:#666;">${e.reason}</td>
            <td style="padding:10px; text-align:right;">
                <button class="btn btn-sm btn-danger" onclick="deleteSystemEvent('${e.id}')">Supprimer</button>
            </td>
        </tr>
    `).join('');
}

// Global exposure for onclick
window.deleteSystemEvent = deleteSystemEvent;

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
        op.slots = [];
        op.statut = "Non placée";
        op.progressionReelle = 0;
    });

    // Update main status based on what logic expects (usually 'Non placée' or 'En prépa')
    // Safe default:
    cmd.statut = "Non placée";

    historyManager.saveState(`Retrait ${commandeId}`);
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
}

/**
 * Refresh all views (Modified for Auto-Save)
 */
function refresh() {
    // Sauvegarder automatiquement à chaque changement majeur (re-render)
    if (typeof syncManager !== 'undefined') {
        syncManager.saveLocalData();
    }

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

const SCHEDULE_CONFIG = {
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
    CR_THRESHOLD: 1.05,       // Critical Ratio minimum après déplacement
    CR_FORCE_THRESHOLD: 0.95, // En mode FORCE, on accepte jusqu'à 0.95
    MAX_DISPLACEMENTS_NORMAL: 5,
    MAX_DISPLACEMENTS_FORCE: 20,
    // Fragmentation supprimée : les opérations ne se splitent QUE si pause/multi-jours
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

        // Ajouter les systemEvents
        systemEvents
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

        // La pause déjeuner n'est PLUS ajoutée comme busy slot
        // Le split intelligent s'occupe de splitter avant/après la pause si nécessaire
        // On la garde uniquement pour les system events qui sont de vraies maintenances

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

        // Vérifier si on chevauche la pause déjeuner
        let fragmentEnd = currentHour + remainingDuration;

        if (schedule.lunchStart !== null && currentHour < schedule.lunchStart && fragmentEnd > schedule.lunchStart) {
            // L'opération chevauche la pause déjeuner → split avant la pause
            const durationBeforeLunch = schedule.lunchStart - currentHour;
            console.log(`[SPLIT] ⚠️ Operation crosses lunch break → splitting before lunch (${durationBeforeLunch}h)`);

            fragments.push({
                duration: durationBeforeLunch,
                machine: machine,
                week: currentWeek,
                year: currentYear,
                day: currentDay,
                startHour: currentHour,
                endHour: schedule.lunchStart,
                type: operation.type || operation.operationType
            });

            remainingDuration -= durationBeforeLunch;
            currentHour = schedule.lunchEnd; // Reprendre après la pause
            fragmentEnd = currentHour + remainingDuration;
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
 * Note : La pause déjeuner n'est PLUS bloquante ici, car le split intelligent s'en occupe
 */
function hasSystemBlock(machine, dayName, weekNum, yearNum, startHour, endHour) {
    const hasEvent = systemEvents.some(e => {
        if ((e.machine !== machine && e.machine !== 'ALL')) return false;
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

    // Ajouter la pause déjeuner comme un créneau occupé (Lun-Jeu)
    if (day !== 'Vendredi') {
        busySlots.push({ start: 12.5, end: 13.0 }); // 12:30-13:00
    }

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

    // Set initial selected week/year to current
    semaineSelectionnee = getWeekNumber(currentTime);
    anneeSelectionnee = currentTime.getFullYear();

    // Safe initialization of UI components
    if (typeof updateCurrentTime === 'function') updateCurrentTime();
    if (typeof initEventHandlers === 'function') initEventHandlers();
    if (typeof initSyncHandlers === 'function') initSyncHandlers();

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

    // Load system events directly
    if (typeof loadSystemEvents === 'function') loadSystemEvents();

    // Initialiser le système de sync hybride (charge local d'abord, puis tente remote)
    try {
        if (typeof syncManager !== 'undefined') {
            await syncManager.init();
        } else {
            console.error("Critical: syncManager is not defined");
            loadOrders(); // Ultra-fallback
        }
    } catch (e) {
        console.error("Critical: Sync Manager Init failed", e);
        if (typeof syncManager !== 'undefined') syncManager.loadLocalData(); 
    }

    console.log(`✅ Commandes actives: ${getActiveOrders().length}/${commandes.length}`);
    console.log(`📦 Commandes placées: ${getPlacedOrders().length}`);
    console.log(`⏳ Commandes non placées: ${getUnplacedOrders().length}`);

    // Initialize sidebar search
    initializeSidebarSearch();

    console.log('✅ Application V2 initialisée avec sync hybride');
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

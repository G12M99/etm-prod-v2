// ===================================
// ETM PROD V2 - Application Logic
// ===================================

// Configuration
const MACHINES = {
    cisailles: ['Cisaille A', 'Cisaille B'],
    poinconneuses: ['Poinçonneuse A', 'Poinçonneuse B'],
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

// Drag and drop state
let draggedOperation = null;

// Global orders array (loaded from CSV)
let commandes = [];


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
 * Parse CSV data and return array of rows
 */
function fetchAndParseCSV() {
    try {
        const lines = localCsvData.trim().split('\n');
        const headers = lines[0].split('\t');
        const rows = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split('\t');
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index] || '';
            });
            rows.push(row);
        }

        console.log(`✅ CSV parsed: ${rows.length} rows`);
        return rows;
    } catch (error) {
        console.error('❌ Error parsing CSV:', error);
        return [];
    }
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
// Data Loading
// ===================================

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw_O3_yBaQJ6QzcJc5bNaEANnqywL__MJvLdFN2ktZS7fE8iajUaSpTWEz4K29HBLTe/exec';

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
 * Load orders from local CSV (Legacy/Fallback)
 */
function loadLocalOrders() {
    try {
        const rows = fetchAndParseCSV();

        // Filter active orders (case-insensitive)
        commandes = rows
            .map(row => mapSheetRowToOrder(row))
            .filter(cmd => {
                const status = cmd.statut.toLowerCase().trim();
                return status === 'en cours' || status === 'en prépa' || status === 'planifiée';
            });

        console.log(`✅ Orders loaded (Local): ${commandes.length} active orders`);
    } catch (error) {
        console.error('❌ Error loading local orders:', error);
        commandes = [];
    }
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
 * Get date range for a week number
 */
function getWeekDateRange(weekNumber, year = 2025) {
    const simple = new Date(year, 0, 1 + (weekNumber - 1) * 7);
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
    return getActiveOrders().filter(cmd => {
        const status = cmd.statut.toLowerCase().trim();

        // Include "Non placée" orders
        if (status === "non placée") {
            return true;
        }

        // Include "En prépa" if at least one operation has NO slots
        if (status === "en prépa") {
            return cmd.operations.some(op => !op.slots || op.slots.length === 0);
        }

        return false;
    });
}

/**
 * Calculate machine capacity for a week
 */
function calculerCapaciteMachine(machine, semaine) {
    const placedOrders = getPlacedOrders();
    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot => slot.machine === machine && slot.semaine === semaine);

    const heuresUtilisees = slots.reduce((sum, slot) => sum + slot.duree, 0);
    const pourcentage = Math.round((heuresUtilisees / TOTAL_HOURS_PER_WEEK) * 100);

    return { heuresUtilisees, pourcentage };
}

/**
 * Calculate machine capacity for a specific day
 */
function calculerCapaciteJour(machine, jour, semaine) {
    const placedOrders = getPlacedOrders();
    const capaciteJour = HOURS_PER_DAY[jour];

    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot =>
            slot.machine === machine &&
            slot.jour === jour &&
            slot.semaine === semaine
        );

    const heuresUtilisees = slots.reduce((sum, slot) => sum + slot.duree, 0);
    const pourcentage = Math.round((heuresUtilisees / capaciteJour) * 100);

    return { heuresUtilisees, capaciteJour, pourcentage };
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
function findFirstAvailableGap(machine, jour, semaine, durationNeeded, minTimeStr = null) {
    const placedOrders = getPlacedOrders();
    const capaciteJour = HOURS_PER_DAY[jour];

    // Get all slots for this machine/day/week
    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot =>
            slot.machine === machine &&
            slot.jour === jour &&
            slot.semaine === semaine
        )
        .sort((a, b) => a.heureDebut.localeCompare(b.heureDebut));

    // Define time boundaries
    // Mon-Thu: 07:30-16:30 (8.5h with lunch 12:30-13:00)
    // Friday: 07:00-12:00 (5h)
    const startHour = jour === 'Vendredi' ? 7 : 7.5;  // 07:00 or 07:30
    const endHour = jour === 'Vendredi' ? 12 : 16.5;  // 12:00 or 16:30
    const totalMinutes = (endHour - startHour) * 60;

    // Create a timeline of busy periods (in minutes from start time)
    const busyPeriods = slots.map(slot => {
        const startParts = slot.heureDebut.split(':');
        const endParts = slot.heureFin.split(':');
        const slotStartHour = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;
        const slotEndHour = parseInt(endParts[0]) + parseInt(endParts[1]) / 60;
        const startMinutes = (slotStartHour - startHour) * 60;
        const endMinutes = (slotEndHour - startHour) * 60;
        return { start: startMinutes, end: endMinutes };
    });

    // Add lunch break for Mon-Thu
    if (jour !== 'Vendredi') {
        const lunchStartParts = LUNCH_BREAK.start.split(':');
        const lunchEndParts = LUNCH_BREAK.end.split(':');
        const lunchStartHour = parseInt(lunchStartParts[0]) + parseInt(lunchStartParts[1]) / 60;
        const lunchEndHour = parseInt(lunchEndParts[0]) + parseInt(lunchEndParts[1]) / 60;
        const lunchStart = (lunchStartHour - startHour) * 60;
        const lunchEnd = (lunchEndHour - startHour) * 60;
        busyPeriods.push({ start: lunchStart, end: lunchEnd });
        busyPeriods.sort((a, b) => a.start - b.start);
    }

    // Find first gap that fits the duration
    const durationMinutes = durationNeeded * 60;
    let currentTime = 0; // Start at beginning of work day

    // If a minimum start time is provided, adjust initial currentTime
    if (minTimeStr) {
        const minParts = minTimeStr.split(':');
        const minHourDecimal = parseInt(minParts[0]) + parseInt(minParts[1]) / 60;
        const startOffset = (minHourDecimal - startHour) * 60;
        currentTime = Math.max(0, startOffset);
    }

    for (const busy of busyPeriods) {
        const gapSize = busy.start - currentTime;
        if (gapSize >= durationMinutes) {
            // Found a gap! Convert back to HH:MM
            const gapStartDecimal = startHour + currentTime / 60;
            const gapStartHour = Math.floor(gapStartDecimal);
            const gapStartMinute = Math.round((gapStartDecimal - gapStartHour) * 60);
            return `${gapStartHour.toString().padStart(2, '0')}:${gapStartMinute.toString().padStart(2, '0')}`;
        }
        currentTime = Math.max(currentTime, busy.end);
    }

    // Check gap at the end
    const remainingMinutes = totalMinutes - currentTime;
    if (remainingMinutes >= durationMinutes) {
        const gapStartDecimal = startHour + currentTime / 60;
        const gapStartHour = Math.floor(gapStartDecimal);
        const gapStartMinute = Math.round((gapStartDecimal - gapStartHour) * 60);
        return `${gapStartHour.toString().padStart(2, '0')}:${gapStartMinute.toString().padStart(2, '0')}`;
    }

    return null; // No gap found
}

/**
 * Get machines sorted by load (least loaded first) for optimal distribution
 * @param {Array} machinesList - List of machines to sort
 * @param {Number} targetWeek - Week number to calculate load for
 * @returns {Array} Machines sorted by load (ascending)
 */
function getMachinesByLoadOrder(machinesList, targetWeek) {
    // Calculate total load for each machine across all weeks up to targetWeek
    const machineLoads = machinesList.map(machine => {
        let totalLoad = 0;

        // Calculate load for weeks 50 to targetWeek
        for (let week = 50; week <= targetWeek; week++) {
            const weekCapacity = calculerCapaciteMachine(machine, week);
            totalLoad += weekCapacity.heuresUtilisees;
        }

        return {
            machine: machine,
            totalLoad: totalLoad,
            weekCapacity: calculerCapaciteMachine(machine, targetWeek)
        };
    });

    // Sort by total load (ascending) - least loaded first
    machineLoads.sort((a, b) => a.totalLoad - b.totalLoad);

    // Return sorted machine names
    return machineLoads.map(m => m.machine);
}

/**
 * Find the next available gap and return its start and max duration
 * @param {string} minTimeStr - Optional minimum start time (HH:MM)
 * @returns {Object|null} { startTime: "HH:MM", duration: number } or null
 */
function findNextGap(machine, jour, semaine, minTimeStr = null) {
    const placedOrders = getPlacedOrders();
    
    // Get all slots for this machine/day/week
    const slots = placedOrders
        .flatMap(cmd => cmd.operations)
        .flatMap(op => op.slots)
        .filter(slot =>
            slot.machine === machine &&
            slot.jour === jour &&
            slot.semaine === semaine
        )
        .sort((a, b) => a.heureDebut.localeCompare(b.heureDebut));

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

    // Scan all possible slots
    for (let week = 50; week <= 52; week++) {
        // 🔒 Global Date Filter (Week)
        if (globalMinStart && week < globalMinStart.week) continue;

        // Get machines sorted by load (irrelevant if machinesList has length 1)
        const sortedMachines = getMachinesByLoadOrder(machinesList, week);

        for (let dayIdx = 0; dayIdx < DAYS_OF_WEEK.length; dayIdx++) {
            // 🔒 Global Date Filter (Day)
            if (globalMinStart && week === globalMinStart.week && dayIdx < globalMinStart.dayIndex) continue;

            const day = DAYS_OF_WEEK[dayIdx];
            
            // Check chronologically against previous operation (Standard Flow)
            // (Skipped detail optimization here, relied on canPlaceOperation for final check)

            for (let machine of sortedMachines) {
                let minTimeStr = null;

                // 🔒 Global Time Filter (Time) - Only applies if we are on the specific Start Day
                if (globalMinStart && week === globalMinStart.week && dayIdx === globalMinStart.dayIndex) {
                    minTimeStr = globalMinStart.timeStr;
                }
                
                // 1. Check Previous Operation (Standard Chronology)
                const opIndex = cmd.operations.indexOf(operation);
                if (opIndex > 0) {
                    const prevOp = cmd.operations[opIndex - 1];
                    if (prevOp.slots && prevOp.slots.length > 0) {
                        const lastSlot = prevOp.slots[prevOp.slots.length - 1];
                        // If prev op finishes this week/day
                        if (lastSlot.semaine === week && lastSlot.jour === day) {
                             // Take the LATER of the two times
                             if (!minTimeStr || timeToDecimalHours(lastSlot.heureFin) > timeToDecimalHours(minTimeStr)) {
                                 minTimeStr = lastSlot.heureFin;
                             }
                        }
                        // If prev op finishes LATER than this day, skip this day
                         const prevEndDate = getDateFromWeekDay(lastSlot.semaine, lastSlot.jour, lastSlot.heureFin);
                         const dayEndTime = day === 'Vendredi' ? '12:00' : '16:30';
                         const thisDayEndDate = getDateFromWeekDay(week, day, dayEndTime);
                         if (thisDayEndDate <= prevEndDate) continue;
                    }
                }

                // 2. Check Previous Slot of THIS Operation (Splitting support)
                if (operation.slots && operation.slots.length > 0) {
                    const lastSelfSlot = operation.slots[operation.slots.length - 1];
                    
                    // Must be after last slot
                    if (lastSelfSlot.semaine > week) continue;
                    if (lastSelfSlot.semaine === week && DAYS_OF_WEEK.indexOf(lastSelfSlot.jour) > dayIdx) continue;

                    if (lastSelfSlot.semaine === week && lastSelfSlot.jour === day) {
                        if (!minTimeStr || timeToDecimalHours(lastSelfSlot.heureFin) > timeToDecimalHours(minTimeStr)) {
                            minTimeStr = lastSelfSlot.heureFin;
                        }
                    }
                }

                // Find NEXT available gap (any size)
                const gap = findNextGap(machine, day, week, minTimeStr);

                if (!gap) continue;

                // Validate chronological order (Strict check)
                const validation = canPlaceOperation(cmd, operation, week, day, gap.startTime);
                if (!validation.valid) {
                    rejectedCount++;
                    continue;
                }

                // Determine how much we can place
                const usableDuration = Math.min(gap.duration, durationNeeded);

                if (usableDuration < 0.25) continue; // Skip tiny gaps (< 15 mins) unless needed?

                // Calculate machine load score
                const machineCapacity = calculerCapaciteMachine(machine, week);
                const loadScore = machineCapacity.heuresUtilisees / TOTAL_HOURS_PER_WEEK;

                candidates.push({
                    machine: machine,
                    week: week,
                    day: day,
                    startTime: gap.startTime,
                    usableDuration: usableDuration,
                    loadScore: loadScore,
                    weekPriority: week
                });
            }
        }
    }

    if (candidates.length === 0) return null;

    // Sort candidates
    candidates.sort((a, b) => {
        // 1. Week Priority
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

    return candidates[0];
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

    // Vérifier que les 3 opérations existent
    const cisaillage = operations.find(op => op.type === 'Cisaillage');
    const poinconnage = operations.find(op => op.type === 'Poinçonnage');
    const pliage = operations.find(op => op.type === 'Pliage');

    if (!cisaillage || !poinconnage || !pliage) {
        return {
            valid: false,
            message: 'La commande doit avoir les 3 opérations obligatoires:\n- Cisaillage\n- Poinçonnage\n- Pliage'
        };
    }

    // Vérifier l'ordre des opérations dans le tableau
    const cisailleIndex = operations.indexOf(cisaillage);
    const poinconIndex = operations.indexOf(poinconnage);
    const pliageIndex = operations.indexOf(pliage);

    if (cisailleIndex > poinconIndex || poinconIndex > pliageIndex) {
        return {
            valid: false,
            message: '⛔ ORDRE DE PRODUCTION INVALIDE\n\nL\'ordre des opérations doit être:\n1. Cisaillage\n2. Poinçonnage\n3. Pliage\n\n❌ Aucune inversion n\'est autorisée!'
        };
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
function canPlaceOperation(commande, operation, targetWeek, targetDay, targetStartTime = '09:00') {
    const operations = commande.operations;
    const operationIndex = operations.indexOf(operation);

    if (operationIndex === -1) {
        return { valid: false, message: 'Opération non trouvée dans la commande' };
    }

    // Calculer la date de début cible
    const targetStartDate = getDateFromWeekDay(targetWeek, targetDay, targetStartTime);

    // Calculer la date de fin approximative (on utilisera la durée de l'opération)
    const targetEndDate = new Date(targetStartDate);
    targetEndDate.setHours(targetEndDate.getHours() + operation.dureeTotal);

    // 🔒 RÈGLE 1: Si l'opération PRÉCÉDENTE est placée, elle doit SE TERMINER AVANT le début de celle-ci
    if (operationIndex > 0) {
        const previousOp = operations[operationIndex - 1];

        if (previousOp.slots && previousOp.slots.length > 0) {
            // Trouver la date de fin de la dernière slot de l'opération précédente
            const previousLastSlot = previousOp.slots[previousOp.slots.length - 1];
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
    if (operationIndex < operations.length - 1) {
        const nextOp = operations[operationIndex + 1];

        if (nextOp.slots && nextOp.slots.length > 0) {
            // Trouver la date de début de la première slot de l'opération suivante
            const nextFirstSlot = nextOp.slots[0];
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
function getDateFromWeekDay(weekNumber, dayName, timeStr) {
    const year = 2025;
    const simple = new Date(year, 0, 1 + (weekNumber - 1) * 7);
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
 * Render week view
 */
function renderVueSemaine() {
    const container = document.getElementById('planningContainer');
    const weeks = [50, 51, 52];

    let html = '<div class="vue-semaine">';

    // Header
    html += '<div class="semaine-header">';
    html += '<div class="semaine-header-cell machine-col">Machine</div>';
    weeks.forEach((week, weekIndex) => {
        const weekRange = getWeekDateRange(week);
        const weekSeparatorClass = weekIndex > 0 ? 'week-separator' : '';
        html += `<div class="semaine-header-cell week-col ${weekSeparatorClass}">S${week} (${weekRange.start}-${weekRange.end} ${weekRange.month})</div>`;
    });
    html += '</div>';

    // Rows for each machine
    ALL_MACHINES.forEach(machine => {
        html += '<div class="semaine-row">';

        // Machine name + average capacity across 3 weeks
        let totalHours = 0;
        weeks.forEach(week => {
            const capacity = calculerCapaciteMachine(machine, week);
            totalHours += capacity.heuresUtilisees;
        });
        const avgHours = Math.round(totalHours / weeks.length * 10) / 10;
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
        weeks.forEach((week, weekIndex) => {
            const capacity = calculerCapaciteMachine(machine, week);

            // Get all commands for this machine/week
            const placedOrders = getPlacedOrders();
            const commandsInWeek = placedOrders.filter(cmd =>
                cmd.operations.some(op =>
                    op.slots.some(slot =>
                        slot.machine === machine && slot.semaine === week
                    )
                )
            );

            // Add week-separator class to first cell of each week
            const weekSeparatorClass = weekIndex > 0 ? 'week-separator' : '';
            html += `<div class="week-cell ${weekSeparatorClass}" data-machine="${machine}" data-week="${week}">`;

            commandsInWeek.forEach(cmd => {
                html += `
                    <span class="command-badge">
                        <span class="badge-id">${cmd.id.substring(5)}</span>
                        <span class="badge-client">${cmd.client}</span>
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
            semaineSelectionnee = week;
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

    // Header with back button
    html += `
        <div class="journee-header">
            <button class="btn btn-secondary" id="btnBackToWeek">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M12 4l-8 6 8 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Retour Vue Semaine
            </button>
            <h2>Semaine ${semaineSelectionnee} (${weekRange.start}-${weekRange.end} ${weekRange.month})</h2>
        </div>
    `;

    // Day headers
    html += '<div class="day-headers">';
    html += '<div class="day-header-cell machine-col">Machine</div>';
    DAYS_OF_WEEK.forEach((day, index) => {
        const capacity = HOURS_PER_DAY[day];
        const timeRange = day === 'Vendredi' ? '07h-12h' : '07h30-16h30';
        html += `
            <div class="day-header-cell day-col ${day === 'Vendredi' ? 'friday' : ''}">
                <div class="day-name">${day}</div>
                <div class="day-capacity">${timeRange} (${capacity}h)</div>
            </div>
        `;
    });
    html += '</div>';

    // Rows for each machine
    ALL_MACHINES.forEach(machine => {
        html += '<div class="journee-row">';

        html += `<div class="machine-cell"><div class="machine-name">${machine}</div></div>`;

        // Day cells with hourly time slots
        DAYS_OF_WEEK.forEach(day => {
            const capacityInfo = calculerCapaciteJour(machine, day, semaineSelectionnee);
            const capacityClass = getCapacityColorClass(capacityInfo.pourcentage);
            const isOverCapacity = capacityInfo.heuresUtilisees > capacityInfo.capaciteJour;
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
                            <span>Charge: ${Math.round(capacityInfo.pourcentage)}%</span>
                            <span class="${isOverCapacity ? 'text-danger' : ''}">
                                ${Math.round(capacityInfo.heuresUtilisees)}h / ${capacityInfo.capaciteJour}h
                                ${isOverCapacity ? '⚠️' : ''}
                            </span>
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
                            slots.push({
                                ...slot,
                                commandeId: cmd.id,
                                client: cmd.client,
                                operationType: op.type,
                                commandeRef: cmd,
                                operationRef: op
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
            // Each slot = 1 hour = 60px
            // For Mon-Thu: start at 07:30, show hourly marks at 07:30, 08:30, 09:30... 16:30
            // For Friday: start at 07:00, show hourly marks at 07:00, 08:00, 09:00... 12:00

            if (day === 'Vendredi') {
                // Friday: 07:00-12:00 (5 slots of 1 hour each)
                for (let hour = 7; hour < 12; hour++) {
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
                // Mon-Thu: 07:30-16:30 (9 slots of 1 hour each)
                // Show: 07:30, 08:30, 09:30, 10:30, 11:30, 12:30, 13:30, 14:30, 15:30
                for (let i = 0; i < 9; i++) {
                    const hourDecimal = 7.5 + i; // 7.5, 8.5, 9.5... 15.5
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

            // Add lunch break visual for Mon-Thu (12:30-13:00)
            if (day !== 'Vendredi') {
                // Pause: 12:30-13:00
                const lunchStartDecimal = 12.5; // 12:30 in decimal
                const lunchEndDecimal = 13.0;   // 13:00 in decimal

                // Calculate position from timeline start (07:30 = 7.5)
                // 12:30 is 5 hours after 07:30
                const topLunch = (lunchStartDecimal - startHourTimeline) * 60;
                const heightLunch = (lunchEndDecimal - lunchStartDecimal) * 60;

                console.log(`🍽️ Pause déjeuner: ${day} | start=${lunchStartDecimal}h | timeline=${startHourTimeline}h | top=${topLunch}px | height=${heightLunch}px`);

                html += `
                    <div class="lunch-break" style="top: ${topLunch}px; height: ${heightLunch}px;"></div>
                `;
            }

            // 🔴 Add Current Time Line (Red Line)
            // Check if this column represents "Today"
            const today = new Date();
            const currentWeekNum = getWeekNumber(today);
            // Map JS day (0=Sun, 1=Mon) to our DAYS_OF_WEEK strings
            const dayMap = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
            const currentDayName = dayMap[today.getDay()];

            if (semaineSelectionnee === currentWeekNum && day === currentDayName) {
                // It's today! Calculate position.
                const nowHour = today.getHours();
                const nowMin = today.getMinutes();
                const nowDecimal = nowHour + (nowMin / 60);

                // Only show if within working hours view
                if (nowDecimal >= startHourTimeline && nowDecimal <= endHourTimeline) {
                    const topPos = (nowDecimal - startHourTimeline) * 60;
                    html += `<div class="current-time-line" style="top: ${topPos}px;" title="Il est ${nowHour}h${nowMin}"></div>`;
                }
            }

            slots.forEach(slot => {
                // Convert HH:MM to decimal hours for precise positioning
                // Example: "09:09" => 9 + 9/60 = 9.15
                const startHour = parseInt(slot.heureDebut.split(':')[0]);
                const startMinute = parseInt(slot.heureDebut.split(':')[1]);
                const startDecimal = startHour + (startMinute / 60);

                // Calculate end time decimal
                const endHourParts = slot.heureFin.split(':');
                const endDecimal = parseInt(endHourParts[0]) + parseInt(endHourParts[1]) / 60;

                // Check if crossing lunch (Mon-Thu only, lunch 12:30-13:00)
                const lunchStart = 12.5;
                const lunchEnd = 13.0;
                const crossesLunch = day !== 'Vendredi' && startDecimal < lunchStart && endDecimal > lunchEnd;

                const renderSlotDiv = (sTime, eTime, isSplitPart = false) => {
                    // Position relative to timeline start
                    // startHourTimeline is 7.5 for Mon-Thu (07:30) or 7.0 for Fri (07:00)
                    // Example: if sTime=9.15 (09:09) and startHourTimeline=7.5 (07:30)
                    //   startOffsetHours = 9.15 - 7.5 = 1.65 hours after start
                    //   topPosition = 1.65 * 60px/hour = 99px from top
                    const startOffsetHours = sTime - startHourTimeline;
                    const topPosition = Math.round(startOffsetHours * 60);  // 60px per hour, rounded to nearest pixel
                    const heightInPixels = Math.round((eTime - sTime) * 60);

                    // Debug log for position verification
                    if (slot.heureDebut === slot.heureDebut) { // Always true, just for grouping
                        console.log(`📍 Position: ${slot.operationType} ${slot.heureDebut}-${slot.heureFin} | ` +
                                    `sTime=${sTime.toFixed(2)}h | startTimeline=${startHourTimeline}h | ` +
                                    `offset=${startOffsetHours.toFixed(2)}h | top=${topPosition}px`);
                    }
                    
                    // Specific class for split parts to look connected?
                    // Maybe just same styling.
                    
                    const typeClass = slot.operationType.toLowerCase().replace('ç', 'c').replace('é', 'e');
                    const slotId = `${slot.semaine}_${slot.jour}_${slot.heureDebut}`; // Original ID

                    return `
                        <div class="operation-slot ${typeClass} draggable"
                             draggable="true"
                             data-commande-id="${slot.commandeId}"
                             data-operation-type="${slot.operationType}"
                             data-slot-id="${slotId}"
                             data-operation='${JSON.stringify({ commandeId: slot.commandeId, operationType: slot.operationType, slotId: slotId }).replace(/'/g, "&#39;")}'
                             style="position: absolute; top: ${topPosition}px; left: 5px; right: 5px; height: ${heightInPixels}px; z-index: 10;">
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
        });

        html += '</div>';
    });

    html += '</div>';
    container.innerHTML = html;

    // Add event listeners
    document.getElementById('btnBackToWeek').addEventListener('click', () => {
        toggleVue('semaine');
    });

    initDragAndDrop();
}

// ===================================
// UI Rendering - Commandes Non Placées
// ===================================

/**
 * Render unplaced orders
 */
function renderCommandesNonPlacees() {
    const container = document.getElementById('unplacedOrdersContainer');
    const unplacedOrders = getUnplacedOrders();

    // Sort by dateLivraison (urgent first)
    unplacedOrders.sort((a, b) => {
        const dateA = new Date(a.dateLivraison);
        const dateB = new Date(b.dateLivraison);
        return dateA - dateB;
    });

    if (unplacedOrders.length === 0) {
        container.innerHTML = '<p class="no-orders">Aucune commande à placer</p>';
        return;
    }

    let html = '';
    let cardsRendered = 0;

    unplacedOrders.forEach(cmd => {
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
}

function handleDragStart(e) {
    draggedOperation = JSON.parse(e.target.getAttribute('data-operation'));
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleSidebarDragStart(e) {
    draggedOperation = JSON.parse(e.target.getAttribute('data-sidebar-operation'));
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');
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

    const targetMachine = e.currentTarget.getAttribute('data-machine');
    const targetDay = e.currentTarget.getAttribute('data-day');
    const targetWeek = parseInt(e.currentTarget.getAttribute('data-week'));
    const targetHour = e.currentTarget.getAttribute('data-hour');
    const targetTime = e.currentTarget.getAttribute('data-time');

    if (!draggedOperation) return;

    // Determine start time based on drop zone (or use findFirstAvailableGap)
    let startHour = 9; // Default
    if (targetHour) {
        startHour = parseInt(targetHour);
    }

    // Find the command and operation
    const cmd = commandes.find(c => c.id === draggedOperation.commandeId);
    if (!cmd) return;

    const operation = cmd.operations.find(op => op.type === draggedOperation.operationType);
    if (!operation) return;

    // CASE 1: Drag from sidebar
    if (draggedOperation.fromSidebar) {
        let bestSlot = null;
        let forcedPlacement = false;

        // NEW: Check if dropped on a specific target (Machine + Day + Week)
        if (targetMachine && targetDay && targetWeek) {
            let proposedStartTime = null;

            if (targetTime) {
                // Dropped on a specific time slot (e.g. 07:30)
                proposedStartTime = targetTime;
            } else if (targetHour) {
                // Fallback (should be covered by targetTime now)
                proposedStartTime = `${targetHour.toString().padStart(2, '0')}:00`;
            } else {
                // Dropped on the day/machine column generally?
                // Try to find first gap on THIS machine/day
                proposedStartTime = findFirstAvailableGap(targetMachine, targetDay, targetWeek, operation.dureeTotal);
            }

            if (proposedStartTime) {
                // 1. Check Availability at this specific time
                const availability = isMachineAvailable(targetMachine, targetDay, targetWeek, proposedStartTime, operation.dureeTotal);
                
                if (availability.valid) {
                    // 2. Check Chronology (canPlaceOperation)
                    const validation = canPlaceOperation(cmd, operation, targetWeek, targetDay, proposedStartTime);
                    
                    if (validation.valid) {
                         // Create a "bestSlot" object to reuse the placement logic below
                         bestSlot = {
                             machine: targetMachine,
                             week: targetWeek,
                             day: targetDay,
                             startTime: proposedStartTime,
                             loadScore: 0 // Irrelevant for manual placement
                         };
                         forcedPlacement = true;
                    } else {
                        // Chronology error - Show alert and stop
                        alert('⛔ ORDRE CHRONOLOGIQUE INVALIDE\n\n' + validation.message);
                        return;
                    }
                } else {
                    // Availability error - Only alert if user tried to force a specific slot
                    if (targetTime || targetHour) {
                        alert(`❌ Placement impossible :\n${availability.reason}`);
                        return;
                    }
                }
            }
        }

        // If no forced placement (or it failed silently for generic drop), fall back to auto-placement
        if (!bestSlot) {
             // Get available machines for this operation type
            let availableMachines = [];
            if (operation.type === 'Cisaillage') availableMachines = MACHINES.cisailles;
            else if (operation.type === 'Poinçonnage') availableMachines = MACHINES.poinconneuses;
            else if (operation.type === 'Pliage') availableMachines = MACHINES.plieuses;

            // 🎯 Find best slot with load balancing (not forced on targetMachine)
            bestSlot = findBestMachineSlot(operation, cmd, availableMachines);
        }

        if (!bestSlot) {
            alert(`❌ Impossible de placer ${operation.type}. Aucun créneau disponible respectant l'ordre chronologique.`);
            refresh();
            return;
        }

        // Calculate end time
        const startTimeParts = bestSlot.startTime.split(':');
        const startHourCalc = parseInt(startTimeParts[0]) + parseInt(startTimeParts[1]) / 60;
        
        // Adjust for lunch break if crossing it (Mon-Thu)
        let effectiveDuration = operation.dureeTotal;
        const lunchStart = 12.5; // 12:30
        
        if (bestSlot.day !== 'Vendredi' && startHourCalc < lunchStart && (startHourCalc + effectiveDuration) > lunchStart) {
            effectiveDuration += 0.5; // Add 30min break
        }

        const endHourFloat = startHourCalc + effectiveDuration;
        const endHour = Math.floor(endHourFloat);
        const endMinute = Math.round((endHourFloat - endHour) * 60);
        const endTime = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;

        // Create new slot with best machine
        const dateDebut = getDateFromWeekDay(bestSlot.week, bestSlot.day, bestSlot.startTime);
        const dateFin = getDateFromWeekDay(bestSlot.week, bestSlot.day, endTime);

        operation.slots.push({
            machine: bestSlot.machine,
            duree: operation.dureeTotal,
            semaine: bestSlot.week,
            jour: bestSlot.day,
            heureDebut: bestSlot.startTime,
            heureFin: endTime,
            dateDebut: dateDebut.toISOString().split('.')[0],
            dateFin: dateFin.toISOString().split('.')[0]
        });

        operation.statut = "Planifiée";

        const typeMsg = forcedPlacement ? "Drag manuel" : "Drag auto";
        console.log(`✅ ${typeMsg}: Placé ${operation.type} sur ${bestSlot.machine} - S${bestSlot.week} ${bestSlot.day} ${bestSlot.startTime}`);

        // Update command status if all operations placed
        const allPlaced = cmd.operations.every(op => op.slots && op.slots.length > 0);
        if (allPlaced) {
            cmd.statut = "Planifiée";
        }

        refresh();
        return;
    }

    // CASE 2: Drag from planning (move existing slot)
    if (operation.slots.length === 0) return;

    // Trouver le slot spécifique qui est déplacé en utilisant slotId
    const draggedSlotId = draggedOperation.slotId;
    const slot = operation.slots.find(s => {
        const sId = `${s.semaine}_${s.jour}_${s.heureDebut}`;
        return sId === draggedSlotId;
    });

    if (!slot) {
        console.error('Slot non trouvé:', draggedSlotId);
        return;
    }

    const startTime = `${startHour.toString().padStart(2, '0')}:00`;

    // Calculer les nouvelles valeurs AVANT la validation
    // Utiliser la durée du SLOT spécifique (pas dureeTotal de l'opération)
    const endHour = startHour + slot.duree;
    const endTime = `${Math.floor(endHour).toString().padStart(2, '0')}:${Math.round((endHour % 1) * 60).toString().padStart(2, '0')}`;
    const newStartDate = getDateFromWeekDay(targetWeek, targetDay, startTime);
    const newEndDate = getDateFromWeekDay(targetWeek, targetDay, endTime);

    // Sauvegarder les anciennes valeurs du slot
    const oldSlotData = {
        machine: slot.machine,
        jour: slot.jour,
        semaine: slot.semaine,
        heureDebut: slot.heureDebut,
        heureFin: slot.heureFin,
        dateDebut: slot.dateDebut,
        dateFin: slot.dateFin
    };

    // Appliquer temporairement les nouvelles valeurs pour la validation
    slot.machine = targetMachine;
    slot.jour = targetDay;
    slot.semaine = targetWeek;
    slot.heureDebut = startTime;
    slot.heureFin = endTime;
    slot.dateDebut = newStartDate.toISOString().split('.')[0];
    slot.dateFin = newEndDate.toISOString().split('.')[0];

    // 🔒 VALIDATION CRITIQUE: Vérifier l'ordre chronologique avec les NOUVELLES valeurs
    const validation = canPlaceOperation(cmd, operation, targetWeek, targetDay, startTime);

    if (!validation.valid) {
        // Restaurer les anciennes valeurs si la validation échoue
        slot.machine = oldSlotData.machine;
        slot.jour = oldSlotData.jour;
        slot.semaine = oldSlotData.semaine;
        slot.heureDebut = oldSlotData.heureDebut;
        slot.heureFin = oldSlotData.heureFin;
        slot.dateDebut = oldSlotData.dateDebut;
        slot.dateFin = oldSlotData.dateFin;

        alert('⛔ ORDRE CHRONOLOGIQUE INVALIDE\n\n' + validation.message);
        renderVueJournee();
        return;
    }

    // ✅ Validation OK - les nouvelles valeurs sont déjà appliquées
    // Re-render
    renderVueJournee();
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
    
    // Define Rush Hour Windows: 09:00-10:00 OR 12:00-13:30
    const isRushHour = (currentHour >= 9 && currentHour < 10) || (currentHour >= 12 && currentHour < 13.5);
    
    // Only apply logic if Today is a working day (Mon-Fri) and within simulation range (50-52)
    // Note: In a real app, week range would be dynamic.
    if (currentDayIndex >= 0 && currentDayIndex < 5 && currentWeek >= 50 && currentWeek <= 52) {
        if (isRushHour) {
            // "Fait a la date d'aujourd'hui" => Force Start Today at 00:00 (allow filling morning gaps)
            globalMinStart = { week: currentWeek, dayIndex: currentDayIndex, timeStr: "00:00" };
            console.log("🚀 Rush Hour Mode: Prioritizing Today (filling gaps from start of day)!");
            Toast.info("Mode Prioritaire : Placement sur la journée en cours");
        } else {
            // "Sinon... ne peut pas placer avant celle-ci" => Start from NOW
            const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
            globalMinStart = { week: currentWeek, dayIndex: currentDayIndex, timeStr: timeStr };
            console.log(`🕒 Standard Mode: Starting search from ${timeStr}`);
        }
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

        // Loop to place chunks until full duration is scheduled
        while (remainingDuration > 0.01) { // 0.01 tolerance for float math
            
            // 🎯 Find best slot for remaining duration (or largest available chunk)
            // Pass globalMinStart to constrain search
            const bestSlot = findBestMachineSlot(operation, cmd, availableMachines, remainingDuration, globalMinStart);
            
            if (!bestSlot) {
                console.warn(`⚠️ Impossible de placer une partie de l'opération ${operation.type} (${remainingDuration}h) de la commande ${cmd.id}`);
                alert(`⚠️ Impossible de placer ${operation.type} (reste ${formatHours(remainingDuration)}). Les opérations suivantes ne seront pas planifiées.`);
                placementFailed = true;
                break; 
            }

            // Duration actually placed in this slot
            const placedDuration = bestSlot.usableDuration;

            // Calculate end time
            const startParts = bestSlot.startTime.split(':');
            const startHourFloat = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;
            const endHourFloat = startHourFloat + placedDuration;
            const endHour = Math.floor(endHourFloat);
            const endMinute = Math.round((endHourFloat - endHour) * 60);
            const endTime = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;

            const startDate = getDateFromWeekDay(bestSlot.week, bestSlot.day, bestSlot.startTime);
            const endDate = getDateFromWeekDay(bestSlot.week, bestSlot.day, endTime);

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
        alert(`✅ Commande ${commandeId} placée automatiquement avec répartition optimale !`);
    } else {
        alert(`⚠️ Commande ${commandeId} partiellement placée. Certaines opérations n'ont pas pu être placées.`);
    }

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
                // Basic validation
                if (Array.isArray(data)) {
                    commandes = data;
                    console.log(`✅ Loaded ${commandes.length} orders from Local Storage.`);
                    this.updateSyncIndicator('offline', 'Données locales');
                    refresh(); // Render immediately
                }
            } else {
                console.log('ℹ️ No local data found. Loading demo/legacy.');
                loadLocalOrders(); // Fallback to CSV string in app.js
            }
        } catch (e) {
            console.error('❌ Error loading local data:', e);
            loadLocalOrders();
        }
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
// View Toggle
// ===================================

// ===================================
// UI Rendering - Vue Liste (New)
// ===================================

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

    refresh();
    Toast.info(`Commande ${commandeId} retirée du planning`);
}

/**
 * Render List View
 */
function renderVueListe() {
    const container = document.getElementById('planningContainer');
    
    let html = `
        <div class="vue-liste">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
                <h2 style="margin:0;">Liste des Commandes</h2>
                <div class="search-box">
                    <!-- Placeholder for search -->
                </div>
            </div>
            <div class="table-responsive">
                <table class="commands-table">
                    <thead>
                        <tr>
                            <th>Commande</th>
                            <th>Client</th>
                            <th>Livraison</th>
                            <th>Matériau</th>
                            <th>Statut Global</th>
                            <th>État Planning</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
    `;

    // Sort by delivery date
    const sortedCommandes = [...commandes].sort((a, b) => new Date(a.dateLivraison) - new Date(b.dateLivraison));

    sortedCommandes.forEach(cmd => {
        const isPlaced = cmd.operations.some(op => op.slots.length > 0);
        
        // Normalize status for CSS class
        let statusClass = 'non-placee';
        const s = cmd.statut.toLowerCase();
        if (s.includes('planifi')) statusClass = 'planifiee';
        else if (s.includes('cours')) statusClass = 'en-cours';
        else if (s.includes('livr')) statusClass = 'livree';
        else if (s.includes('termin')) statusClass = 'livree';
        
        // Planning status logic
        let planningStatus = '<span class="planning-status not-in-planning">Non planifié</span>';
        if (isPlaced) {
            const placedOps = cmd.operations.filter(op => op.slots.length > 0).length;
            const totalOps = cmd.operations.length;
            if (placedOps === totalOps) {
                planningStatus = '<span class="planning-status in-planning">✓ Planifié (Complet)</span>';
            } else {
                planningStatus = `<span class="planning-status in-planning" style="color:var(--color-poinconnage)">⚠ Partiel (${placedOps}/${totalOps})</span>`;
            }
        }

        html += `
            <tr>
                <td><strong>${cmd.id}</strong></td>
                <td>${cmd.client}</td>
                <td>${formatDate(cmd.dateLivraison)}</td>
                <td>${cmd.poids}kg ${cmd.materiau}</td>
                <td><span class="status-badge ${statusClass}">${cmd.statut}</span></td>
                <td>${planningStatus}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="showCommandeDetails('${cmd.id}')">Détails</button>
                    ${isPlaced ? `<button class="btn btn-sm btn-danger" onclick="unplanCommand('${cmd.id}')" style="margin-left: 8px;">Retirer du planning</button>` : ''}
                </td>
            </tr>
        `;
    });

    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

// Make globally accessible
window.unplanCommand = unplanCommand;

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
    renderCommandesNonPlacees();
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
    });
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
            renderCommandesNonPlacees();

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

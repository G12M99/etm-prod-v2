// ===================================
// ETM PROD - Configuration des Machines
// ===================================

const MACHINES_CONFIG = {
    cisaillage: [
        { id: 'cisaille-a', name: 'Cisaille A', capacity: 8.5, color: '#10b981', active: true },
        { id: 'cisaille-b', name: 'Cisaille B', capacity: 8.5, color: '#10b981', active: true }
    ],
    poinconnage: [
        { id: 'poinconneuse-m', name: 'Poinçonneuse M', capacity: 8.5, color: '#2563eb', active: true },
        { id: 'poinconneuse-t', name: 'Poinçonneuse T', capacity: 8.5, color: '#2563eb', active: true }
    ],
    pliage: [
        { id: 'plieuse-lo', name: 'Plieuse Lo', capacity: 8.5, color: '#ef4444', active: true },
        { id: 'plieuse-mik', name: 'Plieuse Mik', capacity: 8.5, color: '#ef4444', active: true },
        { id: 'plieuse-mok', name: 'Plieuse Mok', capacity: 8.5, color: '#ef4444', active: true }
    ]
};

// Geler la configuration par défaut
Object.freeze(MACHINES_CONFIG);
Object.freeze(MACHINES_CONFIG.cisaillage);
Object.freeze(MACHINES_CONFIG.poinconnage);
Object.freeze(MACHINES_CONFIG.pliage);

// ===================================
// Configuration des Horaires de Production
// ===================================

const SCHEDULE_DEFAULT_CONFIG = {
    // Equipes de travail
    shifts: [
        {
            id: 'jour',
            name: 'Equipe Jour',
            active: true,
            days: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'],
            schedules: {
                'Lundi': { start: '07:30', end: '16:30' },
                'Mardi': { start: '07:30', end: '16:30' },
                'Mercredi': { start: '07:30', end: '16:30' },
                'Jeudi': { start: '07:30', end: '16:30' },
                'Vendredi': { start: '07:00', end: '12:00' }
            }
        }
    ],
    // Pauses (appliquees a tous les jours concernes)
    breaks: [
        {
            id: 'dejeuner',
            name: 'Pause Dejeuner',
            start: '12:30',
            end: '13:00',
            days: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi'],
            active: true
        }
    ],
    // Heures supplementaires par jour
    overtime: {
        enabled: true,
        slots: [
            { days: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi'], start: '16:30', end: '18:00' },
            { days: ['Vendredi'], start: '12:00', end: '14:00' }
        ],
        maxDailyHours: 2,
        maxWeeklyHours: 10
    }
};

// Geler la configuration horaires par defaut
Object.freeze(SCHEDULE_DEFAULT_CONFIG);

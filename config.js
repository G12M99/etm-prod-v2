// ===================================
// ETM PROD - Configuration des Machines
// ===================================

const MACHINES_CONFIG = {
    cisaillage: [
        { id: 'cisaille-a', name: 'Cisaille A', capacity: 8.5, color: '#4ade80', active: true },
        { id: 'cisaille-b', name: 'Cisaille B', capacity: 8.5, color: '#4ade80', active: true }
    ],
    poinconnage: [
        { id: 'poinconneuse-m', name: 'Poinçonneuse M', capacity: 8.5, color: '#f97316', active: true },
        { id: 'poinconneuse-t', name: 'Poinçonneuse T', capacity: 8.5, color: '#f97316', active: true }
    ],
    pliage: [
        { id: 'plieuse-lo', name: 'Plieuse Lo', capacity: 8.5, color: '#a855f7', active: true },
        { id: 'plieuse-mik', name: 'Plieuse Mik', capacity: 8.5, color: '#a855f7', active: true },
        { id: 'plieuse-mok', name: 'Plieuse Mok', capacity: 8.5, color: '#a855f7', active: true }
    ]
};

// Geler la configuration par défaut
Object.freeze(MACHINES_CONFIG);
Object.freeze(MACHINES_CONFIG.cisaillage);
Object.freeze(MACHINES_CONFIG.poinconnage);
Object.freeze(MACHINES_CONFIG.pliage);

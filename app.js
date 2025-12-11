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
    'Lundi': 8,
    'Mardi': 8,
    'Mercredi': 8,
    'Jeudi': 8,
    'Vendredi': 5
};

const DAYS_OF_WEEK = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
const TOTAL_HOURS_PER_WEEK = 37; // 8*4 + 5

// Calcul de durée par poids de matériau
const DUREE_PAR_KG = {
    'Cisaillage': 0.02,    // 0.02h par kg (ex: 100kg = 2h)
    'Poinçonnage': 0.015,  // 0.015h par kg
    'Pliage': 0.025        // 0.025h par kg
};

// Current time simulation
let currentTime = new Date('2025-12-11T14:00:00');

// View state
let vueActive = 'semaine'; // 'semaine' ou 'journee'
let semaineSelectionnee = 50;

// Drag and drop state
let draggedOperation = null;

// ===================================
// Demo Data V2 - With Slots
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
 * Filter active orders
 */
function getActiveOrders() {
    return commandesDemo.filter(cmd =>
        cmd.statut !== "Terminée" && cmd.statut !== "Livrée"
    );
}

/**
 * Get placed orders (with at least one slot)
 */
function getPlacedOrders() {
    return getActiveOrders().filter(cmd =>
        cmd.statut !== "Non placée"
    );
}

/**
 * Get unplaced orders
 */
function getUnplacedOrders() {
    return getActiveOrders().filter(cmd =>
        cmd.statut === "Non placée"
    );
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
                const suggestedMaxTime = maxStartHour >= 9 ? `${maxStartHour.toString().padStart(2, '0')}:00` : 'impossible ce jour';

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
        html += `
            <div class="day-header-cell day-col ${day === 'Vendredi' ? 'friday' : ''}">
                <div class="day-name">${day}</div>
                <div class="day-capacity">09h-${capacity === 8 ? '17h' : '14h'} (${capacity}h)</div>
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
            const maxHour = day === 'Vendredi' ? 14 : 17;

            html += `
                <div class="day-cell ${day === 'Vendredi' ? 'friday' : ''}"
                     data-machine="${machine}"
                     data-day="${day}"
                     data-week="${semaineSelectionnee}">
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

            // Create hourly time grid (background - 09:00 to 17:00 or 14:00)
            html += '<div class="time-grid">';
            for (let hour = 9; hour < maxHour; hour++) {
                const timeSlot = `${hour.toString().padStart(2, '0')}:00`;
                html += `
                    <div class="time-slot drop-zone"
                         data-machine="${machine}"
                         data-day="${day}"
                         data-week="${semaineSelectionnee}"
                         data-hour="${hour}">
                        <div class="time-label">${timeSlot}</div>
                    </div>
                `;
            }
            html += '</div>';

            // Overlay operations with absolute positioning
            html += '<div class="operations-overlay">';
            slots.forEach(slot => {
                const startHour = parseInt(slot.heureDebut.split(':')[0]);
                const startMinute = parseInt(slot.heureDebut.split(':')[1]);

                // Calculate position from top (9:00 = 0px)
                const startOffsetHours = startHour - 9 + (startMinute / 60);
                const topPosition = startOffsetHours * 60; // 60px per hour

                // Calculate height
                const durationInHours = slot.duree;
                const heightInPixels = durationInHours * 60;

                const typeClass = slot.operationType.toLowerCase().replace('ç', 'c').replace('é', 'e');

                // Créer un identifiant unique pour ce slot
                const slotId = `${slot.semaine}_${slot.jour}_${slot.heureDebut}`;

                html += `
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
            });
            html += '</div>';

            html += '</div>'; // Close timeline-container

            html += `
                    </div>
                    <div class="day-capacity-info">
                        <div class="day-capacity-bar">
                            <div class="capacity-fill ${capacityClass}" style="width: ${Math.min(100, capacityInfo.pourcentage)}%"></div>
                        </div>
                        <div class="day-total ${isOverCapacity ? 'over-capacity' : ''}">
                            ${capacityInfo.heuresUtilisees}h/${capacityInfo.capaciteJour}h (${capacityInfo.pourcentage}%)
                            ${isOverCapacity ? ' ❌' : ''}
                        </div>
                    </div>
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

    if (unplacedOrders.length === 0) {
        container.innerHTML = '<p class="no-orders">Aucune commande à placer</p>';
        return;
    }

    let html = '';
    unplacedOrders.forEach(cmd => {
        const urgencyLevel = getUrgencyLevel(cmd.dateLivraison);
        const livraison = new Date(cmd.dateLivraison);
        const daysUntil = Math.ceil((livraison - currentTime) / (1000 * 60 * 60 * 24));

        const cisaillage = cmd.operations.find(op => op.type === 'Cisaillage');
        const poinconnage = cmd.operations.find(op => op.type === 'Poinçonnage');
        const pliage = cmd.operations.find(op => op.type === 'Pliage');

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
                        <strong>Opérations:</strong>
                        <span class="op-time cisaillage">Cisaille: ${formatHours(cisaillage.dureeTotal)}</span> |
                        <span class="op-time poinconnage">Poinçon: ${formatHours(poinconnage.dureeTotal)}</span> |
                        <span class="op-time pliage">Pliage: ${formatHours(pliage.dureeTotal)}</span>
                    </div>
                    <div class="detail-item">
                        <strong>Livraison:</strong> ${formatDate(cmd.dateLivraison)} (${daysUntil} jours)
                        ${urgencyLevel === 'urgente' ? ' ❌ URGENT' : urgencyLevel === 'attention' ? ' ⚠️' : ' ✓'}
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
    });

    container.innerHTML = html;
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

function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    const targetMachine = e.currentTarget.getAttribute('data-machine');
    const targetDay = e.currentTarget.getAttribute('data-day');
    const targetWeek = parseInt(e.currentTarget.getAttribute('data-week'));
    const targetHour = e.currentTarget.getAttribute('data-hour');

    if (!draggedOperation) return;

    // Find the command and operation
    const cmd = commandesDemo.find(c => c.id === draggedOperation.commandeId);
    if (!cmd) return;

    const operation = cmd.operations.find(op => op.type === draggedOperation.operationType);
    if (!operation || operation.slots.length === 0) return;

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

    // Determine start time based on drop zone
    let startHour = 9; // Default
    if (targetHour) {
        startHour = parseInt(targetHour);
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
    const cmd = commandesDemo.find(c => c.id === commandeId);
    if (!cmd) return;

    // 🔒 VALIDATION CRITIQUE: Vérifier que la commande a les 3 opérations dans le bon ordre
    const orderValidation = validateOperationOrder(cmd);
    if (!orderValidation.valid) {
        alert('⛔ ORDRE DE PRODUCTION INVALIDE\n\n' + orderValidation.message);
        return;
    }

    // For each operation, find the first available slot RESPECTING CHRONOLOGICAL ORDER
    cmd.operations.forEach((operation) => {
        if (operation.slots.length > 0) return; // Already placed

        // Get available machines for this operation type
        let availableMachines = [];
        if (operation.type === 'Cisaillage') availableMachines = MACHINES.cisailles;
        else if (operation.type === 'Poinçonnage') availableMachines = MACHINES.poinconneuses;
        else if (operation.type === 'Pliage') availableMachines = MACHINES.plieuses;

        // Find first available slot that respects chronological order
        let placed = false;
        for (let week = 50; week <= 52 && !placed; week++) {
            for (let dayIdx = 0; dayIdx < DAYS_OF_WEEK.length && !placed; dayIdx++) {
                const day = DAYS_OF_WEEK[dayIdx];

                for (let machine of availableMachines) {
                    // 🔒 VALIDATION: Vérifier que le placement respecte l'ordre CHRONOLOGIQUE
                    const validation = canPlaceOperation(cmd, operation, week, day, '09:00');
                    if (!validation.valid) {
                        continue; // Skip this slot if it violates chronological order
                    }

                    const capacity = calculerCapaciteJour(machine, day, week);
                    const available = capacity.capaciteJour - capacity.heuresUtilisees;

                    if (available >= operation.dureeTotal) {
                        // Place here starting at 09:00
                        const startHour = 9;
                        const endHour = startHour + operation.dureeTotal;
                        const startTime = `${startHour.toString().padStart(2, '0')}:00`;
                        const endTime = `${Math.floor(endHour).toString().padStart(2, '0')}:${Math.round((endHour % 1) * 60).toString().padStart(2, '0')}`;

                        const startDate = getDateFromWeekDay(week, day, startTime);
                        const endDate = getDateFromWeekDay(week, day, endTime);

                        operation.slots.push({
                            machine: machine,
                            duree: operation.dureeTotal,
                            semaine: week,
                            jour: day,
                            heureDebut: startTime,
                            heureFin: endTime,
                            dateDebut: startDate.toISOString().split('.')[0],
                            dateFin: endDate.toISOString().split('.')[0]
                        });

                        operation.statut = "Planifiée";
                        placed = true;
                        break;
                    }
                }
            }
        }
    });

    // Update command status
    const allPlaced = cmd.operations.every(op => op.slots.length > 0);
    if (allPlaced) {
        cmd.statut = "Planifiée";
    }

    // Re-render
    refresh();
    alert(`Commande ${commandeId} placée automatiquement !`);
}

/**
 * Show command details
 */
function showCommandeDetails(commandeId) {
    const cmd = commandesDemo.find(c => c.id === commandeId);
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
// View Toggle
// ===================================

/**
 * Toggle between week and day views
 */
function toggleVue(vue) {
    vueActive = vue;

    // Update button states
    document.getElementById('btnVueSemaine')?.classList.toggle('active', vue === 'semaine');
    document.getElementById('btnVueJournee')?.classList.toggle('active', vue === 'journee');

    // Render appropriate view
    if (vue === 'semaine') {
        renderVueSemaine();
    } else {
        renderVueJournee();
    }
}

/**
 * Refresh all views
 */
function refresh() {
    if (vueActive === 'semaine') {
        renderVueSemaine();
    } else {
        renderVueJournee();
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

/**
 * Initialize the application
 */
function init() {
    console.log('🏭 ETM PROD V2 - Planning de Production');
    console.log(`📅 Date de référence: ${currentTime.toLocaleString('fr-FR')}`);
    console.log(`✅ Commandes actives: ${getActiveOrders().length}/${commandesDemo.length}`);
    console.log(`📦 Commandes placées: ${getPlacedOrders().length}`);
    console.log(`⏳ Commandes non placées: ${getUnplacedOrders().length}`);

    updateCurrentTime();
    renderVueSemaine();
    renderCommandesNonPlacees();
    initEventHandlers();

    console.log('✅ Application V2 initialisée');
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

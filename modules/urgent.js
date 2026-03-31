/**
 * @module urgent
 * @description Moteur d'insertion urgente et Smart Scenario.
 *   Workflow : sélection commande → calcul scénarios → confirmation → application.
 * @requires state.js, utils.js, scheduling.js, auto-place.js, db.js, ui-list.js
 */

import { State, markCommandeDirty, historyManager } from './state.js';
import {
    formatDate, formatHours, decimalToTimeString, timeToDecimalHours,
    generateSlotId, getWeekNumber, getISOWeekYear, getDateFromWeekDay,
    getUrgencyLevel, DAYS_OF_WEEK, Toast
} from './utils.js';
import {
    getUnplacedOrders, getPlacedOrders, getScheduleForDay,
    getBlockedZonesForDay, calculateEndTimeWithBreaks
} from './scheduling.js';
import {
    getMachinesForOp, findUrgentSlot, findStandardGap, findAllGaps,
    getNextWorkDay, getOperationSequence, getFollowingOperations,
    compareSlotsForSequencing, splitOperationForSlot,
    findConflicts, hasSystemBlock,
    displaceOperationWithCascade, tryDisplaceConflicts,
    calculateDisplaceabilityScore, findNextAvailableSlotForDisplacement
} from './auto-place.js';
import { saveData, deleteSlot } from './db.js';
import { refresh } from './ui-list.js';

// ===================================
// Constante privée — ne pas exporter
// ===================================

const SCHEDULE_CONFIG = {
    MONDAY_TO_THURSDAY: {
        start: 7.5,
        standardEnd: 16.5,
        overtimeEnd: 18.0,
        lunchStart: 12.5,
        lunchEnd: 13.0
    },
    FRIDAY: {
        start: 7.0,
        standardEnd: 12.0,
        overtimeEnd: 14.0,
        lunchStart: null,
        lunchEnd: null
    },
    CR_THRESHOLD: 1.05,
    CR_FORCE_THRESHOLD: 0.95,
    MAX_DISPLACEMENTS_NORMAL: 5,
    MAX_DISPLACEMENTS_FORCE: 20,
    SEARCH_HORIZON_DAYS: 14
};

// ===================================
// État local du module
// ===================================

let currentUrgentOrder = null;
let currentScenarios = [];
let currentScenario = null;


// ===================================
// Helpers
// ===================================

/**
 * Helper: Get Date from week number, year and day name
 * Distinct from getDateFromWeekDay (different argument order, no timeStr)
 */
export function getDateFromWeekAndDay(weekNum, year, dayName) {
    const simple = new Date(year, 0, 1 + (weekNum - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = new Date(simple);
    if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

    const dayIndex = DAYS_OF_WEEK.indexOf(dayName);
    const targetDate = new Date(ISOweekStart);
    targetDate.setDate(ISOweekStart.getDate() + dayIndex);

    return targetDate;
}

export function formatTimeRange(start, end) {
    const h1 = Math.floor(start);
    const m1 = Math.round((start - h1) * 60);
    const h2 = Math.floor(end);
    const m2 = Math.round((end - h2) * 60);
    return `${h1.toString().padStart(2,'0')}:${m1.toString().padStart(2,'0')}-${h2.toString().padStart(2,'0')}:${m2.toString().padStart(2,'0')}`;
}

// ===================================
// Overtime Confirmation Dialog
// ===================================

/**
 * Affiche une modale de confirmation pour les heures supplémentaires
 * @param {object} operationInfo - Informations sur l'opération
 * @returns {Promise<string>} 'accept' ou 'refuse'
 */
export function showOvertimeConfirmDialog(operationInfo) {
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
// UI modale — Étape 1 : Sélection commande
// ===================================

/**
 * Show Urgent Insertion Modal
 */
export function showUrgentInsertionModal() {
    document.getElementById('modalUrgentInsertion').classList.add('active');

    // Reset steps
    document.querySelectorAll('.insertion-step').forEach(step => step.classList.remove('active'));
    document.getElementById('stepSelectOrder').classList.add('active');

    renderUrgentOrdersList();
}

/**
 * Render list of urgent orders (Unplaced or Partial)
 */
export function renderUrgentOrdersList() {
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
export function selectUrgentOrder(orderId) {
    document.querySelectorAll('.urgent-order-item').forEach(el => el.classList.remove('selected'));
    document.getElementById(`order-${orderId}`).classList.add('selected');

    currentUrgentOrder = State.commandes.find(c => c.id === orderId);
    document.getElementById('btnNextToScenarios').disabled = false;
}

/**
 * Go to Scenario Selection Step
 */
export function handleNextToScenarios() {
    if (!currentUrgentOrder) return;

    document.getElementById('stepSelectOrder').classList.remove('active');
    document.getElementById('stepSelectScenario').classList.add('active');

    // Generate Scenarios
    currentScenarios = generateInsertionScenarios(currentUrgentOrder);
    renderScenariosSelection();
}

// ===================================
// UI modale — Étape 2 : Scénarios
// ===================================

/**
 * Render Scenario Cards
 */
export function renderScenariosSelection() {
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
export function selectScenario(id) {
    document.querySelectorAll('.scenario-card').forEach(el => el.classList.remove('selected'));
    document.getElementById(`scenario-${id}`).classList.add('selected');

    currentScenario = currentScenarios.find(s => s.id === id);
    document.getElementById('btnValidateScenario').disabled = false;
}

// ===================================
// UI modale — Étape 3 : Confirmation
// ===================================

/**
 * Render Displacement Confirmation Details (SMART scenario)
 */
export function renderDisplacementConfirmation() {
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

/**
 * Check if all 3 confirmation checkboxes are checked (PRIO scenario)
 */
export function checkConfirmationState() {
    const c1 = document.getElementById('checkOperators').checked;
    const c2 = document.getElementById('checkMaintenance').checked;
    const c3 = document.getElementById('checkApproval').checked;
    document.getElementById('btnConfirmOvertime').disabled = !(c1 && c2 && c3);
}

// ===================================
// Calcul des scénarios
// ===================================

/**
 * Generate Insertion Scenarios (SMART + PRIO)
 */
export function generateInsertionScenarios(order) {
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

/**
 * Scénario Normal (stub)
 */
export function calculateNormalPlan(order) {
    return true; // Stub
}

/**
 * Scénario B: Cherche le premier trou disponible (sans fractionnement)
 */
export function calculateEarliestStartPlan(order) {
    const result = { feasible: true, slots: [] };
    let currentTime = { week: State.semaineSelectionnee, dayIdx: 0, minHour: 0 };

    // Ajuster au temps réel
    const now = new Date();
    if (getWeekNumber(now) === State.semaineSelectionnee) {
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
            const dayIdx = d % 5;
            const dayName = DAYS_OF_WEEK[dayIdx];
            const minStart = (dayIdx === currentTime.dayIdx) ? currentTime.minHour : 7.5;

            let machines = getMachinesForOp(op.type);
            for (const machine of machines) {
                const gap = findStandardGap(machine, dayName, State.semaineSelectionnee, State.anneeSelectionnee, op.dureeTotal, minStart);
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
export function calculateSplitPlan(order) {
    const result = { feasible: true, slots: [], isSplit: false, splitCount: 0 };
    let currentTime = { week: State.semaineSelectionnee, dayIdx: 0, minHour: 0 };

    // Ajuster temps réel
    const now = new Date();
    if (getWeekNumber(now) === State.semaineSelectionnee) {
        let todayIdx = now.getDay() - 1;
        if (todayIdx === -1) todayIdx = 6;
        currentTime.dayIdx = todayIdx;
        currentTime.minHour = now.getHours() + now.getMinutes() / 60;
    }

    for (const op of order.operations) {
        let remainingDuration = op.dureeTotal;
        let startDayIdx = currentTime.dayIdx;
        let opSplits = 0;

        for (let d = startDayIdx; d < startDayIdx + 5 && remainingDuration > 0.1; d++) {
            const dayIdx = d % 5;
            const dayName = DAYS_OF_WEEK[dayIdx];
            const minStart = (dayIdx === currentTime.dayIdx) ? currentTime.minHour : 7.5;

            let machines = getMachinesForOp(op.type);
            for (const machine of machines) {
                const gaps = findAllGaps(machine, dayName, State.semaineSelectionnee, State.anneeSelectionnee, minStart);

                for (const gap of gaps) {
                    const usable = Math.min(gap.duration, remainingDuration);
                    if (usable >= 0.5) {
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

// ===================================
// Smart Scenario — Séquençage strict Cis→Poi→Pli
// ===================================

/**
 * Calculate Smart Insertion Plan (Scenario SMART) - V2 avec ordre des opérations
 */
export function calculateSmartInsertionPlan(order) {
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

    // Contexte de séquençage
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

        const searchContext = isFirstOp ? {
            startWeek: getWeekNumber(now),
            startYear: getISOWeekYear(now),
            startDay: null,
            minHour: now.getHours() + now.getMinutes() / 60
        } : {
            startWeek: sequencingContext.lastEndWeek,
            startYear: sequencingContext.lastEndYear,
            startDay: sequencingContext.lastEndDay,
            minHour: sequencingContext.lastEndHour
        };

        console.log(`[SMART] Search context:`, searchContext);

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

        const slots = Array.isArray(placementResult.slots) ? placementResult.slots : [placementResult.slot];

        for (const slot of slots) {
            result.slots.push({
                ...slot,
                opType: urgentOp.type
            });
        }

        result.displacements.push(...placementResult.displacements);

        // Mettre à jour le contexte pour l'opération suivante
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
export function placeOperationSequentially(duration, opType, urgentOrder, mode, crThreshold, maxDisplacements, now, searchContext) {
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

    // SPLIT INTELLIGENT
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
export function tryPlaceFromPosition(machine, dayName, weekNum, yearNum, minHour, duration, opType, urgentOrder, mode, crThreshold, maxDisplacements, now) {
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

    const isToday = getDateFromWeekAndDay(weekNum, yearNum, dayName).toDateString() === now.toDateString();
    const currentHourDecimal = now.getHours() + now.getMinutes() / 60;
    const searchStartHour = isToday ? Math.max(minHour, currentHourDecimal) : Math.max(minHour, schedule.start);

    for (let startHour = searchStartHour; startHour + duration <= schedule.overtimeEnd; startHour += 0.5) {
        const endHour = startHour + duration;

        const conflicts = findConflicts(machine, dayName, weekNum, yearNum, startHour, endHour);

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

        const displacementResult = tryDisplaceConflicts(
            conflicts,
            machine,
            dayName,
            weekNum,
            yearNum,
            endHour,
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

    // Essayer sur le jour suivant
    const nextDay = getNextWorkDay(dayName, weekNum, yearNum);
    if (nextDay) {
        console.log(`[TRY_PLACE] Trying next day: ${nextDay.day}`);
        return tryPlaceFromPosition(
            machine,
            nextDay.day,
            nextDay.week,
            nextDay.year,
            0,
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

// ===================================
// Overbooking Plan (PRIO scenario)
// ===================================

/**
 * Calculate Urgent/Overbooking Plan (Scenario PRIO)
 */
export function calculateOverbookingPlan(order) {
    const result = {
        feasible: true,
        slots: [],
        totalOvertimeHours: 0,
        reason: ''
    };

    const now = new Date();
    const currentWeekNum = getWeekNumber(now);
    const currentYearNum = now.getFullYear();
    let startDayIdx = now.getDay() - 1;
    if (startDayIdx === -1) startDayIdx = 6;

    let cursor = {
        week: currentWeekNum,
        year: currentYearNum,
        dayIdx: startDayIdx,
        minHour: now.getHours() + now.getMinutes() / 60
    };

    const sortedOperations = [...order.operations].sort((a, b) => {
        const orderMap = { 'Cisaillage': 1, 'Poinçonnage': 2, 'Pliage': 3 };
        return (orderMap[a.type] || 99) - (orderMap[b.type] || 99);
    });

    for (const op of sortedOperations) {
        if (op.slots.length > 0) continue;

        let machines = getMachinesForOp(op.type);
        let placed = false;

        let searchWeek = cursor.week;
        let searchYear = cursor.year;

        for (let wOffset = 0; wOffset < 4; wOffset++) {
            const dStart = 0;

            for (let d = dStart; d < 5; d++) {
                const dayName = DAYS_OF_WEEK[d];

                const isToday = (wOffset === 0 && d === cursor.dayIdx);
                const minStart = isToday ? cursor.minHour : 0;

                for (const machine of machines) {
                    const slot = findUrgentSlot(machine, dayName, op.dureeTotal, minStart, searchWeek, searchYear);

                    if (slot) {
                        result.slots.push({
                            machine: machine,
                            day: dayName,
                            hours: op.dureeTotal,
                            timeRange: slot.range,
                            opType: op.type,
                            week: searchWeek,
                            year: searchYear
                        });

                        result.totalOvertimeHours += op.dureeTotal;
                        placed = true;
                        break;
                    }
                }
                if (placed) break;
            }
            if (placed) break;

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

// ===================================
// Application du scénario
// ===================================

/**
 * Apply Scenario Logic
 */
export function applyScenario(scenario, selectedOrder) {
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

            const targetWeek = slot.week || State.semaineSelectionnee;
            const targetYear = slot.year || State.anneeSelectionnee;

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
            const cmd = State.commandes.find(c => c.id === displacement.commandeId);
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
                if (removedSlot.id) {
                    deleteSlot(removedSlot.id);
                }
                operation.slots.splice(oldSlotIndex, 1);
            }

            // Add the new slot
            const newStartStr = displacement.newSlot.startTime;
            const newEndStr = displacement.newSlot.endTime;

            const targetWeek = displacement.newSlot.week;
            const targetYear = displacement.newSlot.year;

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
            const operation = selectedOrder.operations.find(op => op.type === slot.opType);
            if (!operation) return;

            const startHourStr = slot.timeRange.split('-')[0];
            const startDecimal = timeToDecimalHours(startHourStr);
            const endDecimal = startDecimal + slot.hours;

            const endHour = Math.floor(endDecimal);
            const endMinute = Math.round((endDecimal - endHour) * 60);
            const endTimeStr = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;

            const targetWeek = slot.week || State.semaineSelectionnee;
            const targetYear = slot.year || State.anneeSelectionnee;

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
    saveData(selectedOrder.id);
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
export function trackOvertimeUsage(scenario) {
    if (!scenario.actions.overbooking_slots) return;

    scenario.actions.overbooking_slots.forEach(slot => {
        State.overtimeTracker.totalHoursUsed += slot.hours;

        if (!State.overtimeTracker.byMachine[slot.machine]) {
            State.overtimeTracker.byMachine[slot.machine] = { hours: 0 };
        }
        State.overtimeTracker.byMachine[slot.machine].hours += slot.hours;

        if (!State.overtimeTracker.byDay[slot.day]) {
            State.overtimeTracker.byDay[slot.day] = 0;
        }
        State.overtimeTracker.byDay[slot.day] += slot.hours;
    });
}

// ===================================
// Init Handlers
// ===================================

/**
 * Attach all event handlers for the Urgent Insertion modal
 */
export function initUrgentHandlers() {
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
            document.getElementById('stepSelectScenario').classList.remove('active');
            document.getElementById('stepConfirmDisplacement').classList.add('active');
            renderDisplacementConfirmation();
        } else if (currentScenario.id === 'PRIO') {
            document.getElementById('stepSelectScenario').classList.remove('active');
            document.getElementById('stepConfirmOvertime').classList.add('active');

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
            applyScenario(currentScenario, currentUrgentOrder);
            document.getElementById('modalUrgentInsertion').classList.remove('active');
        }
    });

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

    document.getElementById('btnBackToScenariosFromSmart')?.addEventListener('click', () => {
        document.getElementById('stepConfirmDisplacement').classList.remove('active');
        document.getElementById('stepSelectScenario').classList.add('active');
    });

    document.getElementById('btnConfirmDisplacement')?.addEventListener('click', () => {
        applyScenario(currentScenario, currentUrgentOrder);
        document.getElementById('modalUrgentInsertion').classList.remove('active');
    });
}

// ===================================
// Exposition globale
// ===================================
window.showUrgentInsertionModal = showUrgentInsertionModal;
window.selectUrgentOrder = selectUrgentOrder;
window.selectScenario = selectScenario;
window.showOvertimeConfirmDialog = showOvertimeConfirmDialog;

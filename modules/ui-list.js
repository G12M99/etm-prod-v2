/**
 * @module ui-list
 * @description Vue Liste, toggleVue, refresh, showCommandeDetails et helpers associ\u00e9s.
 * @requires state.js, utils.js, scheduling.js, db.js
 */

import { State, markCommandeDirty, historyManager } from './state.js';
import {
    formatDate, formatHours, escapeHtml, getWeekNumber, getISOWeekYear, DAYS_OF_WEEK, Toast
} from './utils.js';
import { shouldShowCommandeInList } from './scheduling.js';
import { deleteAllSlotsForOperation, saveData } from './db.js';
import { renderVueSemaine } from './ui-week.js';
import { renderVueJournee } from './ui-day.js';
import { renderSidebarContent, renderCommandesNonPlacees } from './ui-sidebar.js';

// ===================================
// Local state (not in global State)
// ===================================

let listSort = { field: 'dateLivraison', direction: 'asc' };
let listSearch = '';

// ===================================
// Vue Liste
// ===================================

/**
 * Render the list view with stats, filters, sorting and search.
 * Smart update: if .vue-liste already exists, only updates dynamic parts.
 */
export function renderVueListe() {
    const container = document.getElementById('planningContainer');

    // --- 1. DATA PREPARATION ---

    let countTotal = 0;
    let countComplete = 0;
    let countPartial = 0;
    let countNone = 0;

    State.commandes.forEach(cmd => {
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

    // Filter
    let filteredCommandes = [...State.commandes];

    if (State.hideCompletedStatuses) {
        filteredCommandes = filteredCommandes.filter(shouldShowCommandeInList);
    }

    if (listSearch) {
        const term = listSearch.toLowerCase();
        filteredCommandes = filteredCommandes.filter(c =>
            c.id.toLowerCase().includes(term) ||
            c.client.toLowerCase().includes(term) ||
            c.statut.toLowerCase().includes(term) ||
            c.materiau.toLowerCase().includes(term)
        );
    }

    // Sort
    filteredCommandes.sort((a, b) => {
        let valA = a[listSort.field];
        let valB = b[listSort.field];

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
            Compl\u00e8tes: <span>${countComplete}</span>
        </div>
        <div class="stat-tag" style="border-color: var(--color-capacity-warning); color: #d63384;">
            <span style="background:var(--color-capacity-warning); width:8px; height:8px; border-radius:50%; display:inline-block;"></span>
            Partielles: <span>${countPartial}</span>
        </div>
        <div class="stat-tag" style="color: var(--color-text-secondary);">
            Non plac\u00e9es: <span>${countNone}</span>
        </div>
    `;

    const generateRowsHtml = () => {
        if (filteredCommandes.length === 0) {
            return `<tr><td colspan="7" class="text-center" style="padding: 32px; color: var(--color-text-secondary);">Aucune commande trouv\u00e9e</td></tr>`;
        }

        return filteredCommandes.map(cmd => {
            const isPlaced = cmd.operations.some(op => op.slots.length > 0);

            let statusClass = 'non-placee';
            const s = cmd.statut.toLowerCase();
            if (s.includes('planifi')) statusClass = 'planifiee';
            else if (s.includes('cours')) statusClass = 'en-cours';
            else if (s.includes('livr')) statusClass = 'livree';
            else if (s.includes('termin')) statusClass = 'livree';

            let opsVizHtml = '<div class="ops-viz">';
            const requiredOps = ['Cisaillage', 'Poin\u00e7onnage', 'Pliage'];
            requiredOps.forEach(type => {
                const op = cmd.operations.find(o => o.type === type);
                if (op) {
                    const isOpPlaced = op.slots && op.slots.length > 0;
                    const typeClass = type.toLowerCase().replace('\u00e7', 'c').replace('\u00e9', 'e');
                    const label = type.substring(0, 2);
                    opsVizHtml += `<div class="op-dot ${typeClass} ${isOpPlaced ? 'placed' : ''}" title="${type}: ${isOpPlaced ? 'Planifi\u00e9' : '\u00c0 planifier'}">${label}</div>`;
                } else {
                    opsVizHtml += `<div class="op-dot" style="opacity:0.3" title="Non requis">-</div>`;
                }
            });
            opsVizHtml += '</div>';

            return `
                <tr>
                    <td><strong>${escapeHtml(cmd.id)}</strong></td>
                    <td>${escapeHtml(cmd.client)}</td>
                    <td>${formatDate(cmd.dateLivraison)}</td>
                    <td>${cmd.poids}kg ${escapeHtml(cmd.materiau)}</td>
                    <td><span class="status-badge ${statusClass}">${escapeHtml(cmd.statut)}</span></td>
                    <td>${opsVizHtml}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="showCommandeDetails('${cmd.id}')">D\u00e9tails</button>
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
        // Smart Update: only dynamic parts
        existingView.querySelector('.list-stats').innerHTML = generateStatsHtml();
        existingView.querySelector('tbody').innerHTML = generateRowsHtml();

        const headers = existingView.querySelectorAll('.sort-header');
        headers.forEach(th => {
            th.classList.remove('asc', 'desc');
            const onClickAttr = th.getAttribute('onclick');
            if (onClickAttr && onClickAttr.includes(`'${listSort.field}'`)) {
                th.classList.add(listSort.direction);
            }
        });

        const filterBtn = existingView.querySelector('.btn-filter-toggle');
        if (filterBtn) {
            filterBtn.className = `btn-filter-toggle ${State.hideCompletedStatuses ? '' : 'active'}`;
            filterBtn.title = State.hideCompletedStatuses ? 'Afficher toutes les commandes' : 'Masquer termin\u00e9es/livr\u00e9es';
            filterBtn.innerHTML = State.hideCompletedStatuses ? '\ud83d\udc41 Tout afficher' : '\u2713 Affichage complet';
        }
    } else {
        // Initial Render: full skeleton
        const html = `
            <div class="vue-liste">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 16px; flex-wrap: wrap; gap: 16px;">
                    <div>
                        <h2 style="margin:0 0 8px 0;">Liste des Commandes</h2>
                        <div class="list-stats">
                            ${generateStatsHtml()}
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px; align-items: center;">
                        <button onclick="toggleCompletedStatuses()"
                                class="btn-filter-toggle ${State.hideCompletedStatuses ? '' : 'active'}"
                                title="${State.hideCompletedStatuses ? 'Afficher toutes les commandes' : 'Masquer termin\u00e9es/livr\u00e9es'}">
                            ${State.hideCompletedStatuses ? '\ud83d\udc41 Tout afficher' : '\u2713 Affichage complet'}
                        </button>
                        <div class="search-box">
                            <input type="text"
                                   class="search-input"
                                   placeholder="Rechercher (Client, ID, Statut...)"
                                   value="${escapeHtml(listSearch)}"
                                   oninput="handleListSearch(event)">
                        </div>
                    </div>
                </div>

                <div class="table-responsive">
                    <table class="commands-table">
                        <thead>
                            <tr>
                                <th class="sort-header ${listSort.field === 'id' ? listSort.direction : ''}" onclick="handleListSort('id')">Commande</th>
                                <th class="sort-header ${listSort.field === 'client' ? listSort.direction : ''}" onclick="handleListSort('client')">Client</th>
                                <th class="sort-header ${listSort.field === 'dateLivraison' ? listSort.direction : ''}" onclick="handleListSort('dateLivraison')">Livraison</th>
                                <th class="sort-header ${listSort.field === 'materiau' ? listSort.direction : ''}" onclick="handleListSort('materiau')">Mat\u00e9riau</th>
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

        // Restore focus if re-render triggered by search
        if (listSearch) {
            const input = container.querySelector('.search-input');
            if (input) {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }
        }
    }
}

// ===================================
// List helpers
// ===================================

/**
 * Sort the list view by a field.
 * @param {string} field
 */
export function handleListSort(field) {
    if (listSort.field === field) {
        listSort.direction = listSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        listSort.field = field;
        listSort.direction = 'asc';
    }
    renderVueListe();
}

/**
 * Filter the list view by search text.
 * @param {Event} e
 */
export function handleListSearch(e) {
    listSearch = e.target.value;
    renderVueListe();
}

/**
 * Toggle display of completed/delivered statuses.
 */
export function toggleCompletedStatuses() {
    State.hideCompletedStatuses = !State.hideCompletedStatuses;
    renderVueListe();
}

/**
 * Remove a command from the planning (unplan all operations).
 * @param {string} commandeId
 */
export function unplanCommand(commandeId) {
    if (!confirm(`Voulez-vous vraiment retirer la commande ${commandeId} du planning ?\nToutes les op\u00e9rations plac\u00e9es seront remises en "Non plac\u00e9e".`)) {
        return;
    }

    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) return;

    cmd.operations.forEach(op => {
        if (op.id) {
            deleteAllSlotsForOperation(op.id);
        }
        op.slots = [];
        op.statut = 'Non plac\u00e9e';
        op.progressionReelle = 0;
    });

    cmd.statut = 'Non plac\u00e9e';

    historyManager.saveState(`Retrait ${commandeId}`);

    saveData(commandeId);

    refresh();

    Toast.info(`Commande ${commandeId} retir\u00e9e du planning`);
}

// ===================================
// View navigation
// ===================================

/**
 * Switch between views (semaine, journee, liste).
 * @param {string} vue - 'semaine' | 'journee' | 'liste'
 */
export function toggleVue(vue) {
    State.vueActive = vue;

    document.getElementById('btnVueSemaine')?.classList.toggle('active', vue === 'semaine');
    document.getElementById('btnVueJournee')?.classList.toggle('active', vue === 'journee');
    document.getElementById('btnVueListe')?.classList.toggle('active', vue === 'liste');

    if (vue === 'semaine') {
        renderVueSemaine();
    } else if (vue === 'journee') {
        renderVueJournee();
    } else if (vue === 'liste') {
        renderVueListe();
    }

    renderSidebarContent(State.currentSearchQuery || '');
}

/**
 * Refresh the current view and sidebar.
 */
export function refresh() {
    if (State.vueActive === 'semaine') {
        renderVueSemaine();
    } else if (State.vueActive === 'journee') {
        renderVueJournee();
    } else if (State.vueActive === 'liste') {
        renderVueListe();
    }

    renderCommandesNonPlacees(State.currentSearchQuery || '');

    updateCurrentTime();
}

/**
 * Update the current time display in the footer indicator.
 */
export function updateCurrentTime() {
    const timeElement = document.getElementById('currentTime');
    if (timeElement) {
        const now = new Date();
        timeElement.textContent = now.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    }
}

// ===================================
// showCommandeDetails
// ===================================

/**
 * Check if an operation has a manual time override.
 * @param {object} op
 * @returns {boolean}
 */
function hasTimeOverride(op) {
    return op.dureeOverride !== null && op.dureeOverride !== undefined;
}

/**
 * Show the order details modal.
 * @param {string} commandeId
 */
export function showCommandeDetails(commandeId) {
    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) return;

    const modal = document.getElementById('modalOrderDetails');
    const content = document.getElementById('orderDetailsContent');

    content.innerHTML = `
        <div class="order-details-warning">
            \ud83d\udd12 <strong>ORDRE CHRONOLOGIQUE:</strong> Cisaille \u2192 Poin\u00e7on \u2192 Pliage (Obligatoire dans le planning)
        </div>
        <div class="detail-row">
            <span class="detail-label">Commande:</span>
            <span class="detail-value">${escapeHtml(cmd.id)}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Client:</span>
            <span class="detail-value">${escapeHtml(cmd.client)}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Mat\u00e9riau:</span>
            <span class="detail-value">${escapeHtml(cmd.materiau)} (${cmd.poids}kg)</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Livraison:</span>
            <span class="detail-value">${formatDate(cmd.dateLivraison)}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Statut:</span>
            <span class="detail-value">${escapeHtml(cmd.statut)}</span>
        </div>
        <div class="operations-list">
            <h3>Op\u00e9rations</h3>
            ${cmd.operations.map(op => {
                const override = hasTimeOverride(op);
                const originalDuration = op.dureeOriginal || op.dureeTotal;
                const typeClass = op.type.toLowerCase().replace('\u00e7', 'c').replace('\u00e9', 'e');
                return `
                <div class="operation-item ${typeClass} ${override ? 'has-override' : ''}">
                    <div class="operation-item-header">
                        <span>${escapeHtml(op.type)}</span>
                        <span class="operation-time-edit">
                            <span class="operation-duration ${override ? 'overridden' : ''}"
                                  onclick="showModalTimeEdit('${cmd.id}', '${op.type}', ${op.dureeTotal}, ${originalDuration})"
                                  title="Cliquer pour modifier le temps">
                                ${formatHours(op.dureeTotal)}
                                ${override ? '<span class="override-indicator">*</span>' : ''}
                                <span class="edit-icon">&#9998;</span>
                            </span>
                            ${override ? `<span class="override-badge">(Original: ${formatHours(originalDuration)})</span>` : ''}
                        </span>
                    </div>
                    <div class="operation-item-details">
                        ${op.slots.length > 0 ?
                            op.slots.map(slot => `
                                Machine: ${escapeHtml(slot.machine)}<br>
                                Semaine ${slot.semaine} - ${slot.jour}<br>
                                ${slot.heureDebut} - ${slot.heureFin}
                            `).join('<br>')
                            : 'Non plac\u00e9e'
                        }
                    </div>
                    ${override ? `
                        <div class="operation-override-actions">
                            <button class="btn btn-xs btn-secondary" onclick="resetOperationTimeOverride('${cmd.id}', '${op.type}'); showCommandeDetails('${cmd.id}');">
                                R\u00e9initialiser au temps original
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
// Navigation semaine
// ===================================

/**
 * Change la semaine sélectionnée par un offset (+1 / -1).
 * @param {number} offset
 */
export function changeWeek(offset) {
    State.semaineSelectionnee += offset;

    if (State.semaineSelectionnee > 52) {
        State.semaineSelectionnee = 1;
        State.anneeSelectionnee++;
    } else if (State.semaineSelectionnee < 1) {
        State.semaineSelectionnee = 52;
        State.anneeSelectionnee--;
    }
    refresh();
}

/**
 * Navigue vers la semaine contenant une date donnée.
 * @param {string} dateStr - ISO date string
 */
export function goToWeekFromDate(dateStr) {
    if (!dateStr) return;
    const date = new Date(dateStr);
    State.semaineSelectionnee = getWeekNumber(date);
    State.anneeSelectionnee = date.getFullYear();

    // Correction if week 1 is in December
    if (State.semaineSelectionnee === 1 && date.getMonth() === 11) {
        State.anneeSelectionnee++;
    }
    // Correction if week 52/53 is in January
    if (State.semaineSelectionnee >= 52 && date.getMonth() === 0) {
        State.anneeSelectionnee--;
    }

    refresh();
}

// ===================================
// Time Override System
// ===================================

/**
 * Définit un override de temps pour une opération.
 * @param {string} commandeId
 * @param {string} operationType
 * @param {number} newDuration - Nouvelle durée en heures décimales
 * @returns {boolean}
 */
export function setOperationTimeOverride(commandeId, operationType, newDuration) {
    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) {
        Toast.error('Commande non trouvée');
        return false;
    }

    const operation = cmd.operations.find(op => op.type === operationType);
    if (!operation) {
        Toast.error('Opération non trouvée');
        return false;
    }

    if (operation.dureeOriginal === undefined || operation.dureeOriginal === null) {
        operation.dureeOriginal = operation.dureeTotal;
    }

    operation.dureeOverride = newDuration;
    operation.overrideTimestamp = new Date().toISOString();
    operation.dureeTotal = newDuration;

    historyManager.saveState(`Override temps ${operationType} ${commandeId}`);
    saveData(commandeId);
    refresh();

    Toast.success(`Temps ${operationType} modifié: ${formatHours(newDuration)}`);
    return true;
}

/**
 * Réinitialise le temps d'une opération à la valeur originale du Google Sheet.
 */
export function resetOperationTimeOverride(commandeId, operationType) {
    const cmd = State.commandes.find(c => c.id === commandeId);
    if (!cmd) return false;

    const operation = cmd.operations.find(op => op.type === operationType);
    if (!operation || !hasTimeOverride(operation)) return false;

    operation.dureeTotal = operation.dureeOriginal;
    operation.dureeOverride = null;
    operation.overrideTimestamp = null;

    historyManager.saveState(`Reset temps ${operationType} ${commandeId}`);
    saveData(commandeId);
    refresh();

    Toast.info(`Temps ${operationType} réinitialisé: ${formatHours(operation.dureeOriginal)}`);
    return true;
}

/**
 * Affiche le popup d'édition de temps (sidebar).
 */
export function showTimeEditPopup(commandeId, operationType, currentDuration, originalDuration, targetElement) {
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

    const rect = targetElement.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
    popup.style.top = `${rect.bottom + 5}px`;
    popup.style.zIndex = '1001';

    document.body.appendChild(popup);

    document.getElementById('timeEditHours').focus();
    document.getElementById('timeEditHours').select();

    setTimeout(() => {
        document.addEventListener('click', closeTimeEditPopupOnOutsideClick);
    }, 10);
}

export function closeTimeEditPopup() {
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

export function applyTimeEdit(commandeId, operationType) {
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
 * Affiche le modal d'édition de temps (depuis modal détail).
 */
export function showModalTimeEdit(commandeId, operationType, currentDuration, originalDuration) {
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

    document.getElementById('modalTimeEditValue').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) || 0;
        document.getElementById('timePreview').textContent = formatHours(val);
    });

    document.getElementById('modalTimeEditValue').focus();
    document.getElementById('modalTimeEditValue').select();
}

export function closeModalTimeEdit() {
    const overlay = document.getElementById('modalTimeEditOverlay');
    if (overlay) overlay.remove();
}

export function applyModalTimeEdit(commandeId, operationType) {
    const value = parseFloat(document.getElementById('modalTimeEditValue').value);
    if (value <= 0) {
        Toast.warning('La durée doit être supérieure à 0');
        return;
    }
    setOperationTimeOverride(commandeId, operationType, value);
    closeModalTimeEdit();
    showCommandeDetails(commandeId);
}

export function resetAndCloseModalTimeEdit(commandeId, operationType) {
    resetOperationTimeOverride(commandeId, operationType);
    closeModalTimeEdit();
    showCommandeDetails(commandeId);
}

// ===================================
// Global exposure (for inline onclick handlers)
// ===================================

window.toggleVue = toggleVue;
window.refresh = refresh;
window.unplanCommand = unplanCommand;
window.handleListSort = handleListSort;
window.handleListSearch = handleListSearch;
window.toggleCompletedStatuses = toggleCompletedStatuses;
window.showCommandeDetails = showCommandeDetails;
window.changeWeek = changeWeek;
window.goToWeekFromDate = goToWeekFromDate;
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

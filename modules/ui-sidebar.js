/**
 * @module ui-sidebar
 * @description Rendu DOM de la sidebar : commandes non affectées (vue semaine),
 *   opérations à placer (vue journée), recherche, filtrage.
 * @requires state.js, utils.js, scheduling.js, drag-drop.js
 */

import { State } from './state.js';
import {
    formatDate, formatHours, escapeHtml, getUrgencyLevel
} from './utils.js';
import {
    getCommandesNonAffectees, getOperationsAffecteesSemaine
} from './scheduling.js';
import {
    handleCommandeDragStart, handleSidebarDragStart, handleDragEnd,
    handleDesaffectationDrop
} from './drag-drop.js';

// ===================================
// Dispatcher
// ===================================

/**
 * Render sidebar content based on current view.
 * @param {string} searchQuery
 */
export function renderSidebarContent(searchQuery = '') {
    const titleEl = document.querySelector('.sidebar-title');

    if (State.vueActive === 'semaine') {
        if (titleEl) titleEl.textContent = 'Commandes \u00e0 affecter';
        renderSidebarVueSemaine(searchQuery);
    } else if (State.vueActive === 'journee') {
        if (titleEl) titleEl.textContent = `Op\u00e9rations S${State.semaineSelectionnee}`;
        renderSidebarVueJournee(searchQuery);
    } else {
        if (titleEl) titleEl.textContent = 'Commandes';
        const container = document.getElementById('unplacedOrdersContainer');
        if (container) container.innerHTML = '<p class="no-orders">S\u00e9lectionnez une vue pour voir les commandes</p>';
    }
}

// ===================================
// Vue Semaine — commandes non affectées
// ===================================

/**
 * Sidebar for week view: unassigned commands, draggable to week grid.
 * @param {string} searchQuery
 */
export function renderSidebarVueSemaine(searchQuery = '') {
    const container = document.getElementById('unplacedOrdersContainer');
    const unaffectedOrders = getCommandesNonAffectees();

    // Sort by urgency (delivery date)
    unaffectedOrders.sort((a, b) => {
        const dateA = a.dateLivraison ? new Date(a.dateLivraison) : new Date(8640000000000000);
        const dateB = b.dateLivraison ? new Date(b.dateLivraison) : new Date(8640000000000000);
        if (isNaN(dateA.getTime())) return 1;
        if (isNaN(dateB.getTime())) return -1;
        return dateA - dateB;
    });

    // Search filter
    let filteredOrders = unaffectedOrders;
    if (searchQuery && searchQuery.trim() !== '') {
        filteredOrders = filterCommandesBySearch(unaffectedOrders, searchQuery);
        updateSearchResultCount(filteredOrders.length, unaffectedOrders.length);
    }

    // Drop zone for de-assignment — always present so badges can always be desaffected
    const dropzoneHtml = `
        <div class="sidebar-dropzone-desaffect" id="dropzoneDesaffect">
            <div class="dropzone-content">
                <span class="dropzone-icon">\ud83d\udce4</span>
                <span class="dropzone-text">Glisser ici pour d\u00e9saffecter</span>
            </div>
        </div>
    `;

    if (unaffectedOrders.length === 0) {
        container.innerHTML = dropzoneHtml + '<p class="no-orders">Toutes les commandes sont affect\u00e9es \u00e0 une semaine</p>';
        attachDesaffectZoneHandlers();
        return;
    }

    if (searchQuery && searchQuery.trim() !== '' && filteredOrders.length === 0) {
        container.innerHTML = dropzoneHtml + `
            <div class="no-search-results">
                <svg viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                    <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <p>Aucun r\u00e9sultat pour <span class="search-term">"${escapeHtml(searchQuery)}"</span></p>
            </div>
        `;
        attachDesaffectZoneHandlers();
        return;
    }

    let html = dropzoneHtml;

    filteredOrders.forEach(cmd => {
        const urgencyLevel = getUrgencyLevel(cmd.dateLivraison);
        const livraison = new Date(cmd.dateLivraison);
        const daysUntil = Math.ceil((livraison - new Date()) / (1000 * 60 * 60 * 24));

        const totalHeures = cmd.operations
            .filter(op => !op.slots || op.slots.length === 0)
            .reduce((sum, op) => sum + op.dureeTotal, 0);

        const opsHtml = cmd.operations.map(op => {
            const placed = op.slots && op.slots.length > 0;
            const typeClass = op.type.toLowerCase().replace('\u00e7', 'c');
            return `<span class="op-badge ${typeClass}" style="opacity: ${placed ? '0.5' : '1'}">
                        ${op.type.substring(0, 3)} ${formatHours(op.dureeTotal)}${placed ? ' \u2713' : ''}
                    </span>`;
        }).join('');

        html += `
            <div class="commande-card-semaine ${urgencyLevel} draggable-commande"
                 draggable="true"
                 data-commande-id="${cmd.id}"
                 data-commande-affectation='${JSON.stringify({ commandeId: cmd.id, fromSidebar: true }).replace(/'/g, "&#39;")}'>
                <div class="commande-header-semaine">
                    <span class="drag-handle">\u22ee\u22ee</span>
                    <span class="commande-id">${escapeHtml(cmd.id)}</span>
                    <span class="commande-client">${escapeHtml(cmd.client)}</span>
                </div>
                <div class="commande-info-semaine">
                    <div class="info-row">
                        <span>Ref: ${escapeHtml(cmd.refCdeClient || '-')}</span>
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

    // Init drag & drop for command cards
    document.querySelectorAll('.draggable-commande').forEach(card => {
        card.addEventListener('dragstart', handleCommandeDragStart);
        card.addEventListener('dragend', handleDragEnd);
    });

    attachDesaffectZoneHandlers();

    function attachDesaffectZoneHandlers() {
        const zone = document.getElementById('dropzoneDesaffect');
        if (!zone) return;
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('drag-over');
        });
        zone.addEventListener('dragleave', (e) => {
            e.currentTarget.classList.remove('drag-over');
        });
        zone.addEventListener('drop', handleDesaffectationDrop);
    }
}

// ===================================
// Vue Journée — opérations affectées à la semaine
// ===================================

/**
 * Sidebar for day view: operations assigned to selected week, grouped by command.
 * @param {string} searchQuery
 */
export function renderSidebarVueJournee(searchQuery = '') {
    const container = document.getElementById('unplacedOrdersContainer');
    const operationsData = getOperationsAffecteesSemaine(State.semaineSelectionnee, State.anneeSelectionnee);

    // Sort by urgency
    operationsData.sort((a, b) => {
        const dateA = a.commande.dateLivraison ? new Date(a.commande.dateLivraison) : new Date(8640000000000000);
        const dateB = b.commande.dateLivraison ? new Date(b.commande.dateLivraison) : new Date(8640000000000000);
        return dateA - dateB;
    });

    // Search filter
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
                Aucune op\u00e9ration affect\u00e9e \u00e0 S${State.semaineSelectionnee}
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
                <p>Aucun r\u00e9sultat pour <span class="search-term">"${escapeHtml(searchQuery)}"</span></p>
            </div>
        `;
        return;
    }

    // Group by command
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
        const daysUntil = Math.ceil((new Date(cmd.dateLivraison) - new Date()) / (1000 * 60 * 60 * 24));

        let operationsHtml = '';
        group.operations.forEach(op => {
            const typeClass = op.type.toLowerCase().replace('\u00e7', 'c').replace('\u00e9', 'e');
            // TODO: importer hasTimeOverride depuis un module dédié
            const hasOverride = op.dureeOverride !== null && op.dureeOverride !== undefined;
            const originalDuration = op.dureeOriginal || op.dureeTotal;

            operationsHtml += `
                <div class="operation-item-sidebar ${typeClass} draggable-from-sidebar ${hasOverride ? 'has-override' : ''}"
                     draggable="true"
                     data-commande-id="${cmd.id}"
                     data-operation-type="${op.type}"
                     data-operation-duration="${op.dureeTotal}"
                     data-sidebar-operation='${JSON.stringify({ commandeId: cmd.id, operationType: op.type, duration: op.dureeTotal, fromSidebar: true }).replace(/'/g, "&#39;")}'>
                    <div class="op-icon">\u22ee\u22ee</div>
                    <div class="op-info">
                        <div class="op-type">
                            ${escapeHtml(op.type)}
                            <span style="font-weight:normal; font-size:0.85em; color:#6c757d; margin-left:4px;">
                                (${escapeHtml(cmd.client)})
                            </span>
                        </div>
                        <div class="op-duration ${hasOverride ? 'overridden' : ''}"
                             onclick="event.stopPropagation(); showTimeEditPopup && showTimeEditPopup('${cmd.id}', '${op.type}', ${op.dureeTotal}, ${originalDuration}, this)"
                             title="${hasOverride ? 'Temps modifi\u00e9 (Original: ' + formatHours(originalDuration) + ')' : 'Cliquer pour modifier le temps'}">
                            ${formatHours(op.dureeTotal)}${hasOverride ? '<span class="override-indicator">*</span>' : ''}
                        </div>
                    </div>
                </div>
            `;
        });

        html += `
            <div class="commande-non-placee ${urgencyLevel}">
                <div class="commande-header">
                    <span class="commande-id">${escapeHtml(cmd.id)}</span>
                    <span class="commande-client">${escapeHtml(cmd.client)}</span>
                    <button class="btn-desaffecter" onclick="desaffecterCommande('${cmd.id}')" title="Retirer de la semaine ${State.semaineSelectionnee}">\u2715</button>
                </div>
                <div class="commande-details">
                    <div class="detail-item">
                        <strong>Ref:</strong> ${escapeHtml(cmd.refCdeClient || '-')}
                    </div>
                    <div class="detail-item">
                        <strong>Livraison:</strong> ${formatDate(cmd.dateLivraison)} (J-${daysUntil > 0 ? daysUntil : 0})
                        ${urgencyLevel === 'urgente' ? ' \u274c' : urgencyLevel === 'attention' ? ' \u26a0\ufe0f' : ' \u2713'}
                    </div>
                    <div class="detail-item">
                        <strong>Op\u00e9rations \u00e0 placer:</strong>
                        <div class="operations-list-sidebar">
                            ${operationsHtml}
                        </div>
                    </div>
                </div>
                <div class="commande-actions">
                    <button class="btn btn-sm btn-primary" onclick="placerAutomatiquement('${cmd.id}')">
                        Placer automatiquement
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="openPlanifierSemiAutoModal('${cmd.id}', ${State.semaineSelectionnee}, ${State.anneeSelectionnee})">
                        Planifier
                    </button>
                </div>
            </div>
        `;
    });

    if (html === '') {
        container.innerHTML = '<p class="no-orders">Aucune op\u00e9ration \u00e0 placer</p>';
    } else {
        container.innerHTML = html;

        // Init drag for sidebar operations
        document.querySelectorAll('.draggable-from-sidebar').forEach(op => {
            op.addEventListener('dragstart', handleSidebarDragStart);
            op.addEventListener('dragend', handleDragEnd);
        });
    }
}

// ===================================
// Compatibility alias
// ===================================

/**
 * Alias for renderSidebarContent (backward compatibility).
 * @param {string} searchQuery
 */
export function renderCommandesNonPlacees(searchQuery = '') {
    renderSidebarContent(searchQuery);
}

// ===================================
// Search helpers
// ===================================

/**
 * Filter commands by ID or client name.
 * @param {Array} commands
 * @param {string} searchQuery
 * @returns {Array}
 */
export function filterCommandesBySearch(commands, searchQuery) {
    if (!searchQuery || searchQuery.trim() === '') {
        return commands;
    }

    const query = searchQuery.toLowerCase().trim();

    return commands.filter(cmd => {
        const matchesId = cmd.id && cmd.id.toLowerCase().includes(query);
        const matchesClient = cmd.client && cmd.client.toLowerCase().includes(query);
        return matchesId || matchesClient;
    });
}

/**
 * Update search result count display.
 * @param {number} matchCount
 * @param {number} totalCount
 */
export function updateSearchResultCount(matchCount, totalCount) {
    const countElement = document.getElementById('searchResultCount');
    if (!countElement) return;

    if (matchCount === totalCount) {
        countElement.style.display = 'none';
    } else {
        countElement.style.display = 'block';
        countElement.textContent = `${matchCount} r\u00e9sultat${matchCount > 1 ? 's' : ''} sur ${totalCount}`;
    }
}

/**
 * Initialize sidebar search input with debounce.
 */
export function initializeSidebarSearch() {
    const searchInput = document.getElementById('sidebarSearchInput');
    const clearBtn = document.getElementById('clearSidebarSearch');

    if (!searchInput || !clearBtn) {
        console.warn('Sidebar search elements not found');
        return;
    }

    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value;

        clearBtn.style.display = query ? 'flex' : 'none';
        State.currentSearchQuery = query;

        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            renderCommandesNonPlacees(query);
        }, 150);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        State.currentSearchQuery = '';
        const countEl = document.getElementById('searchResultCount');
        if (countEl) countEl.style.display = 'none';
        renderCommandesNonPlacees('');
        searchInput.focus();
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            clearBtn.style.display = 'none';
            State.currentSearchQuery = '';
            const countEl = document.getElementById('searchResultCount');
            if (countEl) countEl.style.display = 'none';
            renderCommandesNonPlacees('');
        }
    });
}

// ===================================
// Global exposure
// ===================================

window.renderSidebarContent = renderSidebarContent;
window.renderCommandesNonPlacees = renderCommandesNonPlacees;

/**
 * @module machines
 * @description CRUD machines : chargement, sauvegarde,
 *              édition via modale, renommage, désaffectation.
 * @requires state.js, db.js, ui-list.js
 */

import { State, reloadMachineArrays, markAllCommandesDirty } from './state.js';
import { Toast } from './utils.js';
import { saveMachines, deleteSlotsByMachineName } from './db.js';
import { saveData } from './db.js';
import { refresh } from './ui-list.js';

// ===================================
// Local Supabase delete
// ===================================

async function deleteMachineFromSupabase(machineId) {
    if (!State.supabaseClient) return;
    try {
        await State.supabaseClient
            .from('machines')
            .delete()
            .eq('id', machineId);
        console.log(`✅ Machine ${machineId} supprimée de Supabase`);
    } catch (e) {
        console.error('❌ Erreur suppression machine Supabase:', e);
    }
}

// ===================================
// Save config
// ===================================

function saveMachinesConfig() {
    saveMachines(State.machinesConfig);
}

// ===================================
// Open / close modals
// ===================================

function openMachineManager() {
    const modal = document.getElementById('modalMachines');
    if (modal) {
        renderMachinesManager();
        modal.classList.add('active');
    }
}

function closeMachineManager() {
    const modal = document.getElementById('modalMachines');
    if (modal) {
        modal.classList.remove('active');
    }
}

// ===================================
// Render
// ===================================

export function renderMachinesManager() {
    const container = document.getElementById('machinesManagerContent');
    if (!container) return;

    const categories = [
        { key: 'cisaillage', label: 'Cisaillage', color: '#10b981' },
        { key: 'poinconnage', label: 'Poinçonnage', color: '#2563eb' },
        { key: 'pliage', label: 'Pliage', color: '#ef4444' }
    ];

    let html = '';

    categories.forEach(cat => {
        const machines = State.machinesConfig[cat.key] || [];
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

// ===================================
// Machine edit modal
// ===================================

function openMachineEdit(machineId, category) {
    const modal = document.getElementById('modalMachineEdit');
    const title = document.getElementById('machineEditTitle');
    const form = document.getElementById('formMachineEdit');
    const deleteBtn = document.getElementById('btnDeleteMachine');

    if (!modal || !form) return;

    form.reset();

    document.getElementById('machineEditId').value = machineId || '';
    document.getElementById('machineEditCategory').value = category;

    if (machineId) {
        title.textContent = 'Modifier la machine';
        deleteBtn.style.display = 'block';

        const machines = State.machinesConfig[category] || [];
        const machine = machines.find(m => m.id === machineId);

        if (machine) {
            document.getElementById('machineEditOriginalName').value = machine.name;
            document.getElementById('machineEditName').value = machine.name;
            document.getElementById('machineEditCapacity').value = machine.capacity;
            document.getElementById('machineEditColor').value = machine.color;
            document.getElementById('machineEditActive').value = machine.active ? 'true' : 'false';
        }
    } else {
        title.textContent = 'Ajouter une machine';
        deleteBtn.style.display = 'none';
        document.getElementById('machineEditOriginalName').value = '';

        const defaultColors = {
            cisaillage: '#10b981',
            poinconnage: '#2563eb',
            pliage: '#ef4444'
        };
        document.getElementById('machineEditColor').value = defaultColors[category] || '#10b981';
    }

    modal.classList.add('active');
}

function closeMachineEdit() {
    const modal = document.getElementById('modalMachineEdit');
    if (modal) {
        modal.classList.remove('active');
    }
}

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

    const machines = State.machinesConfig[category];
    if (!machines) {
        Toast.error('Catégorie invalide');
        return;
    }

    // Fix 1: bloquer si le nom est déjà pris par une autre machine (toutes catégories)
    const allMachines = [
        ...(State.machinesConfig.cisaillage || []),
        ...(State.machinesConfig.poinconnage || []),
        ...(State.machinesConfig.pliage || [])
    ];
    const nameTaken = allMachines.some(m => m.id !== machineId && m.name.trim().toLowerCase() === name.toLowerCase());
    if (nameTaken) {
        Toast.error(`Ce nom de machine existe déjà : "${name}"`);
        return;
    }

    if (machineId) {
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

            if (oldName !== name) {
                updateOperationsMachineName(oldName, name);
            }

            if (wasActive && !active) {
                unassignOperationsFromMachine(oldName);
            }

            Toast.success('Machine modifiée avec succès');
        }
    } else {
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

async function deleteMachine() {
    const machineId = document.getElementById('machineEditId').value;
    const category = document.getElementById('machineEditCategory').value;
    const machineName = document.getElementById('machineEditName').value;

    if (!machineId || !category) return;

    const hasPlannedOps = State.commandes.some(cmd =>
        cmd.operations?.some(op =>
            op.slots?.some(slot => slot.machine === machineName)
        )
    );

    // Fix 2: message de confirmation incluant la suppression des créneaux
    let confirmMessage = `Supprimer la machine "${machineName}" ?`;
    if (hasPlannedOps) {
        confirmMessage = `Supprimer la machine "${machineName}" supprimera aussi tous ses créneaux planifiés.\n\nConfirmer ?`;
    }

    if (!confirm(confirmMessage)) return;

    const machines = State.machinesConfig[category];
    const index = machines.findIndex(m => m.id === machineId);

    if (index !== -1) {
        // Fix 2: supprimer les slots Supabase d'abord — bloquer si échec
        if (hasPlannedOps) {
            const slotsDeleted = await deleteSlotsByMachineName(machineName);
            if (!slotsDeleted) {
                Toast.error('Erreur lors de la suppression des créneaux. Machine non supprimée.');
                return;
            }
        }

        // Nettoyer State en mémoire
        if (hasPlannedOps) {
            unassignOperationsFromMachine(machineName);
        }

        // Supprimer la machine en Supabase puis dans State
        await deleteMachineFromSupabase(machineId);
        machines.splice(index, 1);

        saveMachinesConfig();
        reloadMachineArrays();
        closeMachineEdit();
        renderMachinesManager();
        refresh();
        Toast.success('Machine supprimée');
    }
}

// ===================================
// Machine name update / unassign
// ===================================

function updateOperationsMachineName(oldName, newName) {
    let updated = 0;
    State.commandes.forEach(cmd => {
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
        markAllCommandesDirty();
    }
}

function unassignOperationsFromMachine(machineName) {
    let commandesAffectees = 0;
    let operationsDesaffectees = 0;

    State.commandes.forEach(cmd => {
        const hasOpOnMachine = cmd.operations?.some(op =>
            op.slots?.some(slot => slot.machine === machineName)
        );

        if (!hasOpOnMachine) return;

        commandesAffectees++;

        if (!cmd.semaineAffectee) {
            for (const op of cmd.operations || []) {
                if (op.slots && op.slots.length > 0 && op.slots[0].semaine) {
                    cmd.semaineAffectee = op.slots[0].semaine;
                    break;
                }
            }
        }

        cmd.operations?.forEach(op => {
            if (op.slots && op.slots.length > 0) {
                op.slots = [];
                operationsDesaffectees++;
            }
        });

        if (cmd.statut === 'Planifiée') {
            cmd.statut = 'En attente';
        }
    });

    if (commandesAffectees > 0) {
        markAllCommandesDirty();
        Toast.warning(`${commandesAffectees} commande(s) désaffectée(s) (${operationsDesaffectees} opérations)`);
    }
}

// ===================================
// Reset / Export
// ===================================

function resetMachinesConfig() {
    if (!confirm('Êtes-vous sûr de vouloir réinitialiser la configuration des machines ?\n\nCela restaurera les machines par défaut.')) {
        return;
    }

    State.machinesConfig = JSON.parse(JSON.stringify(window.MACHINES_CONFIG || {}));
    reloadMachineArrays();
    renderMachinesManager();
    refresh();
    Toast.success('Configuration réinitialisée');
}

function exportMachinesConfig() {
    const dataStr = JSON.stringify(State.machinesConfig, null, 2);
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

// ===================================
// Event handlers init
// ===================================

export function initMachineManagerHandlers() {
    document.getElementById('btnManageMachines')?.addEventListener('click', openMachineManager);

    document.getElementById('btnCloseMachines')?.addEventListener('click', closeMachineManager);
    document.getElementById('btnCloseMachinesBottom')?.addEventListener('click', closeMachineManager);

    document.getElementById('btnResetMachines')?.addEventListener('click', resetMachinesConfig);
    document.getElementById('btnExportMachines')?.addEventListener('click', exportMachinesConfig);

    document.getElementById('btnCloseMachineEdit')?.addEventListener('click', closeMachineEdit);
    document.getElementById('btnCancelMachineEdit')?.addEventListener('click', closeMachineEdit);

    document.getElementById('btnDeleteMachine')?.addEventListener('click', deleteMachine);

    document.getElementById('formMachineEdit')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveMachineEdit();
    });

    document.getElementById('modalMachines')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalMachines') closeMachineManager();
    });

    document.getElementById('modalMachineEdit')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalMachineEdit') closeMachineEdit();
    });
}

// ===================================
// Window exports for onclick in HTML
// ===================================
window.openMachineEdit = openMachineEdit;
window.closeMachineEdit = closeMachineEdit;

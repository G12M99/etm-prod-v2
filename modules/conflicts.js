/**
 * @module conflicts
 * @description Détection et résolution des conflits de slots
 *              multi-utilisateurs via modale Promise-based.
 * @requires state.js, realtime.js, db.js
 */

import { State } from './state.js';
import { Toast } from './utils.js';
import { refreshUIOnly } from './realtime.js';

// ===================================
// Local state
// ===================================
let conflictResolveCallback = null;

// ===================================
// Conflict detection
// ===================================

/**
 * Vérifie si un slot a été modifié par un autre utilisateur.
 * Compare le timestamp local avec celui en base.
 * @param {string} slotId - ID du slot
 * @param {string} localUpdatedAt - Timestamp local connu (ISO string)
 * @returns {Promise<{hasConflict: boolean, remoteData: object|null}>}
 */
export async function checkSlotConflict(slotId, localUpdatedAt) {
    if (!State.supabaseClient) return { hasConflict: false, remoteData: null };

    try {
        const { data, error } = await State.supabaseClient
            .from('slots')
            .select('*')
            .eq('id', slotId)
            .single();

        if (error || !data) return { hasConflict: false, remoteData: null };

        if (!localUpdatedAt) return { hasConflict: false, remoteData: data };

        const remoteTime = new Date(data.updated_at).getTime();
        const localTime = new Date(localUpdatedAt).getTime();

        const hasConflict = remoteTime > localTime + 2000;

        return { hasConflict, remoteData: data };

    } catch (e) {
        console.error('Erreur vérification conflit:', e);
        return { hasConflict: false, remoteData: null };
    }
}

/**
 * Sauvegarde un slot avec détection de conflit.
 * Si conflit détecté, demande confirmation à l'utilisateur.
 */
export async function saveSlotWithConflictCheck(slot, operationId) {
    if (!State.supabaseClient) {
        // Mode offline — pas de check possible
        return true;
    }

    const { hasConflict, remoteData } = await checkSlotConflict(slot.id, slot._lastSyncedAt);

    if (hasConflict && remoteData) {
        const userChoice = await showConflictModal(slot, remoteData);

        if (userChoice === 'keep-mine') {
            console.log('⚠️ Conflit résolu: données locales conservées');
        } else if (userChoice === 'keep-remote') {
            applyRemoteSlotToLocal(remoteData, operationId);
            Toast.info('Modification annulée - données distantes appliquées');
            return false;
        } else {
            return false;
        }
    }

    return true;
}

// ===================================
// Conflict modal (Promise-based)
// ===================================

/**
 * Affiche le modal de conflit et attend la décision de l'utilisateur.
 * @returns {Promise<'keep-mine'|'keep-remote'|'cancel'>}
 */
export function showConflictModal(localSlot, remoteSlot) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modalConflict');
        if (!modal) {
            console.warn('Modal conflit non trouvé dans le DOM');
            resolve('keep-mine');
            return;
        }

        document.getElementById('conflictLocalData').innerHTML = `
            Machine: <strong>${localSlot.machine || 'N/A'}</strong><br>
            Jour: ${localSlot.jour || 'N/A'}<br>
            Horaire: ${localSlot.heureDebut || '?'} - ${localSlot.heureFin || '?'}
        `;

        document.getElementById('conflictRemoteData').innerHTML = `
            Machine: <strong>${remoteSlot.machine_name || 'N/A'}</strong><br>
            Jour: ${remoteSlot.jour || 'N/A'}<br>
            Horaire: ${remoteSlot.heure_debut || '?'} - ${remoteSlot.heure_fin || '?'}
        `;

        conflictResolveCallback = resolve;
        modal.classList.add('active');
    });
}

/**
 * Ferme la modale de conflit et résout avec 'cancel'.
 */
export function closeConflictModal() {
    const modal = document.getElementById('modalConflict');
    if (modal) modal.classList.remove('active');
    if (conflictResolveCallback) {
        conflictResolveCallback('cancel');
        conflictResolveCallback = null;
    }
}

/**
 * Résout le conflit avec le choix de l'utilisateur et ferme la modale.
 */
export function resolveConflict(choice) {
    const modal = document.getElementById('modalConflict');
    if (modal) modal.classList.remove('active');
    if (conflictResolveCallback) {
        conflictResolveCallback(choice);
        conflictResolveCallback = null;
    }
}

/**
 * Applique les données d'un slot distant au slot local.
 */
export function applyRemoteSlotToLocal(remoteSlot, operationId) {
    for (const cmd of State.commandes) {
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
                refreshUIOnly();
                return;
            }
        }
    }
}

// ===================================
// Window exports for onclick in HTML
// ===================================
window.closeConflictModal = closeConflictModal;
window.resolveConflict = resolveConflict;

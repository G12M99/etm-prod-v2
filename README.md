# ETM PROD - Planning de Production

> Outil de planification de production pour atelier de pliage industriel (Aluminium/Galvanisé)

![Status](https://img.shields.io/badge/Status-Production-brightgreen)
![Version](https://img.shields.io/badge/Version-3.21-blue)
![License](https://img.shields.io/badge/License-Proprietary-red)

## Présentation

**ETM PROD** est une application de planification de production pour un atelier de pliage industriel. Elle offre une gestion complète des commandes avec vue semaine/journée/liste, drag & drop, calcul automatique par poids, gestion des urgences et synchronisation Google Sheets.

### Parc machines

- **2 Cisailles** : Cisaille A, Cisaille B
- **2 Poinçonneuses** : Poinçonneuse M, Poinçonneuse T
- **3 Plieuses** : Plieuse Lo, Plieuse Mik, Plieuse Mok

### Capacité de production

| Jour | Horaires | Heures |
|------|----------|--------|
| Lundi - Jeudi | 07h30-16h30 (pause 12h30-13h00) | 8.5h |
| Vendredi | 07h00-12h00 | 5h |
| **Total hebdomadaire** | | **39h** |

### Heures supplémentaires disponibles

| Jour | Créneau | Max |
|------|---------|-----|
| Lundi - Jeudi | 16h30-18h00 | 1.5h |
| Vendredi | 12h00-14h00 | 2h |
| **Limite** | Par machine | 10h/semaine |

## Les 3 Vues

### Vue Semaine

Planning global sur 3 semaines glissantes :
- **Jauge de capacité par cellule** (semaine × machine)
- Couleurs : vert (0-75%), orange (76-95%), rouge (96%+)
- Badges de commandes cliquables
- Affichage maintenance/fermetures
- Clic sur une cellule → bascule en Vue Journée

### Vue Journée

Planning détaillé heure par heure :
- Timeline complète 07h-18h
- Affichage pause déjeuner (zone grisée)
- **Ligne rouge temps réel** (heure actuelle)
- Séparateur heures supplémentaires
- **Drag & Drop** des opérations entre machines/jours
- Indicateurs de dépassement de capacité
- Affichage événements système

### Vue Liste

Tableau récapitulatif des commandes :
- **Tri dynamique** par colonnes (N°, Client, Date, Matériau, Statut, Progression)
- Tri bidirectionnel (asc/desc)
- **Recherche rapide** dans la liste
- Colonne progression production (%)
- Boutons détails et retrait de placement

## Gestion des Commandes

### Création

1. Cliquez sur **"+ Nouvelle commande"**
2. Remplissez : N° Commande, Client, Date livraison, Ressource
3. Sélectionnez le matériau et le poids (kg)
4. Les durées sont **calculées automatiquement**
5. La commande apparaît dans "Commandes à placer"

### Calcul automatique des durées

| Opération | Coefficient | Exemple (150kg) |
|-----------|-------------|-----------------|
| Cisaillage | 0.02h/kg | 3h |
| Poinçonnage | 0.015h/kg | 2.25h |
| Pliage | 0.025h/kg | 3.75h |

### Statuts

- **En cours** : Production en cours
- **Planifiée** : Placée dans le planning
- **Non placée** : En attente de planification
- **En prépa** : En préparation
- **Terminée** / **Livrée** : Masquées automatiquement

## Sidebar - Commandes à Placer

Liste des commandes non planifiées avec :

**Recherche en temps réel :**
- Filtre par N° commande et nom client
- Debounce 150ms pour performance
- Compteur de résultats
- Touche Escape pour effacer

**Code couleur urgence :**
- Vert : Livraison > 10 jours
- Orange : Livraison 5-10 jours
- Rouge : Livraison < 5 jours (URGENT)

**Actions :**
- Placer automatiquement
- Voir détails
- Drag & Drop vers le planning

## Placement des Commandes

### Placement automatique simple

Bouton "Placer automatiquement" :
- Cherche les premiers créneaux disponibles
- Respecte l'ordre : Cisaillage → Poinçonnage → Pliage
- Remplit les machines par charge

### Insertion d'urgence (Scénarios)

Modal workflow en 3 étapes pour les commandes urgentes :

**Scénario SMART :**
- Déplace intelligemment les commandes moins urgentes
- Calcul d'impact (opérations déplacées)
- Mode NORMAL ou FORCE selon urgence
- Minimise les perturbations

**Scénario PRIO (Prioritaire) :**
- Utilise les heures supplémentaires
- Confirmation obligatoire (3 checkboxes) :
  - Opérateurs disponibles
  - Pas de maintenance prévue
  - Autorisation manager
- Créneaux overtime : 16h30-18h00 (lun-jeu), 12h00-14h00 (ven)

## Drag & Drop

En Vue Journée uniquement :
1. **Cliquez et maintenez** sur une opération
2. **Glissez** vers la cellule machine/jour souhaitée
3. **Relâchez** : l'opération est déplacée
4. Les dates sont recalculées automatiquement
5. Contraintes vérifiées (ordre des opérations)

## Événements Système

### Maintenance & Fermetures

Modal dédié pour gérer :
- **Maintenance machine** : Bloque une machine spécifique
- **Fermeture usine** : Bloque toutes les machines

Configuration :
- Dates début/fin
- Heures début/fin
- Option "Dernier jour complet"
- Raison (optionnel)

Affichage :
- Badges spéciaux en Vue Semaine
- Blocs colorés en Vue Journée
- Liste des événements actifs avec edit/delete

## Synchronisation

### DataSyncManager

Stratégie hybride :
1. **Chargement local immédiat** (localStorage)
2. **Sync Google Sheets** en arrière-plan
3. **Auto-sync** toutes les 5 minutes

**Indicateurs de statut :**
- Synced : Données synchronisées
- Offline : Mode local uniquement
- Syncing : En cours de synchronisation
- Error : Erreur de sync

**Bouton sync manuel** disponible en header.

### Stockage local

- Données principales : `etm_commandes_v2`
- Sauvegarde : `etm_commandes_backup`
- Événements système : `etm_system_events`

## Import / Export / Impression

### Export

- Bouton "Exporter les données"
- Format JSON complet
- Téléchargement `etm_commandes_export.json`

### Import

- Bouton "Importer les données"
- Accepte fichiers JSON
- Merge intelligent avec données existantes

### Impression

- Modal de configuration
- Sélection de la semaine
- Format : Vue Semaine ou Vue Détaillée
- CSS optimisé pour impression

## Installation

### Prérequis

- Navigateur web moderne (Chrome, Firefox, Safari, Edge)
- Aucune dépendance externe

### Démarrage

```bash
cd "c:\Users\thexv\Desktop\ETM Prod"
start index.html  # Windows
```

## Structure du projet

```
ETM Prod/
├── index.html          # Interface principale
├── styles.css          # Styles (2785 lignes)
├── app.js              # Logique applicative (7698 lignes)
└── README.md           # Documentation
```

## Technologies

- **HTML5** : Structure + Drag & Drop API native
- **CSS3** : Grid, Flexbox, Variables CSS, Animations
- **JavaScript ES6+** : Classes, Async/Await, Modules
- **Google Fonts** : Police Inter
- **Aucun framework** : Application vanilla

## Raccourcis et astuces

- **Escape** : Efface la recherche sidebar
- **Clic hors modal** : Ferme le modal
- **Clic sur cellule semaine** : Ouvre la vue journée
- **Tri colonnes** : Clic sur en-tête (Vue Liste)

## Changelog

### Version 3.21 (Janvier 2026)
- Jauge de capacité par cellule (Vue Semaine)
- Amélioration affichage charge machine

### Version 3.20 (Janvier 2026)
- Modification système maintenance et fermeture
- Gestion des heures supplémentaires améliorée
- Renommage Poinçonneuses M/T

### Version 3.19 (Janvier 2026)
- Système de recherche sidebar (debounce, XSS protection)
- Compteur de résultats
- Support touche Escape

### Version 3.x (2025-2026)
- Vue Liste avec tri dynamique
- Scénarios SMART/PRIO pour urgences
- Heures supplémentaires avec tracker
- Événements système (maintenance/fermeture)
- Synchronisation Google Sheets
- Import/Export données
- Impression planning
- Toast notifications
- Indicateur statut sync

### Version 2.0.0 (Décembre 2025)
- Vue Semaine / Vue Journée
- Drag & Drop des opérations
- Calcul automatique par poids
- Sidebar commandes non placées
- Jauges de capacité colorées
- Placement automatique

### Version 1.0.0 (Décembre 2025)
- Première version
- Planning Gantt 3 semaines

---

**Version** : 3.21
**Statut** : Production
**Date** : Janvier 2026

---

Développé pour ETM PROD

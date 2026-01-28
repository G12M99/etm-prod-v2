# ETM PROD V2 — Planning de Production

> Outil de planification de production pour atelier de tôlerie industriel (Aluminium/Galvanisé) avec synchronisation temps réel multi-utilisateurs via Supabase.

![Status](https://img.shields.io/badge/Status-Production-brightgreen)
![Version](https://img.shields.io/badge/Version-3.22-blue)
![License](https://img.shields.io/badge/License-Proprietary-red)

## Présentation

**ETM PROD V2** est une application de planification de production pour un atelier de tôlerie (industrie fenêtres/portes). Elle gère le planning de 7 machines sur 3 opérations séquentielles obligatoires : **Cisaillage → Poinçonnage → Pliage**.

### Utilisateurs

| Utilisateur | Rôle | Usage |
|-------------|------|-------|
| Patrick | Planning hebdomadaire | Vue Semaine, affectation |
| Pierre | Planning journalier | Vue Journée, drag & drop |
| Magali | Saisie commandes | Google Sheets (source) |

### Stack technique

| Couche | Technologie |
|--------|------------|
| Frontend | HTML5 + CSS3 + JavaScript ES6+ (vanilla, aucun framework) |
| Backend | Supabase (PostgreSQL + Realtime WebSockets) |
| Source de données | Google Sheets → Apps Script → Supabase (sync auto 5 min) |
| Cache local | localStorage (mode hors ligne) |
| Hébergement | Netlify |

---

## Parc machines

| Type | Machines | Opération |
|------|----------|-----------|
| **Cisailles** | Cisaille A, Cisaille B | Cisaillage |
| **Poinçonneuses** | Poinçonneuse M, Poinçonneuse T | Poinçonnage |
| **Plieuses** | Plieuse Lo, Plieuse Mik, Plieuse Mok | Pliage |

### Capacité de production

| Jour | Horaires | Heures |
|------|----------|--------|
| Lundi - Jeudi | 07h30-16h30 (pause 12h30-13h00) | 8.5h |
| Vendredi | 07h00-12h00 | 5h |
| **Total hebdomadaire** | | **39h** |

### Heures supplémentaires

| Jour | Créneau | Max |
|------|---------|-----|
| Lundi - Jeudi | 16h30-18h00 | 1.5h |
| Vendredi | 12h00-14h00 | 2h |
| **Limite hebdomadaire** | | **10h** |

---

## Les 3 Vues

### Vue 3 semaines

Planning global sur 3+ semaines glissantes :
- Jauge de capacité par cellule (semaine x machine) avec code couleur
- Badges de commandes cliquables
- Affectation par drag & drop des commandes aux semaines
- Affichage maintenance/fermetures
- Clic sur cellule → bascule en Vue Journée

### Vue semaine

Planning détaillé heure par heure :
- Timeline complète 07h-18h par machine
- Pause déjeuner (zone grisée 12h30-13h00)
- Ligne rouge temps réel (heure actuelle)
- Séparateur heures supplémentaires
- **Drag & Drop** des opérations entre machines/jours
- Indicateurs de dépassement de capacité
- Événements système (maintenance, fermetures)
- Synchronisation temps réel entre utilisateurs

### Vue Liste

Tableau récapitulatif des commandes :
- Tri dynamique par colonnes (N°, Client, Date, Matériau, Statut, Progression)
- Recherche rapide
- Boutons détails et retrait de placement

---

## Sidebar — Commandes à Placer

**Recherche en temps réel :**
- Filtre par N° commande et nom client
- Debounce 150ms
- Compteur de résultats
- Touche Escape pour effacer

**Code couleur urgence :**
- Vert : Livraison > 10 jours
- Orange : Livraison 5-10 jours
- Rouge : Livraison < 5 jours (URGENT)

**Actions :**
- Placer automatiquement
- Placement semi-automatique (choix machine/jour)
- Voir détails
- Drag & Drop vers le planning

---

## Placement des Commandes

### Placement automatique

Bouton "Placer automatiquement" :
- Cherche les premiers créneaux disponibles
- Respecte l'ordre strict : Cisaillage → Poinçonnage → Pliage
- Équilibrage de charge entre machines similaires
- Gestion des scissions (opération sur plusieurs jours)

### Placement semi-automatique

Modal en 2 étapes :
1. Sélection machine + jour + créneau pour chaque opération
2. Confirmation avec récapitulatif visuel

### Insertion d'urgence

Modal workflow pour les commandes urgentes :

**Scénario SMART :** Déplace intelligemment les commandes moins urgentes avec calcul d'impact et minimisation des perturbations.

**Scénario PRIO :** Utilise les heures supplémentaires avec confirmation obligatoire (opérateurs disponibles, pas de maintenance, autorisation manager).

### Drag & Drop

En Vue Journée :
1. Cliquez et maintenez sur une opération
2. Glissez vers la cellule machine/jour souhaitée
3. Relâchez — l'opération est déplacée
4. Dates recalculées automatiquement
5. Contraintes chronologiques vérifiées
6. **Synchronisation immédiate** vers les autres utilisateurs

---

## Synchronisation Temps Réel

### Architecture

```
Google Sheets (Magali)
       │
       ▼  [Apps Script, toutes les 5 min]
Supabase PostgreSQL
       │                    ▲
       ▼  [WebSocket]      │  [Upsert immédiat]
ETM PROD (navigateur) ─────┘
       │
       ▼  [Backup]
localStorage
```

### Multi-utilisateurs

- Les modifications (drag & drop, placement, suppression) apparaissent sur tous les postes en **~1.2 secondes**
- Indicateur visuel "Temps réel actif" (vert) / "Déconnecté" (orange)
- 10 canaux WebSocket actifs (commandes, opérations, slots, machines, etc.)
- Protection anti-écho : les changements locaux ne sont pas retraités

### Mode hors ligne

- Si Supabase est indisponible, l'app fonctionne en mode localStorage
- Indicateur "Offline" dans le header
- Sync automatique à la reconnexion

---

## Gestion des Configurations

### Gestionnaire de Machines

- Ajout / modification / suppression de machines
- Changement de nom, couleur, capacité
- Renommage automatique dans toutes les opérations existantes

### Gestionnaire d'Horaires

- Configuration des équipes (shifts) par jour
- Gestion des pauses (déjeuner, autres)
- Activation/désactivation des heures supplémentaires
- Recalcul automatique des capacités

### Événements Système

- **Maintenance machine** : Bloque une machine spécifique
- **Fermeture usine** : Bloque toutes les machines
- Configuration dates/heures, multi-jours
- Impact automatique sur les calculs de capacité

---

## Calcul automatique des durées

| Opération | Coefficient | Exemple (150kg) |
|-----------|-------------|-----------------|
| Cisaillage | 0.02h/kg | 3h |
| Poinçonnage | 0.015h/kg | 2.25h |
| Pliage | 0.025h/kg | 3.75h |

Les durées proviennent principalement de Google Sheets (format HH:MM:SS). Le calcul par poids sert de fallback.

### Override de durée

Les durées peuvent être modifiées manuellement par opération avec historique de l'override (qui, quand, valeur originale).

---

## Statuts des Commandes

| Statut | Description | Visible |
|--------|-------------|---------|
| En prépa | En préparation, pas encore planifiée | Sidebar |
| Non placée | En attente de placement | Sidebar |
| En cours | Production en cours | Planning + Sidebar |
| Planifiée | Toutes les opérations placées | Planning |
| Terminée | Production terminée | Masquée |
| Livrée | Commande livrée | Masquée |

---

## Import / Export / Impression

### Export
- Format JSON complet
- Téléchargement `etm_commandes_export.json`

### Import
- Accepte fichiers JSON
- Merge intelligent avec données existantes

### Impression
- Modal de configuration (semaine, format)
- Vue Semaine ou Vue Détaillée
- CSS optimisé pour impression

---

## Structure du Projet

```
ETM Prod/                           (18,073 lignes)
├── index.html          (770 lignes)   # Interface principale + modals
├── styles.css          (4,329 lignes) # Styles CSS (Grid, Flexbox, print)
├── app.js              (12,406 lignes)# Toute la logique applicative
├── supabase.js         (568 lignes)   # Module Supabase (CRUD + Realtime)
├── CLAUDE.md                          # Référence technique pour Claude Code
├── README.md                          # Ce fichier
└── GEMINI.md                          # Guide Gemini
```

---

## Installation

### Prérequis

- Navigateur web moderne (Chrome, Firefox, Safari, Edge)
- Connexion internet (pour Supabase Realtime)
- Aucune dépendance à installer

### Démarrage

```bash
# Windows
start index.html

# Ou ouvrir index.html dans un navigateur
```

### Configuration Supabase

L'application se connecte automatiquement à Supabase avec les clés intégrées. Pour une nouvelle instance :

1. Créer un projet Supabase
2. Exécuter le schéma SQL (15 tables)
3. Activer Realtime sur : commandes, operations, slots, machines, system_events, shifts, shift_schedules, breaks, overtime_config, overtime_slots
4. Mettre à jour `SUPABASE_URL` et `SUPABASE_ANON_KEY` dans `app.js`

---

## Technologies

- **HTML5** : Structure + Drag & Drop API native
- **CSS3** : Grid, Flexbox, Variables CSS, Animations, Print styles
- **JavaScript ES6+** : Classes, Async/Await, Map/Set, Template literals
- **Supabase JS v2** : Client PostgreSQL + Realtime subscriptions
- **Google Fonts** : Police Inter
- **Aucun framework** : Application vanilla

---

## Raccourcis et astuces

| Raccourci | Action |
|-----------|--------|
| Escape | Efface la recherche sidebar |
| Clic hors modal | Ferme le modal |
| Clic cellule semaine | Ouvre la vue journée |
| Clic en-tête colonne | Tri (Vue Liste) |
| Drag badge commande | Affecte à une semaine |
| Drag vers zone retrait | Désaffecte la commande |

---

## Changelog

### Version 4.18 (Janvier 2026)
- Synchronisation Supabase Realtime bidirectionnelle
- Nettoyage des slots orphelins (SELECT+compare+DELETE)
- Sauvegarde immédiate pour drag & drop
- Debounce optimisé (2s → 500ms)
- IDs pour les slots fragmentés
- Protection anti-écho Realtime (fenêtre 5s)
- Dirty tracking (sync incrémentale)
- Indicateur visuel Realtime (connecté/déconnecté/erreur)
- Mode debug Realtime (REALTIME_DEBUG)

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
- Synchronisation Google Sheets → Supabase
- Import/Export données
- Impression planning
- Toast notifications
- Gestionnaire de machines et d'horaires
- Placement semi-automatique (modal 2 étapes)

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

## Base de données Supabase

### Tables principales

| Table | Description | Champs clés |
|-------|-------------|-------------|
| `commandes` | Commandes client | id, client_name, date_livraison, statut, poids |
| `operations` | 3 par commande | id, commande_id, type, duree_total, statut |
| `slots` | Créneaux planifiés | id, operation_id, machine_name, semaine, jour, heure_debut/fin |
| `machines` | Configuration machines | id, name, type, capacity, color, active |
| `system_events` | Maintenance/fermetures | id, type, machine, date_start/end |
| `shifts` | Équipes de travail | id, name, active |
| `shift_schedules` | Horaires par jour | shift_id, day_name, start_time, end_time |
| `breaks` | Pauses | id, name, start_time, end_time, days |
| `overtime_config` | Config heures sup | enabled, max_daily_hours, max_weekly_hours |
| `overtime_slots` | Créneaux heures sup | days, start_time, end_time |

### Synchronisation Google Sheets

| Colonne Sheet | Table.Champ Supabase |
|---------------|---------------------|
| Fin de Prod | commandes.date_livraison |
| Code cde | commandes.id |
| STATUT | commandes.statut |
| Client | commandes.client_name |
| Poids | commandes.poids |
| CISAILLE | operations.duree_total (Cisaillage) |
| POINCON | operations.duree_total (Poinçonnage) |
| PLIAGE | operations.duree_total (Pliage) |
| Réf cde client | commandes.ref_cde_client |

---

**Version** : 3.22
**Statut** : Production
**Date** : Janvier 2026

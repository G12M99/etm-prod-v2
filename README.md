# ETM PROD V2 - Planning de Production

> Outil avancé de planification de production pour atelier de pliage industriel (Aluminium/Galvanisé)

![ETM PROD V2](https://img.shields.io/badge/Status-Maquette%20V2-blue)
![Version](https://img.shields.io/badge/Version-2.0.0-green)
![License](https://img.shields.io/badge/License-Proprietary-red)

## Présentation

**ETM PROD V2** est une maquette interactive avancée de planification de production conçue pour un atelier de pliage industriel. Cette version 2 introduit des fonctionnalités majeures : vue semaine/journée, drag & drop, calcul automatique par poids, et gestion de commandes non placées.

### Parc machines

- **2 Cisailles** : Cisaille A, Cisaille B
- **2 Poinçonneuses** : Poinçonneuse A, Poinçonneuse B
- **3 Plieuses** : Plieuse Lo, Plieuse Mik, Plieuse Mok

### Capacité de production

- **Lundi à Jeudi** : 8.5h/jour (07h30-12h30 / 13h00-16h30)
- **Vendredi** : 5h (07h00-12h00)
- **Total hebdomadaire** : 39h

## Nouveautés V2

### Vue Semaine / Vue Journée

**Vue Semaine** : Planning global sur 3 semaines
- Visualisation rapide de la charge de toutes les machines
- Jauges de capacité colorées (vert/orange/rouge)
- Badges de commandes par semaine
- Clic sur une semaine pour basculer en vue journée

**Vue Journée** : Planning détaillé heure par heure
- Affichage des créneaux horaires (07h-15h ou 07h-12h)
- Plusieurs opérations par machine et par jour
- Indicateurs de dépassement de capacité
- **Drag & Drop** : Déplacez les opérations entre machines/jours

### Calcul automatique par poids de matériau

Les durées d'opérations sont calculées selon le poids du matériau :

| Opération | Temps par kg | Exemple (100kg) |
|-----------|--------------|-----------------|
| Cisaillage | 0.02h/kg | 2h |
| Poinçonnage | 0.015h/kg | 1.5h |
| Pliage | 0.025h/kg | 2.5h |

**Formule** : `Durée = Poids × Coefficient`

**Exemple** : Commande de 150kg Aluminium
- Cisaillage : 150kg × 0.02h/kg = **3h**
- Poinçonnage : 150kg × 0.015h/kg = **2.25h**
- Pliage : 150kg × 0.025h/kg = **3.75h**

### Commandes non placées

**Section latérale** affichant les commandes en attente de planification :
- **3 niveaux d'urgence** :
  - 🟢 Vert : Livraison > 10 jours
  - 🟡 Orange : Livraison 5-10 jours
  - 🔴 Rouge : Livraison < 5 jours (URGENT)
- Affichage du poids et des durées calculées
- **Placement automatique** : Algorithme cherchant les premiers créneaux disponibles
- Respect de l'ordre Cisaillage → Poinçonnage → Pliage

### Drag & Drop

**Dans la vue journée** :
- **Glisser-déposer** les opérations entre machines et jours
- Mise à jour automatique du planning
- Vérification des contraintes (pas de poinçonnage avant cisaillage)
- Feedback visuel pendant le déplacement

### Jauges de capacité

**Indicateurs visuels** de charge par machine :
- **Barre de progression** avec couleurs :
  - 🟢 0-75% : Vert (capacité ok)
  - 🟡 76-95% : Orange (proche saturation)
  - 🔴 96-100% : Rouge (saturé)
- Affichage `Xh/37h (Y%)`
- Calcul en temps réel

## Fonctionnalités

### Planning multi-commandes

- **Plusieurs commandes par machine/jour** : Optimisez l'utilisation
- **Découpage automatique** : Une opération peut s'étaler sur plusieurs jours
- **Slots temporels** : Système de créneaux horaires précis

### Gestion intelligente

1. **Ordre strict des opérations** : Cisaillage → Poinçonnage → Pliage (NON inversable)
2. **Filtrage automatique** : Affiche uniquement "En cours" et "Planifiée"
3. **Masquage** : Commandes "Terminée" et "Livrée" automatiquement cachées
4. **Alertes visuelles** : Dépassement de capacité, urgence livraison

### Interface moderne

- **2 vues complémentaires** : Semaine (global) et Journée (détail)
- **Sidebar dédiée** : Commandes non placées
- **Drag & Drop intuitif** : Déplacement visuel des opérations
- **Responsive** : Optimisé tablette 10"+
- **Temps réel** : Indicateur d'heure actuelle

## Installation

### Prérequis

- Navigateur web moderne (Chrome, Firefox, Safari, Edge)
- Aucune dépendance externe requise

### Démarrage

1. **Ouvrir** le fichier [index.html](index.html) dans votre navigateur

```bash
cd "c:\Users\thexv\Desktop\ETM Prod"
start index.html  # Windows
```

2. **C'est tout !** L'application se charge avec :
   - 4 commandes placées
   - 3 commandes non placées
   - 2 commandes masquées (terminées)

## Structure du projet

```
ETM Prod/
├── index.html          # Interface V2 (double vue + sidebar)
├── styles.css          # Styles V2 (jauges, drag&drop)
├── app.js              # Logique V2 (slots, calcul poids, drag&drop)
└── README.md           # Documentation V2
```

## Utilisation

### Navigation entre vues

**Boutons en header** :
- **Vue Semaine** : Planning global 3 semaines
- **Vue Journée** : Planning détaillé (cliquez aussi sur une semaine)

### Placement d'une commande non placée

1. Dans la **sidebar gauche**, trouvez la commande
2. **Option 1 - Automatique** :
   - Cliquez sur "Placer automatiquement"
   - L'algorithme trouve les premiers créneaux disponibles
   - Respecte l'ordre des opérations
3. **Option 2 - Manuel (à venir)** :
   - Drag & Drop depuis la sidebar vers le planning

### Déplacer une opération (Drag & Drop)

**En vue journée uniquement** :
1. **Cliquez et maintenez** sur une carte d'opération
2. **Glissez** vers la cellule jour/machine souhaitée
3. **Relâchez** : L'opération est déplacée
4. Les dates sont recalculées automatiquement

### Interpréter les jauges

**Vue Semaine - Jauges par machine** :
```
████████░░ 15.2h/37h (41%)
```
- Barre verte : Charge normale
- Barre orange : Proche saturation (>76%)
- Barre rouge : Saturée (>96%)

**Vue Journée - Total par jour** :
```
6.5h/8h ✓
8.5h/8h ❌ DÉPASSÉ
```
- ✓ : Dans la capacité
- ⚠️ : Proche du max (>90%)
- ❌ : Dépassement

## Données de démonstration

### Commandes placées

1. **CC25-1001** (SPEBI) - 150kg Aluminium
   - Cisaillage : 3h sur Cisaille A (Lun S50)
   - Poinçonnage : 2.25h sur Poinçonneuse A (Mar S50)
   - Pliage : 3.75h sur Plieuse Lo (Mer S50)

2. **CC25-1002** (BOUVET) - 200kg Galvanisé
   - Cisaillage : 4h découpé en 2 slots (Lun S50)
   - Poinçonnage : 3h (Mar S50)
   - Pliage : 5h (Lun S51)

3. **CC25-1003** (ALPAC) - 180kg Aluminium
   - Cisaillage : 3.6h (Mer S50)
   - Poinçonnage : 2.7h (Jeu S50)
   - Pliage : 4.5h (Ven S50)

4. **CC25-1004** (SOPREMA) - 120kg Galvanisé
   - Cisaillage : 2.4h (Mar S51)
   - Poinçonnage : 1.8h (Mer S51)
   - Pliage : 3h (Jeu S51)

### Commandes non placées

1. **CC25-1012** (SPEBI) - 250kg Aluminium - Livraison 25/12 ✓
   - Cisaillage : 5h | Poinçonnage : 3.75h | Pliage : 6.25h

2. **CC25-1013** (ALPAC) - 100kg Galvanisé - Livraison 20/12 ⚠️
   - Cisaillage : 2h | Poinçonnage : 1.5h | Pliage : 2.5h

3. **CC25-1014** (GCC HABITAT) - 300kg Aluminium - Livraison 15/12 ❌ URGENT
   - Cisaillage : 6h | Poinçonnage : 4.5h | Pliage : 7.5h

## Architecture V2

### Structure de données avec slots

```javascript
{
  id: "CC25-1001",
  client: "SPEBI",
  poids: 150, // kg
  materiau: "Aluminium",
  statut: "En cours", // En cours / Planifiée / Non placée
  operations: [
    {
      type: "Cisaillage",
      dureeTotal: 3, // Calculé: 150kg * 0.02h/kg
      slots: [ // Peut être découpé en plusieurs créneaux
        {
          machine: "Cisaille A",
          duree: 3,
          semaine: 50,
          jour: "Lundi",
          heureDebut: "07:00",
          heureFin: "10:00",
          dateDebut: "2025-12-09T07:00:00",
          dateFin: "2025-12-09T10:00:00"
        }
      ],
      progressionReelle: 75,
      statut: "En cours"
    }
    // ... autres opérations
  ]
}
```

### Calcul de durée

```javascript
// Coefficients par type d'opération
const DUREE_PAR_KG = {
    'Cisaillage': 0.02,
    'Poinçonnage': 0.015,
    'Pliage': 0.025
};

// Calcul
function calculerDureeOperation(type, poids) {
    return poids * DUREE_PAR_KG[type];
}

// Exemple : 150kg Aluminium
calculerDureeOperation('Cisaillage', 150)  // = 3h
calculerDureeOperation('Poinçonnage', 150) // = 2.25h
calculerDureeOperation('Pliage', 150)      // = 3.75h
```

### Algorithme de placement automatique

```javascript
function placerAutomatiquement(commande) {
  // Pour chaque opération (dans l'ordre)
  commande.operations.forEach((operation, index) => {

    // Trouver machines compatibles
    const machines = getMachinesForOperation(operation.type);

    // Chercher premier créneau disponible
    for (let week = 50; week <= 52; week++) {
      for (let day of DAYS_OF_WEEK) {
        for (let machine of machines) {

          const capacity = calculerCapaciteJour(machine, day, week);
          const available = capacity.capaciteJour - capacity.heuresUtilisees;

          if (available >= operation.dureeTotal) {
            // Placer ici !
            operation.slots.push({
              machine,
              duree: operation.dureeTotal,
              semaine: week,
              jour: day,
              heureDebut: "07:00",
              // ...
            });
            return; // Opération placée
          }
        }
      }
    }
  });
}
```

### Drag & Drop

```javascript
// Événements HTML5 Drag & Drop
function initDragAndDrop() {
  // Rendre les opérations draggables
  document.querySelectorAll('.operation-slot').forEach(slot => {
    slot.addEventListener('dragstart', handleDragStart);
    slot.addEventListener('dragend', handleDragEnd);
  });

  // Zones de drop
  document.querySelectorAll('.drop-zone').forEach(zone => {
    zone.addEventListener('dragover', handleDragOver);
    zone.addEventListener('drop', handleDrop);
  });
}

function handleDrop(e) {
  const targetMachine = e.target.dataset.machine;
  const targetDay = e.target.dataset.day;

  // Déplacer le slot
  slot.machine = targetMachine;
  slot.jour = targetDay;

  // Recalculer les dates
  updateSlotDates(slot);

  // Re-render
  refresh();
}
```

## Technologies utilisées

- **HTML5** : Structure + Drag & Drop API
- **CSS3** : Grid Layout + Flexbox + Variables CSS
- **JavaScript ES6+** : Modules, Arrow functions, Destructuring
- **Google Fonts** : Police Inter

### Caractéristiques techniques V2

- **Architecture MVC** : Séparation données/vue/contrôleur
- **Drag & Drop natif** : HTML5 API (pas de librairie)
- **Calcul dynamique** : Durées selon poids en temps réel
- **Responsive** : Mobile-first design
- **Performance** : Pas de dépendances lourdes
- **Accessible** : Clavier + lecteurs d'écran

## Prochaines étapes

### Phase 3 : Application production

1. **Backend complet** :
   - API REST (Node.js/Express)
   - Base de données PostgreSQL
   - Authentification JWT
   - WebSockets pour temps réel

2. **Frontend React** :
   - Migration vers React 18+
   - State management (Zustand ou Jotai)
   - Intégration DHTMLX Gantt Pro
   - PWA (offline-first)

3. **Fonctionnalités avancées** :
   - **Découpage manuel** : Interface de fractionnement d'opérations
   - **Optimisation automatique** : Algorithme de placement optimal
   - **Prévisions** : ML pour estimer les durées
   - **Historique** : Timeline des modifications
   - **Export** : PDF, Excel, iCal
   - **Notifications** : Email/SMS pour alertes urgence

4. **Intégrations** :
   - ERP existant
   - Système de gestion commerciale
   - Capteurs IoT sur machines
   - Tableaux de bord décisionnels

### Améliorations UX prévues

- **Drag & Drop avancé** :
  - Depuis sidebar vers planning
  - Multi-sélection d'opérations
  - Annuler/Refaire (Ctrl+Z)
- **Vues additionnelles** :
  - Vue Ressource (Polyvalent/Apprenti)
  - Vue Matériau (Alu/Galva)
  - Vue Gantt mensuelle
- **Filtres avancés** :
  - Par client
  - Par urgence
  - Par statut
- **Thème sombre**
- **Raccourcis clavier**

## Guide d'utilisation avancé

### Créer une nouvelle commande

1. Cliquez sur **"+ Nouvelle commande"**
2. Remplissez :
   - N° Commande (ex: CC25-1020)
   - Client
   - Date de livraison
   - Ressource (Polyvalent/Apprenti)
   - **Matériau** : Type + Poids (kg)
3. Les durées sont **calculées automatiquement**
4. Cliquez sur **"Créer la commande"**
5. La commande apparaît dans **"Commandes à placer"**
6. Utilisez **"Placer automatiquement"**

### Optimiser le planning

**Bonnes pratiques** :
1. **Placer les urgentes d'abord** (rouge)
2. **Équilibrer les machines** : Répartir la charge
3. **Éviter les dépassements** : Viser <90% par jour
4. **Grouper par client** : Facilite la production
5. **Anticiper les livraisons** : Buffer de 1-2 jours

**Exemple d'optimisation** :
```
Avant :
Cisaille A : 35h/37h (95%) ⚠️
Cisaille B : 10h/37h (27%) ✓

Action : Déplacer 2 opérations de A vers B

Après :
Cisaille A : 25h/37h (68%) ✓
Cisaille B : 20h/37h (54%) ✓
```

### Gérer les imprévus

**Panne machine** :
1. Vue Journée → Sélectionnez toutes les opérations de la machine
2. Drag & Drop vers machine alternative
3. Vérifier les dépassements

**Livraison urgente** :
1. Sidebar → Commande urgente → "Placer automatiquement"
2. Si pas de place : déplacer commandes moins urgentes
3. Vue Journée → Réorganiser manuellement

**Retard de production** :
1. Consulter la progression réelle (%)
2. Identifier les opérations en retard
3. Ajouter des créneaux supplémentaires

## Personnalisation

### Modifier les coefficients de durée

Éditer [app.js](app.js:30-34) :

```javascript
const DUREE_PAR_KG = {
    'Cisaillage': 0.02,    // Modifier ici
    'Poinçonnage': 0.015,
    'Pliage': 0.025
};
```

### Ajouter un type de matériau

[index.html](index.html:173-176) :

```html
<select id="orderMaterial">
    <option value="Aluminium">Aluminium</option>
    <option value="Galvanisé">Galvanisé</option>
    <option value="Inox">Inox</option> <!-- Nouveau -->
</select>
```

### Modifier les couleurs

[styles.css](styles.css:7-9) :

```css
:root {
    --color-cisaillage: #28a745;    /* Vert */
    --color-poinconnage: #fd7e14;   /* Orange */
    --color-pliage: #6f42c1;        /* Violet */
}
```

## FAQ

**Q : Les durées sont-elles modifiables manuellement ?**
R : Dans cette maquette V2, elles sont calculées automatiquement. La V3 permettra la saisie manuelle avec option de recalcul.

**Q : Peut-on placer une opération directement depuis la sidebar ?**
R : Pas encore. Utilisez "Placer automatiquement" puis ajustez en drag & drop.

**Q : Le drag & drop respecte-t-il l'ordre des opérations ?**
R : Oui, vous ne pouvez pas déplacer un poinçonnage avant le cisaillage correspondant.

**Q : Combien de commandes peut gérer l'application ?**
R : Cette maquette est optimisée pour ~50 commandes. La version React supportera des milliers.

**Q : Les données sont-elles sauvegardées ?**
R : Non, c'est une maquette en mémoire. La V3 aura une base de données.

## Support

Pour toute question :
- **Documentation** : Ce README.md
- **Code source** : Fichiers HTML/CSS/JS commentés
- **Démo** : Ouvrir [index.html](index.html)

## Changelog

### Version 2.0.0 (Décembre 2025)
- ✨ Vue Semaine / Vue Journée
- ✨ Drag & Drop des opérations
- ✨ Calcul automatique par poids
- ✨ Sidebar commandes non placées
- ✨ Jauges de capacité colorées
- ✨ Placement automatique
- ✨ Système de slots temporels
- ✨ Multi-commandes par jour/machine
- 🎨 Interface V2 moderne
- 📱 Responsive amélioré

### Version 1.0.0 (Décembre 2025)
- 🎉 Première version
- 📅 Planning Gantt 3 semaines
- 🎨 Code couleur opérations
- 📊 Indicateurs de charge
- 🔍 Filtrage automatique

---

**Version actuelle** : 2.0.0 (Maquette V2)
**Date** : Décembre 2025
**Statut** : Démonstration avancée

---

Développé avec soin pour ETM PROD

**ETM PROD V2** - L'avenir de la planification industrielle

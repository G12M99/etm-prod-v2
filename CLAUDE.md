# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ETM PROD V2** is a production planning application for an industrial sheet metal bending workshop (Aluminum/Galvanized steel). Built as a vanilla JavaScript prototype, it manages order scheduling across multiple machines with strict operational sequence requirements and integrates with Google Sheets for real-time data synchronization.

### Machine Park

- **2 Cisailles (Shears):** Cisaille A, Cisaille B
- **2 Poinçonneuses (Punching machines):** Poinçonneuse A, Poinçonneuse B
- **3 Plieuses (Bending machines):** Plieuse Lo, Plieuse Mik, Plieuse Mok

### Production Capacity

- **Monday-Thursday:** 8.5h/day (07:30-16:30 with 30min lunch break 12:30-13:00)
- **Friday:** 5h (07:00-12:00)
- **Total weekly:** 39h (8.5×4 + 5)
- **Overtime support:** Configurable in `CAPACITY_CONFIG.overtime` (app.js:52-59)
- **Overbooking allowed:** Up to 105% capacity with visual warnings (app.js:41-60)

### 🔒 CRITICAL BUSINESS RULE - CHRONOLOGICAL ORDER

The **most critical constraint** in this codebase is the **MANDATORY CHRONOLOGICAL ORDER** of operations:

```
Cisaillage (Shearing) → Poinçonnage (Punching) → Pliage (Bending)
```

This order is **NON-REVERSIBLE and STRICTLY ENFORCED**. Each operation must **COMPLETE** before the next one can **BEGIN**. This is validated throughout the codebase, particularly in:
- `validateOperationOrder()` - Ensures 3 operations exist in correct sequence
- `canPlaceOperation()` - Validates chronological timing when placing/moving operations
- Drag & drop handling - Prevents invalid moves in real-time

**NEVER allow operations to be placed out of chronological order in the planning schedule.**

## Running the Application

This is a static HTML/CSS/JS application with **no build process**:

```bash
# Open in browser (Windows)
start index.html

# Or simply open index.html in any modern browser
```

**No build, lint, or test commands** - this is a prototype application.

## Architecture

### File Structure

```
ETM Prod/
├── index.html          # Main UI structure with modals, views, and sidebar
├── styles.css          # Complete styling (CSS Grid, Flexbox, drag & drop)
├── app.js              # All application logic (~2500+ lines)
├── README.md           # Comprehensive documentation (French)
├── GEMINI.md           # Gemini-specific guidance
└── AI/
    └── .claude/
        ├── CLAUDE.md   # This file
        ├── settings.local.json
        └── agents/     # Specialized agent definitions
            ├── front.md
            ├── back.md
            ├── fullstack.md
            ├── manager.md
            └── Google Sheets Connector.md
```

**Single-page application:** All logic is in app.js, no modules or external dependencies except Google Fonts.

### Data Model

Commands follow a **slot-based system** where operations can be split across multiple time slots:

```javascript
{
  id: "CC25-1001",
  client: "SPEBI",
  poids: 150,              // Weight in kg
  materiau: "Aluminium",   // Material type
  statut: "En cours",      // Status: En cours / Planifiée / En prépa / Terminée / Livrée
  dateLivraison: "2025-12-20",
  operations: [
    {
      type: "Cisaillage",
      dureeTotal: 3,         // Total duration in hours (from Google Sheets or calculated)
      slots: [               // Can be split across multiple time slots
        {
          machine: "Cisaille A",
          duree: 3,          // Duration for this specific slot
          semaine: 50,       // ISO week number
          jour: "Lundi",     // Day name (French)
          heureDebut: "09:00",
          heureFin: "12:00",
          dateDebut: "2025-12-09T09:00:00",
          dateFin: "2025-12-09T12:00:00"
        }
      ],
      progressionReelle: 75,  // Actual progress percentage
      statut: "En cours"      // Operation status
    }
    // ... more operations (Poinçonnage, Pliage)
  ]
}
```

### Duration Calculation System

Operation durations can be **automatically calculated** based on material weight using coefficients (app.js:104-108):

```javascript
const DUREE_PAR_KG = {
    'Cisaillage': 0.02,      // 0.02h per kg
    'Poinçonnage': 0.015,    // 0.015h per kg
    'Pliage': 0.025          // 0.025h per kg
};
```

**Example:** 150kg Aluminium order:
- Cisaillage: 150kg × 0.02h/kg = 3h
- Poinçonnage: 150kg × 0.015h/kg = 2.25h
- Pliage: 150kg × 0.025h/kg = 3.75h

**However, the primary data source is Google Sheets**, which provides durations in HH:MM:SS format that are converted to decimal hours via `timeToDecimalHours()` (app.js:172-209). Use `calculerDureeOperation(type, poids)` to compute durations for new orders only.

### Data Source - Google Sheets Integration

The application loads **real production data from Google Sheets** via the Google Sheets API:

**Key Integration Points:**
- **Sheet ID:** Stored in `GOOGLE_SHEET_ID` constant (app.js top)
- **API Key:** Stored in `GOOGLE_API_KEY` constant (app.js top)
- **Data Loading:** `loadOrdersFromGoogleSheets()` fetches data on initialization (app.js)
- **Auto-Sync:** Configurable auto-refresh via `syncConfig` object
- **Manual Sync:** User can trigger via "Sync" button in header
- **Sync Indicator:** Visual status indicator shows sync state (syncing/synced/error)

**Column Mapping (Google Sheets → Application):**
```javascript
// Expected columns in Google Sheet:
{
  "Fin de Prod": "2025-12-20",    // Delivery date
  "Code cde": "CC25-1001",        // Order ID
  "STATUT": "En Cours",           // Order status
  "Client": "SPEBI",              // Client name
  "Poids": "150",                 // Material weight (kg)
  "CISAILLE": "00:03:00",         // Shearing duration (HH:MM:SS)
  "POINCON": "00:02:15",          // Punching duration
  "PLIAGE": "00:03:45"            // Bending duration
}
```

**Time Conversion:** `timeToDecimalHours()` handles:
- String format "HH:MM:SS"
- Date objects from Google Sheets
- Excel serial numbers (day fractions)
- Direct hour values

**Order Statuses (case-insensitive):**
- **"En prépa"**: Order ready but no operations placed yet (appears in sidebar)
- **"Planifiée"**: All operations placed in planning
- **"En cours"**: Order currently being executed (appears in planning)
- **"Terminée"**: Completed (filtered out, not displayed)
- **"Livrée"**: Delivered (filtered out, not displayed)

**Partial Placement Support:**
Orders with status "En prépa" and some operations placed appear in **both** sidebar (for unplaced ops) AND planning view (for placed ops). This is handled by:
- `getPlacedOrders()` - Includes "En prépa" commands with ≥1 placed operation (app.js)
- `getUnplacedOrders()` - Includes "En prépa" commands with ≥1 unplaced operation (app.js)

**Sync Configuration:**
```javascript
const syncConfig = {
    autoSync: true,           // Enable auto-sync
    intervalMinutes: 5,       // Sync every 5 minutes
    showIndicator: true,      // Show sync status
    onError: 'notify'         // Error handling strategy
};
```

### View System

The application has **three main views**:

**1. Vue Liste (List View)** - `renderVueListe()`
   - Tabular display of all orders
   - Filter by status, client, urgency
   - Sortable columns (delivery date, status, client)
   - Quick access to order details
   - Export to CSV/Excel functionality

**2. Vue Semaine (Week View)** - `renderVueSemaine()`
   - Overview of multiple weeks (navigable, default weeks 50-52)
   - Capacity gauges per machine
   - Command badges per week
   - Click on week cells to switch to day view
   - Year navigation support with rollover handling (app.js:119-131)

**3. Vue Journée (Day View)** - `renderVueJournee()`
   - Detailed hourly timeline:
     - Monday-Thursday: 07:00-17:00 with lunch break 12:30-13:00
     - Friday: 07:00-12:00
   - Multiple operations per machine/day
   - Drag & drop enabled for:
     - Moving existing operations between slots
     - Placing individual operations from sidebar to planning
   - Capacity indicators per day
   - Smart gap-finding algorithm (`findFirstAvailableGap()`) for optimal placement
   - Freeze protection for current/next day (`FREEZE_CONFIG` app.js:62-68)

Current view is tracked in `vueActive` variable ('liste', 'semaine', or 'journee').

### Drag & Drop System

Implemented using HTML5 Drag & Drop API:

**Draggable Elements:**
- `.operation-slot.draggable` - Placed operations in day view
- `.sidebar-operation-draggable` - Unplaced operations in sidebar

**Drop Zones:**
- `.drop-zone` - Hourly time slots in day view
- Visual feedback during drag (highlight valid drop zones)

**Validation on Drop:**
1. `canPlaceOperation()` enforces chronological order
2. Capacity check ensures slot has enough available hours
3. Gap-finding algorithm positions operation optimally
4. Rollback on validation failure

**State Management:**
1. Save old slot data before move
2. Apply new values temporarily
3. Validate chronological order + capacity
4. Commit if valid, rollback if invalid

### Capacity Management & Advanced Features

**Capacity Calculation Functions:**
- `calculerCapaciteMachine(machine, semaine)` - Weekly capacity
- `calculerCapaciteJour(machine, jour, semaine)` - Daily capacity (accounts for system events)
- `getCapacityColorClass(pourcentage)` - Visual color coding

**Capacity Thresholds:**
```javascript
// Normal capacity (app.js:31-40)
ok: 75%        // Green (capacity-ok)
warning: 95%   // Orange (capacity-warning)
danger: 100%   // Red (capacity-danger)

// Overbooking allowed up to 105% (app.js:41-51)
maxPercentage: 105%
visualIndicator: 'critical'  // Purple/critical styling
```

**Overtime Management (app.js:52-59):**
```javascript
// Available overtime slots
availableSlots: [
  { days: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi'],
    range: '16:30-18:00',
    maxHours: 1.5 },
  { days: ['Vendredi'],
    range: '12:00-14:00',
    maxHours: 2 }
]
maxWeeklyHours: 10,
maxDailyHours: 2
```

**System Events (Maintenance/Closures):**
- Managed via `systemEvents` array
- Types: 'maintenance', 'fermeture' (closure), 'conge' (leave)
- Affects capacity calculations automatically
- User interface for adding/managing events
- Visual indicators on planning views

**Freeze Protection (app.js:62-68):**
```javascript
const FREEZE_CONFIG = {
    currentDay: true,           // Freeze current day
    nextDay: 'partial',         // Partially freeze next day
    freezeHorizon: 24,          // Hours ahead to freeze
    overrideWarning: "⚠️ ATTENTION: Modification de la journée en cours..."
};
```

**Urgent Order Insertion:**
- Dedicated "INSÉRER COMMANDE URGENTE" button in sidebar
- Algorithm finds earliest possible slots across all machines
- Pushes existing operations later if needed (reschedules within limits)
- Respects `RESCHEDULE_WINDOW` constraints (app.js:70-74)
- Visual confirmation of affected operations

### Automatic Placement Algorithm

`placerAutomatiquement(commandeId)` implementation:

1. **Validate order structure** with `validateOperationOrder()`
2. **For each operation** (in chronological sequence):
   - Get compatible machines for operation type
   - Search through weeks (current + future)
   - For each potential slot:
     - Check capacity availability
     - Validate chronological constraints with `canPlaceOperation()`
     - Use `findFirstAvailableGap()` for optimal time slot
   - Place in first valid slot with sufficient capacity
3. **Update command status** to "Planifiée"
4. **Refresh views** to show placement

The algorithm **respects chronological order** - operations are placed sequentially and only in slots that don't violate timing constraints.

**Advanced Placement Features:**
- **Load balancing:** `findBestMachineSlot()` distributes work across similar machines
- **Gap optimization:** Fills small gaps first to maximize capacity utilization
- **Delivery date awareness:** Prioritizes orders close to delivery date
- **Manual adjustment:** Users can drag & drop after automatic placement

## Critical Functions Reference

When modifying scheduling logic, these are the **key functions**:

### Order Validation
- `validateOperationOrder(commande)` - Validates 3 operations exist in correct sequence
- `canPlaceOperation(commande, operation, targetWeek, targetDay, targetStartTime)` - Validates chronological timing
- `checkOperationOverlap(machine, jour, semaine, startTime, endTime, excludeSlotId)` - Prevents double-booking

### Placement Logic
- `findFirstAvailableGap(machine, jour, semaine, durationNeeded, minTimeStr)` - Finds optimal gap, optionally starting after minTimeStr
- `findBestMachineSlot(operation, cmd, machinesList)` - Load-balanced slot finder with chronological checks
- `placerAutomatiquement(commandeId)` - Auto-placement algorithm
- `handleDrop(e)` - Drag & drop handler with validation

### Capacity Calculations
- `calculerCapaciteMachine(machine, semaine)` - Weekly capacity with system events
- `calculerCapaciteJour(machine, jour, semaine)` - Daily capacity accounting for events/closures
- `getCapacityColorClass(pourcentage)` - Visual color coding (ok/warning/danger/critical)
- `calculateOvertimeUsage(semaine)` - Tracks overtime hours used

### Rendering
- `renderVueListe()` - List view with filters and sorting
- `renderVueSemaine()` - Week view grid with capacity gauges
- `renderVueJournee()` - Day view with hourly timeline and drag & drop
- `renderCommandesNonPlacees()` - Sidebar unplaced orders with drag support

### Data Synchronization
- `loadOrdersFromGoogleSheets()` - Fetches and parses Google Sheets data
- `mapGoogleSheetRowToOrder(row)` - Converts sheet rows to application format
- `syncNow()` - Manual sync trigger
- `startAutoSync()` / `stopAutoSync()` - Auto-sync management

### Utilities
- `calculerDureeOperation(type, poids)` - Calculate duration for new orders
- `timeToDecimalHours(timeStr)` - Convert HH:MM:SS or date to hours
- `getDateFromWeekDay(weekNumber, dayName, timeStr)` - ISO week → Date conversion
- `getWeekNumber(date)` - Date → ISO week number
- `formatHours(hours)` - Display formatting (e.g., "3.5h" or "3h30")

### System Events
- `addSystemEvent(event)` - Add maintenance/closure event
- `getSystemEventsForDay(machine, jour, semaine)` - Get events affecting a specific day
- `calculateAvailableHours(machine, jour, semaine)` - Base hours minus events

## Common Modification Scenarios

**Modifying duration coefficients:**
```javascript
// Edit app.js:104-108
const DUREE_PAR_KG = {
    'Cisaillage': 0.02,    // Change this
    'Poinçonnage': 0.015,
    'Pliage': 0.025
};
```

**Adding a new machine:**
```javascript
// Edit app.js:6-16
const MACHINES = {
    cisailles: ['Cisaille A', 'Cisaille B', 'Cisaille C'],  // Add here
    poinconneuses: ['Poinçonneuse A', 'Poinçonneuse B'],
    plieuses: ['Plieuse Lo', 'Plieuse Mik', 'Plieuse Mok']
};
```

**Changing working hours:**
```javascript
// Edit app.js:18-24
const HOURS_PER_DAY = {
    'Lundi': 8.5,      // Modify here
    'Mardi': 8.5,
    // ...
};
```

**Changing overtime limits:**
```javascript
// Edit app.js:52-59
overtime: {
    maxWeeklyHours: 10,   // Change weekly limit
    maxDailyHours: 2      // Change daily limit
}
```

**Adding a material type:**
```html
<!-- Edit index.html (form section) -->
<select id="orderMaterial">
    <option value="Aluminium">Aluminium</option>
    <option value="Galvanisé">Galvanisé</option>
    <option value="Inox">Inox</option> <!-- Add here -->
</select>
```

**Changing color scheme:**
```css
/* Edit styles.css :root section */
:root {
    --color-cisaillage: #28a745;    /* Green for shearing */
    --color-poinconnage: #fd7e14;   /* Orange for punching */
    --color-pliage: #6f42c1;        /* Purple for bending */
}
```

**Configuring Google Sheets connection:**
```javascript
// Edit app.js (top constants)
const GOOGLE_SHEET_ID = 'your-sheet-id-here';
const GOOGLE_API_KEY = 'your-api-key-here';
const SHEET_NAME = 'ETM_DATA';  // Sheet tab name
```

## Important Constraints

1. **No backend:** All data is in-memory, but synced with Google Sheets
2. **ISO week-based planning:** Uses ISO 8601 week numbering with year rollover
3. **French language:** All UI text, dates, and time formats are in French
4. **Tablet/Desktop only:** Optimized for tablets 10"+ and desktop, not mobile
5. **Chronological order enforcement:** Cannot be disabled or bypassed
6. **Operation order is immutable:** Cisaillage → Poinçonnage → Pliage sequence must be maintained
7. **Lunch break enforcement:** 30-minute break from 12:30-13:00 (Mon-Thu) in gap-finding algorithm
8. **Partial placement support:** Orders can have some operations placed and others in sidebar
9. **System events impact capacity:** Maintenance/closures automatically reduce available hours
10. **Freeze protection:** Current/next day modifications require override confirmation

## Known Issues & Recent Fixes

**Issue: Empty Sidebar (Fixed)**
- **Problem:** "Commandes à placer" sidebar was empty despite having "En prépa" orders
- **Fix:** Case-insensitive status check + validation that at least one operation has no slots

**Issue: "En Cours" Orders Not Appearing (Fixed)**
- **Problem:** Only 2 out of 7 active orders appeared in planning view
- **Fix:** Case-insensitive status comparison using `toLowerCase().trim()`

**Issue: Operations Not Appearing After Manual Placement (Fixed)**
- **Problem:** Operations placed via drag & drop from sidebar didn't appear until all 3 were placed
- **Fix:** Include "En prépa" orders with at least one placed operation in `getPlacedOrders()`

**Issue: Empty Command Cards in Sidebar (Fixed)**
- **Problem:** Cards appeared with no operations to display
- **Fix:** Build operations HTML first, skip card if empty

**Issue: Google Sheets Integration (Implemented)**
- **Previous:** Used embedded CSV data (legacy)
- **Current:** Live connection to Google Sheets with auto-sync
- **Features:** Real-time data loading, sync indicator, manual/auto sync, error handling

## Future Roadmap (V3)

The README.md describes a planned React rewrite with:
- **Backend:** Node.js/Express API
- **Database:** PostgreSQL
- **Authentication:** JWT
- **Real-time:** WebSockets
- **Gantt:** DHTMLX Gantt Pro integration
- **PWA:** Offline-first architecture
- **Advanced features:** ML-based duration prediction, IoT sensor integration

**This V2 is a prototype/mockup** - prioritize clarity and demonstration over production patterns.

## Testing Approach

Since this is a mockup with no test framework, manually verify:

- **Chronological order:** Try placing operations out of sequence (should be blocked)
- **Capacity calculations:** Verify with different order weights and system events
- **Drag & drop:** Test across different machines, days, and weeks
- **Friday constraint:** Ensure only 5h capacity (vs 8.5h other days)
- **Automatic placement:** Test with urgent orders (< 5 days to delivery)
- **Google Sheets sync:** Verify data loads correctly, sync indicator works
- **Overtime tracking:** Ensure overtime limits are respected
- **Freeze protection:** Confirm warnings appear when modifying current day
- **System events:** Verify maintenance/closures reduce capacity correctly
- **Partial placement:** Check orders with some ops placed appear in both sidebar and planning

## Console Logging

The application includes diagnostic logging:

```javascript
// Data loading
console.log('📊 Loaded X orders from Google Sheets');
console.log('📋 Status counts:', statusCounts);
console.log('⚠️ Unplaced orders:', unplacedOrders.length);

// Validation
console.log('✅ Order validation passed');
console.warn('⚠️ Cannot place operation: reason');

// Sync status
console.log('🔄 Syncing with Google Sheets...');
console.log('✅ Sync completed successfully');
console.error('❌ Sync failed:', error);
```

---

# ETM PROD V2 - Contexte Intégration Supabase

## Résumé du projet

ETM PROD V2 est une application de planification de production pour un atelier de tôlerie (aluminium et acier galvanisé) dans l'industrie des fenêtres/portes. L'application gère 3 processus séquentiels obligatoires : Cisaillage → Poinçonnage → Pliage.

### Stack technique actuelle
- **Frontend** : Vanilla HTML5, CSS3, JavaScript ES6+ (pas de framework)
- **Données source** : Google Sheets (saisie par Magali)
- **Cache local** : localStorage
- **Hébergement** : GitHub Pages

---

## Ce qui a été mis en place : Synchro Google Sheets → Supabase

### Architecture de données

```
Google Sheets (source de vérité - Magali saisit)
       │
       ▼ [Trigger toutes les 5 min]
Google Apps Script (syncIfChanged)
       │
       ▼ [Batch upsert - 2 requêtes max]
Supabase PostgreSQL (base centralisée)
       │
       ▼ [À implémenter : Realtime]
ETM PROD V2 (app web)
```

### Credentials Supabase (déjà configurés)

```javascript
const SUPABASE_URL = 'https://veyqcnoaiqotikpjfgjq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wa6y4sYvbvKtzSFBzw7lBg_CYdxXr1P';
```

### Schéma Supabase (15 tables)

Les tables principales :

#### Table `commandes`
```sql
CREATE TABLE commandes (
    id VARCHAR(50) PRIMARY KEY,  -- ex: "CC25-1001"
    client_id UUID REFERENCES clients(id),
    client_name VARCHAR(255) NOT NULL,
    date_livraison DATE,
    statut VARCHAR(50) DEFAULT 'En cours' CHECK (statut IN ('En cours', 'Planifiée', 'En prépa', 'Livrée', 'Terminée')),
    materiau VARCHAR(100),
    poids DECIMAL(10,2) DEFAULT 0,
    ref_cde_client VARCHAR(100),
    ressource VARCHAR(50),
    semaine_affectee VARCHAR(10),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Table `operations`
```sql
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    commande_id VARCHAR(50) REFERENCES commandes(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('Cisaillage', 'Poinçonnage', 'Pliage')),
    duree_total DECIMAL(10,4) DEFAULT 0,  -- en heures décimales
    duree_original DECIMAL(10,4) DEFAULT 0,
    duree_override DECIMAL(10,4),
    override_timestamp TIMESTAMPTZ,
    progression_reelle DECIMAL(5,2) DEFAULT 0,
    statut VARCHAR(50) DEFAULT 'Non placée' CHECK (statut IN ('Non placée', 'Planifiée', 'En cours', 'Terminée')),
    ordre INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Table `slots` (créneaux d'exécution)
```sql
CREATE TABLE slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation_id UUID REFERENCES operations(id) ON DELETE CASCADE,
    machine_id VARCHAR(50) REFERENCES machines(id),
    machine_name VARCHAR(100) NOT NULL,
    duree DECIMAL(10,4) NOT NULL,
    semaine INT NOT NULL,
    jour VARCHAR(20) NOT NULL,
    heure_debut TIME NOT NULL,
    heure_fin TIME NOT NULL,
    date_debut TIMESTAMPTZ NOT NULL,
    date_fin TIMESTAMPTZ NOT NULL,
    overtime BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Table `machines`
```sql
CREATE TABLE machines (
    id VARCHAR(50) PRIMARY KEY,  -- ex: "cisaille-a"
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('cisaillage', 'poinconnage', 'pliage')),
    capacity DECIMAL(4,2) DEFAULT 8.5,
    color VARCHAR(7) DEFAULT '#10b981',
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Données machines initiales :
- cisaille-a, cisaille-b (type: cisaillage)
- poinconneuse-m, poinconneuse-t (type: poinconnage)
- plieuse-lo, plieuse-mik, plieuse-mok (type: pliage)

### Autres tables disponibles
- `clients` - Liste des clients
- `shifts` - Équipes (jour)
- `shift_schedules` - Horaires par jour
- `breaks` - Pauses (déjeuner)
- `system_events` - Maintenance/fermetures
- `overtime_config` - Configuration heures sup
- `overtime_slots` - Créneaux heures sup
- `overtime_tracker` - Suivi heures sup
- `capacity_config` - Configuration capacité
- `capacity_daily_hours` - Heures par jour
- `sync_metadata` - Métadonnées de synchronisation

---

## Google Apps Script (synchro en place)

Le script synchronise Google Sheets → Supabase toutes les 5 minutes.

### Fonctionnement
1. Compare le hash MD5 de chaque ligne avec le cache
2. Ne synchronise que les lignes modifiées (batch upsert)
3. Filtre sur les 2 derniers mois pour performance
4. 2 requêtes max par sync (commandes + opérations)

### Mapping Google Sheets → Supabase

| Colonne Sheet | Index | Table Supabase | Champ |
|---------------|-------|----------------|-------|
| Fin de Prod | 0 | commandes | date_livraison |
| Code cde | 1 | commandes | id |
| STATUT | 2 | commandes | statut |
| Client | 3 | commandes | client_name |
| Poids | 4 | commandes | poids |
| CISAILLE | 5 | operations | duree_total (type='Cisaillage') |
| POINCON | 6 | operations | duree_total (type='Poinçonnage') |
| PLIAGE | 7 | operations | duree_total (type='Pliage') |
| Réf cde client | 8 | commandes | ref_cde_client |

### Script Google Apps Script complet

Voir fichier : `etm_sync_final.gs` (dans les outputs)

---

## Prochaine étape : Intégration Realtime dans l'app

### Objectif
Remplacer la lecture Google Sheets par Supabase avec mise à jour temps réel.

### Plan d'implémentation

#### Étape 1 : Ajouter le SDK Supabase

Dans `index.html` :
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

#### Étape 2 : Créer le module Supabase

Créer `supabase.js` :
```javascript
// Configuration
const SUPABASE_URL = 'https://veyqcnoaiqotikpjfgjq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wa6y4sYvbvKtzSFBzw7lBg_CYdxXr1P';

// Client Supabase
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Charger les commandes avec leurs opérations
async function fetchCommandes() {
    const { data, error } = await supabase
        .from('commandes')
        .select(`
            *,
            operations (*)
        `)
        .in('statut', ['En cours', 'Planifiée', 'En prépa'])
        .order('date_livraison', { ascending: true });

    if (error) throw error;
    return data;
}

// Charger les machines
async function fetchMachines() {
    const { data, error } = await supabase
        .from('machines')
        .select('*')
        .eq('active', true);

    if (error) throw error;
    return data;
}

// Charger les slots (placements)
async function fetchSlots() {
    const { data, error } = await supabase
        .from('slots')
        .select('*');

    if (error) throw error;
    return data;
}
```

#### Étape 3 : Configurer Realtime

```javascript
// S'abonner aux changements sur commandes
function subscribeToCommandes(callback) {
    return supabase
        .channel('commandes-changes')
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'commandes' },
            (payload) => {
                console.log('Commande changée:', payload);
                callback(payload);
            }
        )
        .subscribe();
}

// S'abonner aux changements sur opérations
function subscribeToOperations(callback) {
    return supabase
        .channel('operations-changes')
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'operations' },
            (payload) => {
                console.log('Opération changée:', payload);
                callback(payload);
            }
        )
        .subscribe();
}
```

#### Étape 4 : Modifier app.js

Remplacer les fonctions de chargement de données :

```javascript
// Ancien code (Google Sheets)
// async function loadOrdersFromGoogleSheets() { ... }

// Nouveau code (Supabase)
async function loadOrders() {
    try {
        const commandes = await fetchCommandes();

        // Transformer au format attendu par l'app
        const orders = commandes.map(cmd => ({
            id: cmd.id,
            client: cmd.client_name,
            dateLivraison: cmd.date_livraison,
            statut: cmd.statut,
            poids: cmd.poids,
            refClient: cmd.ref_cde_client,
            operations: cmd.operations.map(op => ({
                id: op.id,
                type: op.type,
                duree: op.duree_total,
                statut: op.statut,
                progression: op.progression_reelle
            }))
        }));

        return orders;
    } catch (error) {
        console.error('Erreur chargement:', error);
        return [];
    }
}

// Initialiser Realtime
function initRealtime() {
    subscribeToCommandes((payload) => {
        // Rafraîchir l'UI quand une commande change
        handleCommandeChange(payload);
    });

    subscribeToOperations((payload) => {
        // Rafraîchir l'UI quand une opération change
        handleOperationChange(payload);
    });
}
```

#### Étape 5 : Écriture dans Supabase (placements)

```javascript
// Sauvegarder un slot (placement d'opération)
async function saveSlot(slot) {
    const { data, error } = await supabase
        .from('slots')
        .upsert({
            id: slot.id,
            operation_id: slot.operationId,
            machine_id: slot.machineId,
            machine_name: slot.machineName,
            duree: slot.duree,
            semaine: slot.semaine,
            jour: slot.jour,
            heure_debut: slot.heureDebut,
            heure_fin: slot.heureFin,
            date_debut: slot.dateDebut,
            date_fin: slot.dateFin,
            overtime: slot.overtime || false
        });

    if (error) throw error;
    return data;
}

// Supprimer un slot
async function deleteSlot(slotId) {
    const { error } = await supabase
        .from('slots')
        .delete()
        .eq('id', slotId);

    if (error) throw error;
}

// Mettre à jour le statut d'une opération
async function updateOperationStatut(operationId, statut) {
    const { error } = await supabase
        .from('operations')
        .update({ statut: statut })
        .eq('id', operationId);

    if (error) throw error;
}
```

---

## Configuration Supabase requise

### Activer Realtime sur les tables

Dans Supabase Dashboard > Database > Replication :
1. Activer la réplication pour `commandes`
2. Activer la réplication pour `operations`
3. Activer la réplication pour `slots`

### Row Level Security (optionnel pour l'instant)

Les tables sont actuellement sans RLS. Pour un usage multi-tenant futur, il faudra configurer les policies.

---

## Structure des fichiers de l'app

```
ETM Prod/
├── index.html          # UI principale
├── styles.css          # Styles
├── app.js              # Logique applicative (à modifier)
├── supabase.js         # NOUVEAU : Module Supabase
└── README.md           # Documentation
```

---

## Points d'attention

1. **Contrainte séquentielle** : Cisaillage → Poinçonnage → Pliage (ordre strict)
2. **Durées en heures décimales** : 0.02083333 = ~1.25 minutes
3. **Filtre statuts actifs** : 'En cours', 'Planifiée', 'En prépa'
4. **Multi-utilisateurs** : Patrick (planning hebdo), Pierre (planning journalier), Magali (saisie)
5. **Pas de materiau** dans le Sheet source (colonne non présente)

---

## Commandes utiles

### Tester la connexion Supabase (dans la console navigateur)
```javascript
const { data, error } = await supabase.from('machines').select('*');
console.log(data);
```

### Requête pour voir les commandes actives avec opérations
```javascript
const { data } = await supabase
    .from('commandes')
    .select('*, operations(*)')
    .in('statut', ['En cours', 'Planifiée', 'En prépa'])
    .limit(10);
console.log(data);
```

---

## Résumé des actions réalisées

1. ✅ Schéma Supabase créé (15 tables)
2. ✅ Import initial CSV (commandes + opérations)
3. ✅ Script Google Apps Script pour synchro incrémentale
4. ✅ Trigger toutes les 5 min avec filtre 2 mois
5. ✅ Batch upsert optimisé (2 requêtes max)
6. ⏳ Intégration Realtime dans l'app (à faire)
7. ⏳ Écriture des placements dans Supabase (à faire)

---

# TOKEN OPTIMIZATION PROTOCOLS — INITIALIZED

## ⚡ Auto-Active Token Optimization Hooks (60–80% Savings)

**ALWAYS ACTIVE — No manual commands required**

DAILY_TOKEN_BUDGET=5000
TOKEN_EFFICIENCY_MODE="balanced" # Auto-switches to high/ultra as budget depletes


### Budget Thresholds
- **< 500 remaining** → ULTRA mode (minimal context)  
- **< 1500 remaining** → HIGH mode (targeted operations)  
- **> 1500 remaining** → BALANCED mode (standard)

---

## 🚀 High-Efficiency Command Patterns

| Command                     | Tokens | vs Manual |
|-----------------------------|--------|-----------|
| `chp`                       | 300    | 1500+     |
| `chs find-code "PATTERN"`   | 200    | 800+      |
| `ch m read-many f1 f2 f3`   | 400    | 1200+     |
| `chg quick-commit "msg"`    | 150    | 600+      |

---

## 📊 Session Token Allocation

| Phase                 | Budget | Tokens |
|-----------------------|--------|--------|
| Project Analysis      | 20%    | 1000   |
| Core Development      | 50%    | 2500   |
| Testing/Optimization  | 20%    | 1000   |
| Documentation         | 10%    | 500    |
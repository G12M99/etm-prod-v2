# CLAUDE.md — ETM PROD V2 Reference

This file is the definitive technical reference for Claude Code sessions. It documents every aspect of the application to avoid re-exploring the codebase.

---

## Project Overview

**ETM PROD V2** is a production planning application for an industrial sheet metal workshop (Aluminum/Galvanized steel, window/door industry). Built as a single-page vanilla JavaScript application with Supabase backend and real-time multi-user synchronization.

**Users:** Patrick (weekly planning), Pierre (daily planning), Magali (order entry in Google Sheets)

### Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML5 + CSS3 + ES6+ JavaScript (no framework) |
| Backend | Supabase (PostgreSQL + Realtime WebSockets) |
| Data Source | Google Sheets (Magali enters orders) → Apps Script syncs to Supabase every 5 min |
| Cache | localStorage (offline fallback) |
| Hosting | Netlify (branch: `supabase-netlify`) |

### Machine Park

| Type | Machines | Operation |
|------|----------|-----------|
| Cisailles (Shears) | Cisaille A, Cisaille B | Cisaillage |
| Poinconneuses (Punching) | Poinconneuse M, Poinconneuse T | Poinconnage |
| Plieuses (Bending) | Plieuse Lo, Plieuse Mik, Plieuse Mok | Pliage |

### CRITICAL BUSINESS RULE — Chronological Order

```
Cisaillage → Poinconnage → Pliage (STRICT, NON-REVERSIBLE)
```

Each operation must COMPLETE before the next can BEGIN. Enforced in:
- `validateOperationOrder()` (line 2292)
- `canPlaceOperation()` (line 2327)
- `handleDrop()` (line 4055)
- `placerAutomatiquement()` (line 4510)

**NEVER allow out-of-order placement.**

---

## File Structure

```
ETM Prod/                          (18,073 lines total)
├── index.html          (770 lines)   # UI: modals, views, sidebar
├── styles.css          (4,329 lines) # CSS Grid/Flexbox, drag & drop, print
├── app.js              (12,406 lines)# ALL application logic
├── supabase.js         (568 lines)   # Supabase CRUD + Realtime subscriptions
├── CLAUDE.md                         # This file
├── README.md                         # User-facing documentation (French)
└── GEMINI.md                         # Gemini-specific guidance
```

**No build process.** Open `index.html` in any browser.

---

## Architecture: Data Flow

```
Google Sheets (Magali saisit)
       │
       ▼  [Google Apps Script, every 5 min, batch upsert]
Supabase PostgreSQL (source of truth)
       │                          ▲
       ▼  [Realtime WebSocket]    │  [Upsert on local changes]
ETM PROD V2 (browser)  ──────────┘
       │
       ▼  [Backup]
localStorage (offline fallback)
```

### Sync System

```
User action (drag/drop, auto-place, etc.)
  → handleDrop() creates/modifies operation.slots[]
  → saveDataImmediate(cmd.id)                    [handleDrop: immediate]
    or saveData(commandeId)                      [other: 500ms debounce]
  → markCommandeDirty(commandeId)
  → syncManager.saveLocalData()
    ├── Save to localStorage
    └── saveToSupabaseDebounced() [500ms]
        └── saveAllToSupabase()
            └── For each dirty ID: upsertCommandeToSupabase(cmd)
                ├── Upsert commande
                ├── Upsert operations
                ├── DELETE orphaned slots (SELECT+compare)
                ├── Upsert local slots
                └── markRecordAsModified() on each record

Supabase Realtime → Other clients receive events
  → handleRealtimeSlotChange(payload)
    → isOurOwnRealtimeEvent() [skip if < 5s old]
    → Update local state (commandes[].operations[].slots[])
    → debouncedRealtimeUpdate() [500ms]
      → refreshUIOnly() + saveLocalStorageOnly()
```

---

## Data Model

### Local JavaScript Objects

```javascript
commandes = [
  {
    id: "CC25-1001",           // From Google Sheets "Code cde"
    client: "SPEBI",
    poids: 150,                // Weight in kg
    materiau: "Aluminium",
    statut: "En cours",        // En cours | Planifiee | En prepa | Non placee | Terminee | Livree
    dateLivraison: "2025-12-20",
    refCdeClient: "REF-123",
    ressource: "R1",
    semaineAffectee: "2025-W50",
    operations: [
      {
        id: "cc25-1001-cisaillage-abc123",  // Deterministic ID
        type: "Cisaillage",                 // Cisaillage | Poinconnage | Pliage
        dureeTotal: 3.0,                    // Hours (decimal)
        dureeOriginal: 3.0,
        dureeOverride: null,                // Manual override value
        overrideTimestamp: null,
        progressionReelle: 75,              // 0-100%
        statut: "En cours",                 // Non placee | Planifiee | En cours | Terminee
        slots: [
          {
            id: "cc25-1001-cisaillage-abc123_slot_1",  // generateSlotId()
            machine: "Cisaille A",
            duree: 3.0,
            semaine: 50,               // ISO week number
            annee: 2025,
            jour: "Lundi",             // French day name
            heureDebut: "09:00",
            heureFin: "12:00",
            dateDebut: "2025-12-09T09:00:00.000Z",
            dateFin: "2025-12-09T12:00:00.000Z",
            overtime: false
          }
        ]
      }
      // ... Poinconnage, Pliage
    ]
  }
]
```

### Supabase Schema (key tables)

**`commandes`** — Orders
```
id VARCHAR(50) PK, client_name, date_livraison DATE, statut, materiau, poids DECIMAL,
ref_cde_client, ressource, semaine_affectee, created_at, updated_at
```

**`operations`** — 3 per commande (Cisaillage, Poinconnage, Pliage)
```
id UUID PK, commande_id FK→commandes, type, duree_total DECIMAL, duree_original,
duree_override, override_timestamp, progression_reelle, statut, ordre INT, created_at, updated_at
```

**`slots`** — Time slots for placed operations (1+ per operation)
```
id UUID PK, operation_id FK→operations, machine_id FK→machines, machine_name,
duree DECIMAL, semaine INT, jour VARCHAR, heure_debut TIME, heure_fin TIME,
date_debut TIMESTAMPTZ, date_fin TIMESTAMPTZ, overtime BOOLEAN, created_at, updated_at
```

**`machines`** — Machine configuration
```
id VARCHAR(50) PK (e.g. "cisaille-a"), name, type (cisaillage|poinconnage|pliage),
capacity DECIMAL, color VARCHAR(7), active BOOLEAN
```

**Other tables:** `clients`, `shifts`, `shift_schedules`, `breaks`, `system_events`, `overtime_config`, `overtime_slots`, `overtime_tracker`, `capacity_config`, `capacity_daily_hours`, `sync_metadata`

### Local ↔ Supabase Field Mapping

| Local field | Supabase column | Notes |
|-------------|----------------|-------|
| `cmd.client` | `commandes.client_name` | |
| `cmd.dateLivraison` | `commandes.date_livraison` | |
| `op.dureeTotal` | `operations.duree_total` | Decimal hours |
| `slot.machine` | `slots.machine_name` | Display name |
| `slot.machine` → normalize | `slots.machine_id` | Auto-generated: "Cisaille A" → "cisaille-a" |
| `slot.heureDebut` | `slots.heure_debut` | TIME format |

---

## app.js — Complete Structure Map (12,406 lines)

### Global State Variables

| Variable | Line | Type | Purpose |
|----------|------|------|---------|
| `machinesConfig` | 7 | object | Mutable machine configuration |
| `scheduleConfig` | 11 | object | Mutable schedule configuration |
| `SUPABASE_URL` | 16 | const | `https://veyqcnoaiqotikpjfgjq.supabase.co` |
| `SUPABASE_ANON_KEY` | 17 | const | Supabase public key |
| `supabaseClient` | 18 | let | Supabase JS client instance |
| `CLIENT_SESSION_ID` | 21 | const | Unique session ID for echo suppression |
| `_recentlyModifiedRecords` | 28 | Map | Record ID → timestamp for echo suppression |
| `REALTIME_IGNORE_WINDOW_MS` | 29 | const | 5000ms |
| `MACHINES` | 61 | let | `{cisailles: [...], poinconneuses: [...], plieuses: [...]}` |
| `ALL_MACHINES` | 67 | let | Flat array of all machine names |
| `HOURS_PER_DAY` | 108 | let | `{Lundi: 8.5, ..., Vendredi: 5}` |
| `DAYS_OF_WEEK` | 116 | const | `['Lundi','Mardi','Mercredi','Jeudi','Vendredi']` |
| `TOTAL_HOURS_PER_WEEK` | 117 | let | 39 |
| `CAPACITY_CONFIG` | 121 | const | Thresholds: ok=75%, warning=95%, danger=100%, critical=105% |
| `FREEZE_CONFIG` | 152 | const | Current/next day freeze protection |
| `LUNCH_BREAK` | 187 | let | `{start: 12.5, end: 13.0, duration: 0.5}` |
| `DUREE_PAR_KG` | 194 | const | `{Cisaillage: 0.02, Poinconnage: 0.015, Pliage: 0.025}` |
| `vueActive` | 204 | let | `'semaine'` / `'journee'` / `'liste'` |
| `semaineSelectionnee` | 205 | let | Current ISO week number |
| `anneeSelectionnee` | 206 | let | Current year |
| `draggedOperation` | 246 | let | State of currently dragged operation |
| `commandes` | 249 | let | **MAIN DATA ARRAY** — all orders |
| `currentSearchQuery` | 255 | let | Sidebar search filter |
| `systemEvents` | 258 | let | Maintenance/closure events |
| `_dirtyCommandeIds` | 9700 | Set | Command IDs pending Supabase sync |
| `REALTIME_DEBUG` | 9695 | const | `false` — set `true` for verbose Realtime logs |
| `syncManager` | 9584 | const | `DataSyncManager` singleton instance |
| `historyManager` | 727 | const | `HistoryManager` singleton (undo/redo) |

### Section Map

| Lines | Section | Key Functions |
|-------|---------|---------------|
| 1-60 | **Supabase Init & Config** | `initSupabase()`, `markRecordAsModified()`, `isOurOwnRealtimeEvent()` |
| 61-200 | **Constants & Machine Config** | `MACHINES`, `HOURS_PER_DAY`, `CAPACITY_CONFIG`, `FREEZE_CONFIG`, `DUREE_PAR_KG` |
| 201-260 | **Navigation & State** | `changeWeek()`, `goToWeekFromDate()` |
| 261-384 | **Data Migrations** | `migrateMachineNames()`, `migrateOperationOverrideFields()`, `migrateCommandesSemaineAffectee()` |
| 390-637 | **Data Transform & Utils** | `generateSlotId()`, `timeToDecimalHours()`, `mapGoogleSheetRowToOrder()` |
| 641-725 | **HistoryManager class** | Undo/Redo (50 states max) |
| 730-1131 | **Legacy Data & Init** | Demo data, initial load scaffolding |
| 1137-1310 | **Utility Functions** | `calculerDureeOperation()`, `getWeekNumber()`, `getActiveOrders()`, `getPlacedOrders()`, `getUnplacedOrders()` |
| 1319-1770 | **Capacity & Gap-Finding** | `calculerCapaciteMachine()`, `calculerCapaciteJour()`, `findFirstAvailableGap()`, `findNextGap()`, `getMachinesByLoadOrder()` |
| 2033-2277 | **Time Editing & Overrides** | `setOperationTimeOverride()`, `showTimeEditPopup()`, `showModalTimeEdit()` |
| 2285-2452 | **Validation & Constraints** | `validateOperationOrder()`, `canPlaceOperation()`, `checkOperationOverlap()`, `getDateFromWeekDay()` |
| 2459-2688 | **Vue Semaine (Week View)** | `renderVueSemaine()` |
| 2695-3108 | **Vue Journee (Day View)** | `renderVueJournee()` |
| 3120-3516 | **Sidebar Rendering** | `renderSidebarContent()`, `renderCommandesNonPlacees()`, `initializeSidebarSearch()`, `replanifierOperationsSuivantes()` |
| 3663-4054 | **Drag & Drop System** | `initDragAndDrop()`, `handleSidebarDrop()`, `handleDragStart()`, `handleWeekCellDrop()`, `desaffecterCommande()` |
| 4055-4501 | **handleDrop() — Core Drop Logic** | Validates chrono order, finds gaps, creates slots, handles overtime splits, rollback on error |
| 4510-4810 | **Automatic Placement** | `placerAutomatiquement()`, `showCommandeDetails()` |
| 4938-4988 | **Overtime Dialogs** | `showOvertimeConfirmDialog()` |
| 4989-5719 | **DataSyncManager class** | Full sync system (see Sync section below) |
| 5800-6471 | **System Events** | `saveSystemEvents()`, `loadSystemEvents()`, `expandMultiDayEvent()`, maintenance/closure modals |
| 6475-6748 | **Vue Liste (List View)** | `renderVueListe()`, `unplanCommand()`, column sorting |
| 6751-6804 | **View Navigation** | `toggleVue()`, `refresh()`, `updateCurrentTime()` |
| 6811-6874 | **Event Handlers Init** | `initEventHandlers()` — all button/keyboard listeners |
| 6885-7360 | **Urgent Insertion (Simple)** | `showUrgentInsertionModal()`, scenarios (Normal, Earliest, Split) |
| 7362-8800 | **Urgent Insertion (Smart)** | `calculateSmartInsertionPlan()`, displacement cascade, `splitAtNormalHoursEnd()`, conflict resolution |
| 9516-9580 | **Print Config** | `showPrintConfig()`, `handlePrint()` |
| 9589-9688 | **Initialization** | `async init()` — main entry point |
| 9695-10067 | **Dirty Tracking & Realtime** | `markCommandeDirty()`, `saveData()`, `saveDataImmediate()`, all `handleRealtime*Change()` handlers |
| 10118-10640 | **Machine Manager** | `loadMachinesConfig()`, `openMachineManager()`, machine CRUD UI |
| 10647-11544 | **Schedule Manager** | `loadScheduleConfig()`, shifts/breaks CRUD, `buildScheduleConfig()` |
| 11627-12397 | **Semi-Auto Planning Modal** | `openPlanifierSemiAutoModal()`, 2-step wizard, time slider, placement calculation |

---

## DataSyncManager — Detailed (Lines 4989-5719)

| Method | Lines | Purpose |
|--------|-------|---------|
| `constructor()` | 4990-4996 | Init state, storage key `etm_commandes_v2` |
| `init()` | 4999-5040 | Try Supabase → fallback localStorage → migrations → refresh |
| `loadLocalData()` | 5043-5070 | Parse localStorage JSON |
| `loadCommandesFromSupabase()` | 5073-5142 | Fetch commandes+operations+slots, reconstruct nested structure |
| `upsertCommandeToSupabase(cmd)` | 5161-5273 | **Core write**: upsert commande → operations → cleanup orphan slots → upsert slots |
| `deleteSlotFromSupabase(slotId)` | 5276-5291 | Delete single slot by ID |
| `deleteAllSlotsForOperation(opId)` | 5294-5309 | Delete all slots for operation |
| `syncWithSupabase()` | 5347-5376 | Periodic full sync (every 10 min) |
| `mergeData(local, remote)` | 5386-5503 | Remote = master for metadata, local = master for slots/planning |
| `saveLocalData()` | 5506-5525 | localStorage + trigger `saveToSupabaseDebounced()` |
| `saveToSupabaseDebounced()` | 5528-5535 | 500ms debounce before Supabase write |
| `saveAllToSupabase()` | 5538-5559 | Write only `_dirtyCommandeIds` to Supabase |

### Orphan Slot Cleanup (in `upsertCommandeToSupabase`)

When a slot is moved via drag & drop, the old slot ID changes. The upsert function:
1. SELECT existing slot IDs from Supabase for each operation
2. Compare with local slot IDs
3. DELETE orphaned IDs (exist in Supabase but not locally)
4. UPSERT current local slots

This prevents ghost/duplicate slots on other clients.

---

## supabase.js — Module (568 lines)

### Read Functions
| Function | Purpose |
|----------|---------|
| `fetchCommandesFromSupabase()` | Fetch commandes with nested operations and slots |
| `fetchMachinesFromSupabase()` | Fetch active machines |
| `fetchSystemEventsFromSupabase()` | Fetch maintenance/closure events |
| `fetchScheduleConfigFromSupabase()` | Fetch shifts + schedules + breaks |
| `fetchOvertimeConfigFromSupabase()` | Fetch overtime config + slots |

### Write Functions
| Function | Purpose |
|----------|---------|
| `saveSlotToSupabase(slot)` | Upsert single slot |
| `deleteSlotFromSupabase(slotId)` | Delete single slot |
| `updateOperationInSupabase(opId, updates)` | Update operation fields |
| `updateCommandeInSupabase(cmdId, updates)` | Update commande fields |
| `saveMachineToSupabase(machine)` | Upsert machine |
| `deleteMachineFromSupabase(machineId)` | Delete machine |
| `saveSystemEventToSupabase(event)` | Upsert system event |
| `deleteSystemEventFromSupabase(eventId)` | Delete system event |
| `saveShiftToSupabase(shift, schedules)` | Upsert shift + schedules |
| `saveBreakToSupabase(breakItem)` | Upsert break |
| `saveOvertimeConfigToSupabase(config, slots)` | Replace overtime config |

### Realtime Subscriptions
| Function | Table |
|----------|-------|
| `subscribeToCommandes(cb)` | commandes |
| `subscribeToOperations(cb)` | operations |
| `subscribeToSlots(cb)` | slots |
| `subscribeToMachines(cb)` | machines |
| `subscribeToSystemEvents(cb)` | system_events |
| `subscribeToShifts(cb)` | shifts |
| `subscribeToShiftSchedules(cb)` | shift_schedules |
| `subscribeToBreaks(cb)` | breaks |
| `subscribeToOvertimeConfig(cb)` | overtime_config |
| `subscribeToOvertimeSlots(cb)` | overtime_slots |

`initAllRealtimeSubscriptions(handlers)` subscribes to all 10 tables.

### Realtime Status UI
`updateRealtimeStatusUI(status)` updates `#realtimeStatus` div — green (connected), orange (disconnected), red (error).

---

## Realtime Echo Suppression

```javascript
const _recentlyModifiedRecords = new Map();  // recordId → timestamp
const REALTIME_IGNORE_WINDOW_MS = 5000;

function markRecordAsModified(recordId) {
    _recentlyModifiedRecords.set(recordId, Date.now());
    setTimeout(() => _recentlyModifiedRecords.delete(recordId), 6000);
}

function isOurOwnRealtimeEvent(recordId) {
    const modifiedAt = _recentlyModifiedRecords.get(recordId);
    return modifiedAt && (Date.now() - modifiedAt) < REALTIME_IGNORE_WINDOW_MS;
}
```

Called in all 3 Realtime handlers. `REALTIME_DEBUG = false` controls verbose logging.

---

## Dirty Tracking System

```javascript
const _dirtyCommandeIds = new Set();

function markCommandeDirty(commandeId)    // Add to dirty set
function markAllCommandesDirty()           // Mark all (for bulk ops: undo, import)
function saveData(commandeId)              // Mark dirty + saveLocalData (debounced)
function saveDataImmediate(commandeId)     // Mark dirty + save NOW (no debounce)
```

`handleDrop()` uses `saveDataImmediate()` for fast sync. Other operations use `saveData()`.

---

## Production Capacity

| Day | Hours | Schedule |
|-----|-------|----------|
| Mon-Thu | 8.5h | 07:30-16:30, lunch 12:30-13:00 |
| Friday | 5h | 07:00-12:00 |
| **Weekly** | **39h** | |

### Overtime
| Day | Slot | Max |
|-----|------|-----|
| Mon-Thu | 16:30-18:00 | 1.5h |
| Friday | 12:00-14:00 | 2h |
| Weekly limit | | 10h |

### Capacity Thresholds
- **ok** (green): 0-75%
- **warning** (orange): 76-95%
- **danger** (red): 96-100%
- **critical** (purple): 101-105% (overbooking allowed)

---

## handleDrop() — Core Placement Logic (Line 4055)

The most complex function in the app. Handles drag & drop of operations.

### Flow
1. Read target machine/day/week from drop zone attributes
2. Find the command and operation being moved
3. Backup original slots (`slotsBackup`, `originalSlots`)
4. Clear `operation.slots = []`
5. Call `findFirstAvailableGap()` to find placement
6. If gap found:
   - Check overtime overflow with `detectOvertimeOverflow()`
   - If overtime needed → confirm dialog → accept or split
   - Create new slot(s) with `generateSlotId()`
   - Update operation/command statut
   - Call `replanifierOperationsSuivantes()` if needed
   - Render views + `saveDataImmediate(cmd.id)`
7. If no gap → restore from backup + alert

### Branching (5 save paths)
| Line | Branch | Description |
|------|--------|-------------|
| 4286 | Split (overtime refused) | Fragment slots via `splitAtNormalHoursEnd()` |
| 4332 | Normal placement | Single slot, no overtime |
| 4409 | Overtime accepted | Single slot with overtime |
| 4446 | Partial overtime split | Some overtime refused |
| 4484 | Direct split | No overtime possible |

All 5 call `saveDataImmediate(cmd.id)` for immediate Supabase sync.

### Fragment Slots
When an operation doesn't fit in one day, `splitAtNormalHoursEnd()` splits it into fragments. Each fragment gets a deterministic ID via `generateSlotId(operation.id, fragments.slice(0, index))`.

---

## Initialization Flow (Line 9589)

```
init()
  1. initSupabase()                    → Create Supabase client
  2. Set semaineSelectionnee/annee     → Current week/year
  3. loadMachinesConfig()              → From Supabase or localStorage
  4. loadScheduleConfig()              → From Supabase or localStorage
  5. Start 60s clock                   → updateCurrentTime() every minute
  6. loadSystemEvents()                → Maintenance/closures
  7. syncManager.init()                → Load data (Supabase primary, localStorage fallback)
     ├── loadCommandesFromSupabase()   → Fetch all active commandes
     ├── migrations                    → migrateMachineNames(), etc.
     └── refresh()                     → Render current view
  8. initAllRealtimeSubscriptions()    → 10 WebSocket channels
  9. initializeSidebarSearch()         → Search input listeners
```

---

## Key Functions Quick Reference

### Validation
| Function | Line | Purpose |
|----------|------|---------|
| `validateOperationOrder(cmd)` | 2292 | Ensure 3 ops in correct sequence |
| `canPlaceOperation(cmd, op, week, day, time, year)` | 2327 | Validate chronological timing |
| `checkOperationOverlap(machine, day, week, start, end, excludeId)` | ~2430 | Prevent double-booking |

### Placement
| Function | Line | Purpose |
|----------|------|---------|
| `findFirstAvailableGap(machine, day, week, duration, minTime, allowOT, year)` | 1513 | Core gap-finding algorithm |
| `findNextGap(machine, day, week, minTime, year)` | 1658 | Find next gap on specific machine/day |
| `getMachinesByLoadOrder(machines, week, year)` | 1627 | Sort machines by load (least loaded first) |
| `placerAutomatiquement(commandeId)` | 4510 | Auto-place all 3 operations |
| `handleDrop(e)` | 4055 | Drag & drop handler |
| `splitAtNormalHoursEnd(op, machine, week, year, day, startHour)` | ~8700 | Split operation across days |
| `generateSlotId(operationId, existingSlots)` | 390 | Deterministic slot IDs |

### Capacity
| Function | Line | Purpose |
|----------|------|---------|
| `calculerCapaciteMachine(machine, week, year)` | 1319 | Weekly capacity (hours used) |
| `calculerCapaciteJour(machine, day, week, year)` | 1343 | Daily capacity |
| `getCapacityColorClass(percentage)` | 1384 | Color class for capacity gauge |
| `calculateEndTimeWithBreaks(startDec, duration, day)` | ~1440 | End time accounting for lunch |
| `detectOvertimeOverflow(startDec, duration, day)` | ~1470 | Check if overtime needed |

### Rendering
| Function | Line | Purpose |
|----------|------|---------|
| `renderVueSemaine()` | 2459 | Week view with capacity gauges |
| `renderVueJournee()` | 2695 | Day view with hourly timeline |
| `renderVueListe()` | 6538 | Table view with sorting |
| `renderCommandesNonPlacees(query)` | 3402 | Sidebar unplaced orders |
| `refreshUIOnly()` | ~9745 | Re-render without saving |

### Data Sync
| Function | Line | Purpose |
|----------|------|---------|
| `saveData(cmdId)` | 9716 | Mark dirty + save (debounced 500ms) |
| `saveDataImmediate(cmdId)` | 9730 | Mark dirty + save NOW |
| `markCommandeDirty(cmdId)` | 9702 | Add to `_dirtyCommandeIds` |
| `upsertCommandeToSupabase(cmd)` | 5161 | Full write: cmd + ops + slots + orphan cleanup |

### Utilities
| Function | Line | Purpose |
|----------|------|---------|
| `timeToDecimalHours(timeStr)` | 398 | HH:MM:SS → decimal hours |
| `getWeekNumber(date)` | ~1150 | Date → ISO week number |
| `getDateFromWeekDay(week, day, time, year)` | ~2440 | Week+day+time → Date |
| `formatHours(hours)` | ~2020 | 3.5 → "3h30" |
| `formatDecimalTime(decimal)` | 4049 | 9.5 → "09:30" |
| `escapeHtml(text)` | 3453 | XSS protection |

---

## Order Statuses

| Status | Visible | Where |
|--------|---------|-------|
| `En prepa` | Yes | Sidebar (unplaced ops) + Planning (placed ops) |
| `Non placee` | Yes | Sidebar only |
| `En cours` | Yes | Planning + sidebar (partial) |
| `Planifiee` | Yes | Planning only |
| `Terminee` | No | Filtered out |
| `Livree` | No | Filtered out |

Status checks are **case-insensitive** (`toLowerCase().trim()`).

---

## Supabase Configuration

| Setting | Value |
|---------|-------|
| URL | `https://veyqcnoaiqotikpjfgjq.supabase.co` |
| Anon Key | `sb_publishable_wa6y4sYvbvKtzSFBzw7lBg_CYdxXr1P` |
| Realtime | Enabled on: commandes, operations, slots, machines, system_events, shifts, shift_schedules, breaks, overtime_config, overtime_slots |
| RLS | Disabled (no auth for now) |

### Google Sheets → Supabase Sync

Google Apps Script runs every 5 minutes:
1. Compares MD5 hash of each row with cache
2. Batch upserts changed rows (commandes + operations)
3. Filters on last 2 months for performance

| Sheet Column | Index | Supabase Table.Field |
|-------------|-------|---------------------|
| Fin de Prod | 0 | commandes.date_livraison |
| Code cde | 1 | commandes.id |
| STATUT | 2 | commandes.statut |
| Client | 3 | commandes.client_name |
| Poids | 4 | commandes.poids |
| CISAILLE | 5 | operations.duree_total (Cisaillage) |
| POINCON | 6 | operations.duree_total (Poinconnage) |
| PLIAGE | 7 | operations.duree_total (Pliage) |
| Ref cde client | 8 | commandes.ref_cde_client |

---

## Known Fixes & Architecture Decisions

### Phase 1 — Realtime Loop Prevention
- **Problem:** Realtime handlers called `refresh()` → `saveLocalData()` → re-upload to Supabase → ping-pong loop
- **Fix:** Created `refreshUIOnly()` (no save), `saveLocalStorageOnly()`, `debouncedRealtimeUpdate()`. Handlers only update UI + localStorage.

### Phase 1 — Dirty Tracking
- **Problem:** `saveAllToSupabase()` uploaded ALL 850 commandes on every save
- **Fix:** `_dirtyCommandeIds` Set tracks only modified commands. `markCommandeDirty(id)` adds IDs. `saveAllToSupabase()` returns early if set is empty.

### Phase 2 — Orphan Slot Cleanup
- **Problem:** `handleDrop()` clears `operation.slots = []` then creates new slot with new ID. Old slot never deleted from Supabase → ghost/duplicate slots on other clients.
- **Fix:** `upsertCommandeToSupabase()` now SELECTs existing Supabase slot IDs, compares with local, DELETEs orphans before upserting.

### Phase 2 — Fragment Slot IDs
- **Problem:** 3 branches in `handleDrop()` created fragment slots (via `splitAtNormalHoursEnd()`) without IDs. `upsertCommandeToSupabase()` filtered out slots without IDs → fragments never persisted.
- **Fix:** Added `id: generateSlotId(operation.id, fragments.slice(0, index))` to all 3 fragment `.map()` calls.

### Phase 2 — Debounce Optimization
- Save debounce: 2000ms → 500ms
- `_isSaving` guard: 3000ms → 1500ms
- `handleDrop()` uses `saveDataImmediate()` (no debounce) for instant sync

### Console Noise Reduction
- `REALTIME_DEBUG = false` silences `🔇 Realtime ignore` logs
- Set to `true` in console for debugging

---

## Important Constraints

1. **Chronological order** Cisaillage → Poinconnage → Pliage is immutable
2. **ISO week-based planning** with year rollover handling
3. **French language** throughout UI and data (day names, statuses)
4. **Lunch break** 12:30-13:00 Mon-Thu enforced in gap-finding
5. **Freeze protection** current/next day modifications require confirmation
6. **Overbooking** allowed up to 105% with visual warning
7. **No backend** beyond Supabase — all logic is client-side
8. **~850 commandes** in production (38 active) — performance-sensitive
9. **Multi-user** via Supabase Realtime (latency ~1.2-1.7s)
10. **localStorage** serves as offline fallback (~5MB limit)

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


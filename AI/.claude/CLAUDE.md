# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ETM PROD V2** is an advanced production planning tool for an industrial bending workshop (Aluminum/Galvanized steel). This is a vanilla JavaScript prototype that manages order scheduling across multiple machines with strict operational sequence requirements.

### Core Domain Knowledge

**Machine Park:**
- 2 Cisailles (Shears): Cisaille A, Cisaille B
- 2 Poinçonneuses (Punching machines): Poinçonneuse A, Poinçonneuse B
- 3 Plieuses (Bending machines): Plieuse Lo, Plieuse Mik, Plieuse Mok

**Production Capacity:**
- Monday-Thursday: 8.5h/day (07:30-16:30 with 30min lunch break 12:30-13:00)
- Friday: 5h (07:00-12:00)
- Total weekly: 39h

**🔒 CRITICAL BUSINESS RULE - CHRONOLOGICAL ORDER:**

The most critical constraint in this codebase is the **MANDATORY CHRONOLOGICAL ORDER** of operations:

```
Cisaillage (Shearing) → Poinçonnage (Punching) → Pliage (Bending)
```

This order is **NON-REVERSIBLE and STRICTLY ENFORCED**. Each operation must **COMPLETE** before the next one can **BEGIN**. This is validated throughout the codebase, particularly in:
- `validateOperationOrder()` - app.js:608
- `canPlaceOperation()` - app.js:649
- Drag & drop handling - app.js:1131

**NEVER allow operations to be placed out of chronological order in the planning schedule.**

## Architecture

### Data Model

Commands follow a slot-based system where operations can be split across multiple time slots:

```javascript
{
  id: "CC25-1001",
  client: "SPEBI",
  poids: 150,              // Weight in kg
  materiau: "Aluminium",   // Material type
  statut: "En cours",      // En cours / Planifiée / Non placée / Terminée / Livrée
  operations: [
    {
      type: "Cisaillage",
      dureeTotal: 3,         // Calculated: poids * DUREE_PAR_KG[type]
      slots: [               // Can be split across multiple slots
        {
          machine: "Cisaille A",
          duree: 3,
          semaine: 50,       // Week number
          jour: "Lundi",     // Day name
          heureDebut: "09:00",
          heureFin: "12:00",
          dateDebut: "2025-12-09T09:00:00",
          dateFin: "2025-12-09T12:00:00"
        }
      ],
      progressionReelle: 75,
      statut: "En cours"
    }
    // ... more operations
  ]
}
```

### Duration Calculation System

Operation durations are **automatically calculated** based on material weight using coefficients defined in app.js:30-34:

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

**Note:** The system now loads real order data from an embedded CSV (Google Sheets export). Durations come directly from the data source (parsed from HH:MM:SS format) rather than being calculated by weight for existing orders.

Use `calculerDureeOperation(type, poids)` to compute durations for new orders - **never hardcode durations**.

### View System

The application has two complementary views:

1. **Vue Semaine (Week View)** - `renderVueSemaine()` at app.js:765
   - Overview of 3 weeks (weeks 50-52)
   - Capacity gauges per machine
   - Command badges per week
   - Click on week cells to switch to day view

2. **Vue Journée (Day View)** - `renderVueJournee()` at app.js:860
   - Detailed hourly timeline (07:00-17:00 with lunch break 12:30-13:00, Friday 07:00-12:00)
   - Multiple operations per machine/day
   - Drag & drop enabled for:
     - Moving existing operations between slots
     - **NEW:** Placing individual operations from sidebar to planning
   - Capacity indicators per day
   - Smart gap-finding algorithm (`findFirstAvailableGap()`) for optimal placement

Current view is tracked in `vueActive` variable ('semaine' or 'journee').

### Drag & Drop System

Implemented using HTML5 Drag & Drop API (app.js:1088-1216):

- **Draggable elements:** `.operation-slot.draggable` in day view
- **Drop zones:** `.drop-zone` (hourly time slots)
- **Validation:** `canPlaceOperation()` is called on drop to enforce chronological order
- **State management:** Dropped slot is updated with new machine/day/week/times

When moving operations, the system:
1. Saves old slot data
2. Applies new values temporarily
3. Validates chronological order
4. Rolls back if invalid or commits if valid

### Capacity Management

Three capacity calculation functions:

- `calculerCapaciteMachine(machine, semaine)` - Weekly capacity (app.js:519)
- `calculerCapaciteJour(machine, jour, semaine)` - Daily capacity (app.js:535)
- `getCapacityColorClass(pourcentage)` - Visual color coding (app.js:557)

**Capacity color thresholds:**
- 0-75%: Green (capacity-ok)
- 76-95%: Orange (capacity-warning)
- 96-100%+: Red (capacity-danger)

### Automatic Placement Algorithm

`placerAutomatiquement(commandeId)` at app.js:1225:

1. Validates order structure with `validateOperationOrder()`
2. For each operation (in sequence):
   - Gets compatible machines
   - Searches weeks 50-52, all days
   - For each potential slot, validates with `canPlaceOperation()`
   - Places in first available slot with sufficient capacity
3. Updates command status to "Planifiée"

The algorithm **respects chronological order** - operations are placed sequentially and only in slots that don't violate timing constraints.

## Development Commands

This is a static HTML/CSS/JS application with no build process:

**To run the application:**
```bash
# Open in browser (Windows)
start index.html

# Or directly open the file in any modern browser
```

**No build, lint, or test commands** - this is a prototype/mockup application.

## File Structure

```
ETM Prod/
├── index.html          # Main UI structure with modals
├── styles.css          # Complete styling (CSS Grid, Flexbox, drag&drop)
├── app.js              # All application logic (~1500 lines)
└── README.md           # Comprehensive documentation in French
```

**Single-page application:** All logic is in app.js, no modules or dependencies.

## Critical Functions to Understand

When modifying scheduling logic, these are the key functions:

1. **Order Validation:**
   - `validateOperationOrder(commande)` - app.js:608 - Validates 3 operations exist in correct sequence
   - `canPlaceOperation(commande, operation, targetWeek, targetDay, targetStartTime)` - app.js:649 - Validates chronological timing

2. **Capacity Calculations:**
   - `calculerCapaciteMachine(machine, semaine)` - app.js:519
   - `calculerCapaciteJour(machine, jour, semaine)` - app.js:535

3. **Rendering:**
   - `renderVueSemaine()` - app.js:765 - Week view grid
   - `renderVueJournee()` - app.js:860 - Day view with timeline
   - `renderCommandesNonPlacees()` - app.js:1031 - Sidebar unplaced orders

4. **User Actions:**
   - `placerAutomatiquement(commandeId)` - app.js:1225 - Auto-placement algorithm
   - `handleDrop(e)` - app.js:1131 - Drag & drop handler

5. **Utilities:**
   - `calculerDureeOperation(type, poids)` - app.js:451
   - `getDateFromWeekDay(weekNumber, dayName, timeStr)` - app.js:730
   - `formatHours(hours)` - app.js:589

## Data Source

The application loads **real production data** from an embedded CSV (Google Sheets export):
- **CSV data** embedded in `localCsvData` constant (app.js:46-79)
- **Parsing** via `fetchAndParseCSV()` - tab-separated values with error handling (app.js:86)
- **Mapping** via `mapSheetRowToOrder()` - converts CSV rows to application format (app.js:116)
- **Loading** via `loadOrders()` - filters and populates global state (app.js:167)
- **Filtering** by status: **"En cours"**, **"En prépa"**, **"Planifiée"** (case-insensitive)
- **Duration conversion** from HH:MM:SS format to decimal hours via `timeToDecimalHours()` (app.js:105)
- **Storage** in global `commandes` array (app.js:185)
- **Initialization** via `loadOrders()` called in `init()` (app.js:1431)

**Note:** Previously referenced `GOOGLE_SHEET_CSV_URL` for external fetching, but now uses embedded CSV data for simplicity and offline capability.

**Order Statuses:**
- **"En prépa"**: Order ready but no operations placed yet (appears in sidebar)
  - **Filtering logic:** Uses case-insensitive comparison (`toLowerCase().trim()`) to handle variations
  - **Sidebar display:** Only shows if at least ONE operation has no slots (app.js:267)
  - **Smart rendering:** Skips cards with no unplaced operations to avoid empty displays
- **"Planifiée"**: All operations placed in planning
- **"En cours"**: Order currently being executed
- **"Terminée"**: Completed (filtered out, not displayed)
- **"Livrée"**: Delivered (filtered out, not displayed)

**IMPORTANT:**
- Partially placed orders (status "En prépa" with some operations placed) appear in **both** sidebar (for unplaced ops) AND planning view (for placed ops)
- `getPlacedOrders()` includes "En prépa" commands with ≥1 placed operation (app.js:246)
- `getUnplacedOrders()` includes "En prépa" commands with ≥1 unplaced operation (app.js:267)

Reference date is simulated at `currentTime = new Date('2025-12-11T14:00:00')` (app.js:37).

## Common Modification Scenarios

**Modifying duration coefficients:**
Edit `DUREE_PAR_KG` object at app.js:30-34

**Adding a new machine:**
Update `MACHINES` object at app.js:6-10 and `ALL_MACHINES` array at app.js:12-16

**Changing working hours:**
Update `HOURS_PER_DAY` object at app.js:18-24

**Adding a material type:**
Update the select dropdown in index.html:179-182

**Changing color scheme:**
Modify CSS variables in styles.css:5-23 (`:root` section)

## Important Constraints

1. **No backend:** All data is in-memory, reloads reset everything
2. **Week 50-52 only:** Planning is fixed to these 3 weeks in 2025
3. **French language:** All UI text, dates, and time formats are in French
4. **No mobile support:** Optimized for tablets 10"+ and desktop only
5. **Chronological order enforcement:** Cannot be disabled or bypassed
6. **Operation order is immutable:** The sequence Cisaillage → Poinçonnage → Pliage in the operations array must be maintained
7. **Lunch break:** 30-minute break from 12:30-13:00 (Mon-Thu) is enforced in the `findFirstAvailableGap()` algorithm
8. **Partially placed orders:** Orders with some operations placed but not all (status "En prépa") now correctly appear in planning view (fixed in app.js:246)

## Future Roadmap (V3)

The README.md describes a planned React rewrite with:
- Backend API (Node.js/Express)
- PostgreSQL database
- JWT authentication
- WebSockets for real-time updates
- DHTMLX Gantt Pro integration

**This V2 is a prototype/mockup** - prioritize clarity and demonstration over production patterns.

## Testing Considerations

Since this is a mockup with no test framework:

- Test chronological order validation manually by attempting invalid placements
- Verify capacity calculations with different order weights
- Test drag & drop across different machines and days
- Ensure Friday 5h constraint is respected (vs 8.5h other days)
- Test automatic placement with urgent orders (< 5 days to delivery)
- Check console logs for data loading diagnostics (status counts, unplaced orders)

## Known Issues Fixed

**Issue 1: Empty Sidebar (Fixed)**
- **Problem:** "Commandes à placer" sidebar was empty despite having "En prépa" orders
- **Cause:** `getUnplacedOrders()` used strict string comparison and didn't check for unplaced operations
- **Fix:** Case-insensitive status check + validation that at least one operation has no slots (app.js:299)

**Issue 5: "En Cours" Orders Not Appearing in Planning (Fixed)**
- **Problem:** Only 2 out of 7 active orders appeared in planning view (missing 4 "En Cours" orders)
- **Cause:** `getPlacedOrders()` used strict comparison `["En cours", "Planifiée"].includes()` but CSV has "En Cours" (capital C)
- **Fix:** Case-insensitive status comparison using `toLowerCase().trim()` for all status checks (app.js:278)

**Issue 2: Operations Not Appearing After Manual Placement (Fixed)**
- **Problem:** Operations placed via drag & drop from sidebar didn't appear in planning until all 3 were placed
- **Cause:** `getPlacedOrders()` only returned "En cours" or "Planifiée" status, excluding partially placed "En prépa" orders
- **Fix:** Include "En prépa" orders with at least one placed operation (app.js:246)

**Issue 3: `GOOGLE_SHEET_CSV_URL is not defined` (Fixed)**
- **Problem:** Console error on app initialization
- **Cause:** `loadOrders()` called `fetchAndParseCSV(GOOGLE_SHEET_CSV_URL)` but function takes no parameters and uses embedded `localCsvData`
- **Fix:** Removed parameter from function call, added error handling and logging (app.js:168)

**Issue 4: Empty Command Cards in Sidebar (Fixed)**
- **Problem:** Cards appeared in sidebar with no operations to display
- **Cause:** Rendering didn't check if operations HTML was empty before creating card
- **Fix:** Build operations HTML first, skip card if empty, show message if no cards to display (app.js:840)
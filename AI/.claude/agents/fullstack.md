# Fullstack Agent - ETM PROD V2/V3

## Role
Full-stack developer capable of working across frontend, backend, and database layers for the ETM PROD production planning system.

## Scope
Handle end-to-end feature development, from database schema to UI implementation, ensuring consistency across all layers.

## Technology Overview

### V2 (Current - Prototype)
- **Frontend**: Vanilla JS + HTML + CSS
- **Backend**: None (in-memory data)
- **Database**: None (demo data in `commandesDemo` array)

### V3 (Future - Production)
- **Frontend**: React 18+ (migration planned)
- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Real-time**: WebSocket (Socket.io)
- **State**: Zustand or Jotai

## Core Competencies

### 1. Business Logic Understanding

**Critical Rule - Chronological Order:**
- Cisaillage must **complete** before Poinçonnage **starts**
- Poinçonnage must **complete** before Pliage **starts**
- This is enforced in both frontend validation and backend API

**Duration Calculations:**
```javascript
// Frontend & Backend must use same formula
const DUREE_PAR_KG = {
    'Cisaillage': 0.02,
    'Poinçonnage': 0.015,
    'Pliage': 0.025
};

function calculerDuree(type, poids) {
    return poids * DUREE_PAR_KG[type];
}
```

**Capacity Management:**
- Mon-Thu: 8h/day
- Friday: 5h/day
- Track per machine, per day, per week
- Color-coded: Green (0-75%), Orange (76-95%), Red (96-100%+)

### 2. Data Flow (V2)

```
User Action
    ↓
Event Handler (app.js)
    ↓
Business Logic Validation
    ↓
Update commandesDemo array
    ↓
Re-render UI
    ↓
Update DOM
```

**Example: Drag & Drop Flow**
```javascript
handleDrop(e) {
  // 1. Get target position
  const targetMachine = e.target.dataset.machine;
  const targetDay = e.target.dataset.day;

  // 2. Find data
  const cmd = commandesDemo.find(...);
  const operation = cmd.operations.find(...);
  const slot = operation.slots.find(...);

  // 3. Validate chronological order
  const validation = canPlaceOperation(cmd, operation, week, day, time);
  if (!validation.valid) {
    alert(validation.message);
    return;
  }

  // 4. Update data
  slot.machine = targetMachine;
  slot.jour = targetDay;
  // ... update times

  // 5. Re-render
  renderVueJournee();
}
```

### 3. Data Flow (V3 - Planned)

```
User Action (React)
    ↓
State Update (Zustand)
    ↓
API Call (fetch/axios)
    ↓
Backend Validation
    ↓
Database Update (PostgreSQL)
    ↓
WebSocket Broadcast
    ↓
All Clients Update
    ↓
React Re-render
```

## Feature Development Workflow

### Adding a New Feature (V2)

**Example: Add "Duplicate Command" feature**

**1. Plan the Feature**
- What: Clone existing command with new ID
- Where: Add button in command details modal
- Validation: Ensure chronological order in cloned operations

**2. Frontend (HTML)**
```html
<!-- In modalOrderDetails -->
<button class="btn btn-primary" onclick="duplicateCommand('${cmd.id}')">
  Dupliquer la commande
</button>
```

**3. Frontend (CSS)**
```css
/* Add any specific styles */
.btn-duplicate {
  /* ... */
}
```

**4. Business Logic (JS)**
```javascript
function duplicateCommand(commandeId) {
  const original = commandesDemo.find(c => c.id === commandeId);

  // Generate new ID
  const newId = generateNewCommandId();

  // Deep clone
  const duplicate = JSON.parse(JSON.stringify(original));
  duplicate.id = newId;
  duplicate.statut = 'Non placée';

  // Clear slots
  duplicate.operations.forEach(op => {
    op.slots = [];
    op.statut = 'Non placée';
  });

  // Add to array
  commandesDemo.push(duplicate);

  // Refresh UI
  refresh();

  alert(`Commande ${newId} créée par duplication`);
}

// Make globally accessible
window.duplicateCommand = duplicateCommand;
```

**5. Test Manually**
- Open browser, test duplication
- Verify new command appears in sidebar
- Try auto-placement
- Verify chronological order respected

### Adding a New Feature (V3)

**Example: Add "Duplicate Command" feature**

**1. Database Migration**
```sql
-- No schema changes needed for duplication
-- But add audit log if desired
CREATE TABLE command_audit (
  id SERIAL PRIMARY KEY,
  command_id VARCHAR(50),
  action VARCHAR(50),
  user_id INTEGER,
  timestamp TIMESTAMP DEFAULT NOW()
);
```

**2. Backend API**
```javascript
// POST /api/commandes/:id/duplicate
router.post('/commandes/:id/duplicate', authenticate, async (req, res) => {
  const { id } = req.params;

  // Find original
  const original = await db.commandes.findUnique({
    where: { id },
    include: { operations: { include: { slots: true } } }
  });

  if (!original) {
    return res.status(404).json({ error: 'Command not found' });
  }

  // Generate new ID
  const newId = await generateNewCommandId();

  // Create duplicate (without slots)
  const duplicate = await db.commandes.create({
    data: {
      id: newId,
      client: original.client,
      dateLivraison: original.dateLivraison,
      materiau: original.materiau,
      poids: original.poids,
      ressource: original.ressource,
      statut: 'Non placée',
      operations: {
        create: original.operations.map(op => ({
          type: op.type,
          dureeTotal: op.dureeTotal,
          ordre: op.ordre,
          statut: 'Non placée',
          progressionReelle: 0
        }))
      }
    },
    include: { operations: true }
  });

  // Audit log
  await db.commandAudit.create({
    data: {
      commandId: newId,
      action: 'DUPLICATE',
      userId: req.user.id
    }
  });

  // Broadcast to all clients
  io.emit('command:created', duplicate);

  res.status(201).json(duplicate);
});
```

**3. Frontend (React)**
```jsx
// CommandDetailsModal.jsx
function CommandDetailsModal({ command }) {
  const duplicateCommand = async () => {
    try {
      const response = await fetch(`/api/commandes/${command.id}/duplicate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) throw new Error('Duplication failed');

      const newCommand = await response.json();

      // Update state
      addCommand(newCommand);

      toast.success(`Commande ${newCommand.id} créée par duplication`);
    } catch (error) {
      toast.error('Erreur lors de la duplication');
    }
  };

  return (
    <Modal>
      <ModalHeader>Détails de la commande</ModalHeader>
      <ModalBody>
        {/* ... details ... */}
      </ModalBody>
      <ModalFooter>
        <Button onClick={duplicateCommand}>
          Dupliquer la commande
        </Button>
      </ModalFooter>
    </Modal>
  );
}
```

**4. WebSocket Handler (React)**
```javascript
// Listen for real-time updates
useEffect(() => {
  socket.on('command:created', (newCommand) => {
    addCommand(newCommand);
    toast.info(`Nouvelle commande: ${newCommand.id}`);
  });

  return () => socket.off('command:created');
}, []);
```

**5. Test End-to-End**
- Backend: Unit test API endpoint
- Frontend: Test button click
- WebSocket: Verify other users see update
- Database: Verify data integrity

## Common Full-Stack Scenarios

### Scenario 1: Modify Duration Coefficient

**V2 Approach:**
1. Edit `DUREE_PAR_KG` in app.js:30-34
2. Refresh browser - durations recalculated automatically

**V3 Approach:**
1. Add to database: `CREATE TABLE system_config (key VARCHAR, value JSON)`
2. Backend: API endpoint `GET/PUT /api/config/duree-coefficients`
3. Store in database, cache in memory
4. Frontend: Admin panel to edit coefficients
5. When updated: recalculate all pending operations
6. Broadcast changes via WebSocket

### Scenario 2: Add New Machine

**V2 Approach:**
1. Edit `MACHINES` object in app.js:6-10
2. Add to `ALL_MACHINES` array
3. Update CSS if new machine type (add colors)

**V3 Approach:**
1. Database: Add to `machines` table
2. Backend: CRUD endpoints for machines
3. Frontend: Machine management UI
4. Update planning views dynamically
5. Migration: existing slots reference machine by name (flexible)

### Scenario 3: Extend Planning Horizon

**V2 Approach:**
1. Change week range in rendering functions (hardcoded 50-52)
2. Update `getWeekDateRange()` logic if needed

**V3 Approach:**
1. Database: No schema change (weeks stored as integers)
2. Backend: Accept week range as query params
3. Frontend: Add week navigation (previous/next)
4. Infinite scroll or pagination for long ranges

## Integration Points

### Frontend ↔ Backend
- REST API for CRUD operations
- WebSocket for real-time updates
- JWT in Authorization header
- JSON request/response bodies

### Backend ↔ Database
- ORM (Prisma/TypeORM) for type safety
- Migrations for schema changes
- Transactions for multi-step operations
- Indexes for performance

### Frontend ↔ Frontend (V3 only)
- Shared state via Zustand
- WebSocket broadcasts for multi-user
- Optimistic updates with rollback

## Reference Documentation

Always consult:
1. **`.claude/CLAUDE.md`** - Project overview and architecture
2. **`.claude/agents/front.md`** - Frontend specifics
3. **`.claude/agents/back.md`** - Backend specifics
4. **`README.md`** - User documentation (French)

## Development Principles

1. **Consistency**: Same business logic in frontend validation and backend enforcement
2. **Validation**: Never trust client - validate on server
3. **Atomic Operations**: Use database transactions for multi-step changes
4. **Real-time**: Broadcast changes to all connected clients (V3)
5. **Error Handling**: Graceful degradation, clear error messages
6. **Performance**: Optimize queries, minimize re-renders
7. **Security**: Authenticate, authorize, validate, sanitize

## Migration Checklist (V2 → V3)

- [ ] Set up project structure (monorepo or separate repos)
- [ ] Initialize database with schema
- [ ] Build backend API (REST endpoints)
- [ ] Add authentication system
- [ ] Implement WebSocket server
- [ ] Migrate business logic to backend
- [ ] Create React frontend
- [ ] Integrate state management (Zustand)
- [ ] Connect frontend to API
- [ ] Add WebSocket client
- [ ] Implement error boundaries
- [ ] Add loading states
- [ ] Write tests (Jest, React Testing Library)
- [ ] Set up CI/CD pipeline
- [ ] Deploy to staging
- [ ] User acceptance testing
- [ ] Deploy to production

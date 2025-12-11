# Backend Agent - ETM PROD V2/V3

## Role
Backend developer responsible for API design, database architecture, and server-side logic for ETM PROD.

## Current State (V2)
**V2 is a frontend-only prototype** with no backend. All data is in-memory in `commandesDemo` array (app.js:50).

This agent profile focuses on **planning and building V3** - the production backend.

## V3 Tech Stack (Planned)

### Core Technologies
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL
- **ORM**: Prisma or TypeORM
- **Authentication**: JWT (JSON Web Tokens)
- **Real-time**: WebSockets (Socket.io)
- **API**: REST + WebSocket hybrid

### Additional Tools
- **Validation**: Zod or Joi
- **Testing**: Jest + Supertest
- **Documentation**: OpenAPI/Swagger
- **Logging**: Winston or Pino
- **Environment**: dotenv

## Database Schema Design

### Core Entities

**Commands (Commandes)**
```sql
CREATE TABLE commandes (
  id VARCHAR(50) PRIMARY KEY,
  client VARCHAR(255) NOT NULL,
  date_livraison DATE NOT NULL,
  statut VARCHAR(50) NOT NULL, -- En cours, Planifiée, Non placée, Terminée, Livrée
  materiau VARCHAR(100) NOT NULL,
  poids INTEGER NOT NULL,
  ressource VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Operations**
```sql
CREATE TABLE operations (
  id SERIAL PRIMARY KEY,
  commande_id VARCHAR(50) REFERENCES commandes(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- Cisaillage, Poinçonnage, Pliage
  duree_total DECIMAL(5,2) NOT NULL,
  progression_reelle INTEGER DEFAULT 0,
  statut VARCHAR(50) NOT NULL,
  ordre INTEGER NOT NULL, -- 1, 2, 3 for enforcing sequence
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Slots (Time allocations)**
```sql
CREATE TABLE slots (
  id SERIAL PRIMARY KEY,
  operation_id INTEGER REFERENCES operations(id) ON DELETE CASCADE,
  machine VARCHAR(100) NOT NULL,
  duree DECIMAL(5,2) NOT NULL,
  semaine INTEGER NOT NULL,
  jour VARCHAR(20) NOT NULL,
  heure_debut TIME NOT NULL,
  heure_fin TIME NOT NULL,
  date_debut TIMESTAMP NOT NULL,
  date_fin TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Users (for V3)**
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nom VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL, -- admin, planificateur, operateur
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);
```

### Constraints and Indexes
```sql
-- Enforce operation order
ALTER TABLE operations ADD CONSTRAINT check_ordre CHECK (ordre IN (1, 2, 3));

-- Prevent slot overlap (same machine, overlapping times)
CREATE INDEX idx_slots_machine_date ON slots(machine, date_debut, date_fin);

-- Quick lookups
CREATE INDEX idx_commandes_statut ON commandes(statut);
CREATE INDEX idx_commandes_livraison ON commandes(date_livraison);
CREATE INDEX idx_slots_semaine ON slots(semaine, jour);
```

## API Design

### REST Endpoints

**Commands**
```
GET    /api/commandes              - List all commands (with filters)
GET    /api/commandes/:id          - Get command details
POST   /api/commandes              - Create new command
PUT    /api/commandes/:id          - Update command
DELETE /api/commandes/:id          - Delete command
PATCH  /api/commandes/:id/statut   - Update status only
```

**Planning**
```
GET    /api/planning/semaine/:week           - Get week planning
GET    /api/planning/journee/:week/:day      - Get day planning
POST   /api/planning/auto-place/:commandeId  - Auto-place command
PUT    /api/planning/move-slot/:slotId       - Move slot (drag & drop)
```

**Capacity**
```
GET    /api/capacity/machine/:machine/week/:week  - Machine weekly capacity
GET    /api/capacity/day/:week/:day               - All machines for day
```

**Authentication**
```
POST   /api/auth/login     - Login
POST   /api/auth/logout    - Logout
POST   /api/auth/refresh   - Refresh JWT token
GET    /api/auth/me        - Current user info
```

### Request/Response Examples

**Create Command**
```json
POST /api/commandes
{
  "id": "CC25-1015",
  "client": "SPEBI",
  "dateLivraison": "2025-12-25",
  "materiau": "Aluminium",
  "poids": 150,
  "ressource": "Polyvalent"
}

Response: 201 Created
{
  "id": "CC25-1015",
  "client": "SPEBI",
  "dateLivraison": "2025-12-25",
  "statut": "Non placée",
  "materiau": "Aluminium",
  "poids": 150,
  "ressource": "Polyvalent",
  "operations": [
    {
      "id": 1,
      "type": "Cisaillage",
      "dureeTotal": 3.0,
      "statut": "Non placée",
      "slots": []
    },
    // ... autres opérations
  ]
}
```

**Auto-place Command**
```json
POST /api/planning/auto-place/CC25-1015

Response: 200 OK
{
  "success": true,
  "message": "Commande CC25-1015 placée automatiquement",
  "placedSlots": [
    {
      "operationType": "Cisaillage",
      "machine": "Cisaille A",
      "semaine": 50,
      "jour": "Lundi",
      "heureDebut": "09:00",
      "heureFin": "12:00"
    }
    // ... autres slots
  ]
}
```

## Business Logic Implementation

### Critical Backend Validations

**1. Chronological Order Enforcement**
```javascript
async function validateOperationOrder(commandeId) {
  const operations = await db.operations.findMany({
    where: { commandeId },
    include: { slots: true },
    orderBy: { ordre: 'asc' }
  });

  // Check each operation completes before next one starts
  for (let i = 0; i < operations.length - 1; i++) {
    const currentOp = operations[i];
    const nextOp = operations[i + 1];

    if (currentOp.slots.length > 0 && nextOp.slots.length > 0) {
      const currentEnd = max(currentOp.slots.map(s => s.dateFin));
      const nextStart = min(nextOp.slots.map(s => s.dateDebut));

      if (currentEnd > nextStart) {
        throw new ValidationError('Chronological order violation');
      }
    }
  }
}
```

**2. Capacity Validation**
```javascript
async function validateCapacity(machine, jour, semaine, newDuration) {
  const existingSlots = await db.slots.findMany({
    where: { machine, jour, semaine }
  });

  const totalUsed = existingSlots.reduce((sum, s) => sum + s.duree, 0);
  const capacity = HOURS_PER_DAY[jour];

  if (totalUsed + newDuration > capacity) {
    throw new ValidationError('Capacity exceeded');
  }
}
```

**3. Duration Calculation**
```javascript
function calculateOperationDuration(type, poids) {
  const DUREE_PAR_KG = {
    'Cisaillage': 0.02,
    'Poinçonnage': 0.015,
    'Pliage': 0.025
  };

  return Math.round(poids * DUREE_PAR_KG[type] * 100) / 100;
}
```

### Auto-placement Algorithm (Backend)

```javascript
async function autoPlaceCommand(commandeId) {
  const command = await db.commandes.findUnique({
    where: { id: commandeId },
    include: { operations: true }
  });

  for (const operation of command.operations.sort((a, b) => a.ordre - b.ordre)) {
    const machines = getMachinesForOperationType(operation.type);

    let placed = false;
    for (let week = 50; week <= 52 && !placed; week++) {
      for (const day of DAYS_OF_WEEK) {
        for (const machine of machines) {
          // Check chronological order
          const isValid = await canPlaceOperation(command, operation, week, day, '09:00');
          if (!isValid) continue;

          // Check capacity
          const capacity = await getCapacity(machine, day, week);
          if (capacity.available >= operation.dureeTotal) {
            // Create slot
            await db.slots.create({
              data: {
                operationId: operation.id,
                machine,
                duree: operation.dureeTotal,
                semaine: week,
                jour: day,
                heureDebut: '09:00',
                // ... calculate times
              }
            });

            placed = true;
            break;
          }
        }
      }
    }
  }

  // Update command status
  await db.commandes.update({
    where: { id: commandeId },
    data: { statut: 'Planifiée' }
  });
}
```

## WebSocket Events

**Real-time updates for multi-user:**
```javascript
// Server emits
socket.emit('command:created', commandData);
socket.emit('command:updated', commandData);
socket.emit('slot:moved', { slotId, newMachine, newDay });
socket.emit('capacity:changed', { machine, week, newCapacity });

// Client listens
socket.on('command:created', (data) => {
  // Add to UI
});
```

## Security Considerations

1. **Authentication**: JWT with refresh tokens
2. **Authorization**: Role-based access control (RBAC)
3. **Input Validation**: Validate all inputs with Zod/Joi
4. **SQL Injection**: Use parameterized queries (ORM handles this)
5. **Rate Limiting**: Prevent API abuse
6. **CORS**: Configure properly for frontend origin
7. **Sensitive Data**: Never log passwords or tokens

## Development Workflow

1. **Reference** V2 logic in `app.js` for business rules
2. **Design** database schema first
3. **Implement** core validations (chronological order, capacity)
4. **Build** API endpoints incrementally
5. **Test** with Postman/Insomnia before frontend integration
6. **Document** with OpenAPI/Swagger
7. **Always consult** `.claude/CLAUDE.md` for project context

## Migration Strategy (V2 → V3)

1. Set up Node.js + Express + PostgreSQL
2. Implement database schema
3. Build REST API endpoints
4. Migrate business logic from `app.js`
5. Add authentication layer
6. Implement WebSocket for real-time
7. Update frontend to consume API
8. Deploy to production

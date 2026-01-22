-- =====================================================
-- ETM PROD - SCHEMA SUPABASE
-- =====================================================

-- Activer l'extension UUID si pas déjà fait
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. TABLE: clients
-- =====================================================
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 2. TABLE: machines
-- =====================================================
CREATE TABLE machines (
    id VARCHAR(50) PRIMARY KEY,  -- ex: "cisaille-a"
    name VARCHAR(100) NOT NULL,  -- ex: "Cisaille A"
    type VARCHAR(50) NOT NULL CHECK (type IN ('cisaillage', 'poinconnage', 'pliage')),
    capacity DECIMAL(4,2) DEFAULT 8.5,  -- heures par jour
    color VARCHAR(7) DEFAULT '#10b981',  -- couleur hex
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour filtrer par type
CREATE INDEX idx_machines_type ON machines(type);
CREATE INDEX idx_machines_active ON machines(active);

-- =====================================================
-- 3. TABLE: shifts (équipes)
-- =====================================================
CREATE TABLE shifts (
    id VARCHAR(50) PRIMARY KEY,  -- ex: "jour"
    name VARCHAR(100) NOT NULL,  -- ex: "Équipe Jour"
    active BOOLEAN DEFAULT TRUE,
    days TEXT[] DEFAULT ARRAY['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'],
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 4. TABLE: shift_schedules (horaires par jour)
-- =====================================================
CREATE TABLE shift_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id VARCHAR(50) REFERENCES shifts(id) ON DELETE CASCADE,
    day_name VARCHAR(20) NOT NULL CHECK (day_name IN ('Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche')),
    start_time TIME NOT NULL,  -- ex: 07:30
    end_time TIME NOT NULL,    -- ex: 16:30
    UNIQUE(shift_id, day_name)
);

CREATE INDEX idx_shift_schedules_shift ON shift_schedules(shift_id);

-- =====================================================
-- 5. TABLE: breaks (pauses)
-- =====================================================
CREATE TABLE breaks (
    id VARCHAR(50) PRIMARY KEY,  -- ex: "dejeuner"
    name VARCHAR(100) NOT NULL,  -- ex: "Pause Déjeuner"
    start_time TIME NOT NULL,    -- ex: 12:30
    end_time TIME NOT NULL,      -- ex: 13:00
    days TEXT[] DEFAULT ARRAY['Lundi', 'Mardi', 'Mercredi', 'Jeudi'],
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 6. TABLE: commandes (orders)
-- =====================================================
CREATE TABLE commandes (
    id VARCHAR(50) PRIMARY KEY,  -- ex: "CC25-1001"
    client_id UUID REFERENCES clients(id),
    client_name VARCHAR(255) NOT NULL,  -- dénormalisé pour performance
    date_livraison DATE NOT NULL,
    statut VARCHAR(50) DEFAULT 'En cours' CHECK (statut IN ('En cours', 'Planifiée', 'En prépa', 'Livrée', 'Terminée')),
    materiau VARCHAR(100),  -- ex: "Aluminium", "Galvanisé"
    poids DECIMAL(10,2) DEFAULT 0,  -- en kg
    ref_cde_client VARCHAR(100),  -- référence commande client
    ressource VARCHAR(50),  -- ex: "Polyvalent", "Apprenti"
    semaine_affectee VARCHAR(10),  -- format: "2025-W50" ou NULL
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_commandes_statut ON commandes(statut);
CREATE INDEX idx_commandes_date_livraison ON commandes(date_livraison);
CREATE INDEX idx_commandes_semaine ON commandes(semaine_affectee);
CREATE INDEX idx_commandes_client ON commandes(client_id);

-- =====================================================
-- 7. TABLE: operations
-- =====================================================
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    commande_id VARCHAR(50) REFERENCES commandes(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('Cisaillage', 'Poinçonnage', 'Pliage')),
    duree_total DECIMAL(10,4) DEFAULT 0,  -- en heures décimales
    duree_original DECIMAL(10,4) DEFAULT 0,
    duree_override DECIMAL(10,4),  -- NULL si pas de modification manuelle
    override_timestamp TIMESTAMPTZ,
    progression_reelle DECIMAL(5,2) DEFAULT 0 CHECK (progression_reelle >= 0 AND progression_reelle <= 100),
    statut VARCHAR(50) DEFAULT 'Non placée' CHECK (statut IN ('Non placée', 'Planifiée', 'En cours', 'Terminée')),
    ordre INT DEFAULT 0,  -- ordre d'exécution dans la commande
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_operations_commande ON operations(commande_id);
CREATE INDEX idx_operations_type ON operations(type);
CREATE INDEX idx_operations_statut ON operations(statut);

-- =====================================================
-- 8. TABLE: slots (créneaux d'exécution)
-- =====================================================
CREATE TABLE slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation_id UUID REFERENCES operations(id) ON DELETE CASCADE,
    machine_id VARCHAR(50) REFERENCES machines(id),
    machine_name VARCHAR(100) NOT NULL,  -- dénormalisé
    duree DECIMAL(10,4) NOT NULL,  -- en heures décimales
    semaine INT NOT NULL CHECK (semaine >= 1 AND semaine <= 53),
    jour VARCHAR(20) NOT NULL CHECK (jour IN ('Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche')),
    heure_debut TIME NOT NULL,  -- format HH:MM
    heure_fin TIME NOT NULL,
    date_debut TIMESTAMPTZ NOT NULL,
    date_fin TIMESTAMPTZ NOT NULL,
    overtime BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_slots_operation ON slots(operation_id);
CREATE INDEX idx_slots_machine ON slots(machine_id);
CREATE INDEX idx_slots_semaine ON slots(semaine);
CREATE INDEX idx_slots_date ON slots(date_debut, date_fin);
CREATE INDEX idx_slots_overtime ON slots(overtime);

-- =====================================================
-- 9. TABLE: system_events (maintenance/fermetures)
-- =====================================================
CREATE TABLE system_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL CHECK (type IN ('maintenance', 'fermeture')),
    name VARCHAR(255) NOT NULL,
    date_start DATE NOT NULL,
    date_end DATE NOT NULL,
    start_time_first_day TIME,  -- heure début premier jour
    end_time_last_day TIME,     -- heure fin dernier jour
    full_last_day BOOLEAN DEFAULT TRUE,
    affected_machines TEXT[] DEFAULT ARRAY[]::TEXT[],  -- IDs machines, vide = toutes
    affected_shifts TEXT[] DEFAULT ARRAY[]::TEXT[],    -- IDs équipes, vide = toutes
    description TEXT,
    resolved_conflicts JSONB DEFAULT '{}'::JSONB,
    version INT DEFAULT 2,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_system_events_type ON system_events(type);
CREATE INDEX idx_system_events_dates ON system_events(date_start, date_end);

-- =====================================================
-- 10. TABLE: overtime_config (configuration heures sup)
-- =====================================================
CREATE TABLE overtime_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enabled BOOLEAN DEFAULT FALSE,
    max_daily_hours DECIMAL(4,2) DEFAULT 2,
    max_weekly_hours DECIMAL(4,2) DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 11. TABLE: overtime_slots (créneaux heures sup)
-- =====================================================
CREATE TABLE overtime_slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    overtime_config_id UUID REFERENCES overtime_config(id) ON DELETE CASCADE,
    days TEXT[] NOT NULL,  -- jours concernés
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    max_hours DECIMAL(4,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 12. TABLE: overtime_tracker (suivi heures sup)
-- =====================================================
CREATE TABLE overtime_tracker (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    year INT NOT NULL,
    week_number INT NOT NULL CHECK (week_number >= 1 AND week_number <= 53),
    machine_id VARCHAR(50) REFERENCES machines(id),
    day_name VARCHAR(20),
    hours_used DECIMAL(6,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(year, week_number, machine_id, day_name)
);

CREATE INDEX idx_overtime_tracker_week ON overtime_tracker(year, week_number);

-- =====================================================
-- 13. TABLE: capacity_config (configuration capacité)
-- =====================================================
CREATE TABLE capacity_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    weekly_hours DECIMAL(5,2) DEFAULT 39,
    threshold_ok INT DEFAULT 75,       -- % vert
    threshold_warning INT DEFAULT 95,  -- % orange
    threshold_danger INT DEFAULT 100,  -- % rouge
    overbooking_enabled BOOLEAN DEFAULT FALSE,
    overbooking_max_percentage INT DEFAULT 105,
    overbooking_requires_approval BOOLEAN DEFAULT TRUE,
    overbooking_min_days_advance INT DEFAULT 3,
    overbooking_max_consecutive_days INT DEFAULT 2,
    overbooking_weekend_work BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 14. TABLE: capacity_daily_hours
-- =====================================================
CREATE TABLE capacity_daily_hours (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    capacity_config_id UUID REFERENCES capacity_config(id) ON DELETE CASCADE,
    day_name VARCHAR(20) NOT NULL,
    hours DECIMAL(4,2) NOT NULL,
    UNIQUE(capacity_config_id, day_name)
);

-- =====================================================
-- 15. TABLE: sync_metadata (métadonnées de synchronisation)
-- =====================================================
CREATE TABLE sync_metadata (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type VARCHAR(50) NOT NULL,  -- 'commandes', 'machines', etc.
    last_modified TIMESTAMPTZ DEFAULT NOW(),
    synced_at TIMESTAMPTZ,
    sync_source VARCHAR(50),  -- 'google_sheets', 'local', etc.
    UNIQUE(entity_type)
);

-- =====================================================
-- TRIGGERS pour updated_at automatique
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Appliquer le trigger à toutes les tables avec updated_at
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_machines_updated_at BEFORE UPDATE ON machines FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_shifts_updated_at BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_breaks_updated_at BEFORE UPDATE ON breaks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_commandes_updated_at BEFORE UPDATE ON commandes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_operations_updated_at BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_slots_updated_at BEFORE UPDATE ON slots FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_system_events_updated_at BEFORE UPDATE ON system_events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_overtime_config_updated_at BEFORE UPDATE ON overtime_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_overtime_tracker_updated_at BEFORE UPDATE ON overtime_tracker FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_capacity_config_updated_at BEFORE UPDATE ON capacity_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- DONNÉES INITIALES: Machines
-- =====================================================
INSERT INTO machines (id, name, type, capacity, color, active) VALUES
    ('cisaille-a', 'Cisaille A', 'cisaillage', 8.5, '#10b981', true),
    ('cisaille-b', 'Cisaille B', 'cisaillage', 8.5, '#10b981', true),
    ('poinconneuse-m', 'Poinçonneuse M', 'poinconnage', 8.5, '#2563eb', true),
    ('poinconneuse-t', 'Poinçonneuse T', 'poinconnage', 8.5, '#2563eb', true),
    ('plieuse-lo', 'Plieuse Lo', 'pliage', 8.5, '#ef4444', true),
    ('plieuse-mik', 'Plieuse Mik', 'pliage', 8.5, '#ef4444', true),
    ('plieuse-mok', 'Plieuse Mok', 'pliage', 8.5, '#ef4444', true);

-- =====================================================
-- DONNÉES INITIALES: Shift (Équipe)
-- =====================================================
INSERT INTO shifts (id, name, active, days) VALUES
    ('jour', 'Équipe Jour', true, ARRAY['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi']);

INSERT INTO shift_schedules (shift_id, day_name, start_time, end_time) VALUES
    ('jour', 'Lundi', '07:30', '16:30'),
    ('jour', 'Mardi', '07:30', '16:30'),
    ('jour', 'Mercredi', '07:30', '16:30'),
    ('jour', 'Jeudi', '07:30', '16:30'),
    ('jour', 'Vendredi', '07:00', '12:00');

-- =====================================================
-- DONNÉES INITIALES: Pause
-- =====================================================
INSERT INTO breaks (id, name, start_time, end_time, days, active) VALUES
    ('dejeuner', 'Pause Déjeuner', '12:30', '13:00', ARRAY['Lundi', 'Mardi', 'Mercredi', 'Jeudi'], true);

-- =====================================================
-- DONNÉES INITIALES: Configuration Capacité
-- =====================================================
INSERT INTO capacity_config (weekly_hours, threshold_ok, threshold_warning, threshold_danger, overbooking_enabled)
VALUES (39, 75, 95, 100, false);

-- Récupérer l'ID de la config pour les heures journalières
INSERT INTO capacity_daily_hours (capacity_config_id, day_name, hours)
SELECT id, 'Lundi', 8.5 FROM capacity_config LIMIT 1;
INSERT INTO capacity_daily_hours (capacity_config_id, day_name, hours)
SELECT id, 'Mardi', 8.5 FROM capacity_config LIMIT 1;
INSERT INTO capacity_daily_hours (capacity_config_id, day_name, hours)
SELECT id, 'Mercredi', 8.5 FROM capacity_config LIMIT 1;
INSERT INTO capacity_daily_hours (capacity_config_id, day_name, hours)
SELECT id, 'Jeudi', 8.5 FROM capacity_config LIMIT 1;
INSERT INTO capacity_daily_hours (capacity_config_id, day_name, hours)
SELECT id, 'Vendredi', 5 FROM capacity_config LIMIT 1;

-- =====================================================
-- DONNÉES INITIALES: Configuration Heures Sup
-- =====================================================
INSERT INTO overtime_config (enabled, max_daily_hours, max_weekly_hours) VALUES (false, 2, 10);

INSERT INTO overtime_slots (overtime_config_id, days, start_time, end_time, max_hours)
SELECT id, ARRAY['Lundi', 'Mardi', 'Mercredi', 'Jeudi'], '16:30', '18:00', 1.5 FROM overtime_config LIMIT 1;
INSERT INTO overtime_slots (overtime_config_id, days, start_time, end_time, max_hours)
SELECT id, ARRAY['Vendredi'], '12:00', '14:00', 2 FROM overtime_config LIMIT 1;

-- =====================================================
-- DONNÉES INITIALES: Sync Metadata
-- =====================================================
INSERT INTO sync_metadata (entity_type, last_modified) VALUES
    ('commandes', NOW()),
    ('machines', NOW()),
    ('shifts', NOW()),
    ('breaks', NOW()),
    ('system_events', NOW());

-- =====================================================
-- ROW LEVEL SECURITY (optionnel - à activer si besoin)
-- =====================================================
-- ALTER TABLE commandes ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE slots ENABLE ROW LEVEL SECURITY;
-- etc.

-- =====================================================
-- FIN DU SCRIPT
-- =====================================================

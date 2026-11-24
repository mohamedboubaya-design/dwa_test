-- ============================================================================
-- DWA – Algerian Pharmacy Stock, Reservation & Prescription Platform
-- Migration: 001_initial_schema.sql
-- Target:    Supabase PostgreSQL 15+ with PostGIS & pg_trgm
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Schema & Extensions
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS public;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. ENUM Types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('patient', 'pharmacist', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE shift_type AS ENUM ('night', 'weekend', 'holiday');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE equivalence_type AS ENUM ('exact_generic', 'therapeutic_alternative');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE reservation_status AS ENUM (
    'pending_payment', 'confirmed_held', 'ready_for_pickup',
    'completed', 'expired', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_purpose AS ENUM ('reservation_deposit', 'pro_plan');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE prescription_status AS ENUM ('uploaded', 'answered', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE availability_status AS ENUM ('available', 'partial', 'unavailable');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE alert_type AS ENUM ('back_in_stock', 'refill_reminder');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- DOMAIN A: Users & License Verification
-- ---------------------------------------------------------------------------

-- 2. users
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE
                    CONSTRAINT email_lowercase CHECK (email = lower(email)),
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'patient',
  full_name       TEXT NOT NULL,
  phone           TEXT,
  chifa_card_number TEXT,
  law_18_07_consent_at TIMESTAMPTZ,           -- Algerian Personal Data Law 18-07
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. pharmacist_verifications
CREATE TABLE IF NOT EXISTS pharmacist_verifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  license_number        TEXT NOT NULL UNIQUE,
  document_storage_path TEXT NOT NULL,
  status                verification_status NOT NULL DEFAULT 'pending',
  rejection_reason      TEXT,
  reviewed_by           UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cannot self-review
  CONSTRAINT no_self_review
    CHECK (reviewed_by IS DISTINCT FROM user_id),

  -- Rejection requires a reason
  CONSTRAINT rejection_needs_reason
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),

  -- Non-pending statuses require reviewer info
  CONSTRAINT decided_needs_reviewer
    CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- DOMAIN B: Pharmacies, Catalogue & Batch Stock
-- ---------------------------------------------------------------------------

-- 4. pharmacies
CREATE TABLE IF NOT EXISTS pharmacies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  wilaya          TEXT NOT NULL,
  commune         TEXT NOT NULL,
  address         TEXT NOT NULL,
  phone           TEXT,
  location        geography(Point, 4326),
  opening_hours   JSONB NOT NULL DEFAULT '{}'::jsonb,
  pro_plan_until  TIMESTAMPTZ,                -- Active Pro if pro_plan_until > now()
  rating_avg      NUMERIC(3,2)
                    CONSTRAINT rating_range CHECK (rating_avg IS NULL OR (rating_avg >= 1 AND rating_avg <= 5)),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. pharmacy_on_duty_rotas
CREATE TABLE IF NOT EXISTS pharmacy_on_duty_rotas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id   UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  duty_date     DATE NOT NULL,
  shift_type    shift_type NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  notes         TEXT,

  CONSTRAINT ends_after_starts CHECK (ends_at > starts_at),
  CONSTRAINT unique_duty UNIQUE (pharmacy_id, duty_date, shift_type)
);

-- 6. medicines (Master Catalogue)
CREATE TABLE IF NOT EXISTS medicines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commercial_name     TEXT NOT NULL,
  generic_dci_name    TEXT NOT NULL,
  strength            TEXT,
  dosage_form         TEXT,
  barcode_ean         TEXT UNIQUE
                        CONSTRAINT valid_ean CHECK (barcode_ean ~ '^\d{8,14}$'),
  is_prescription_only BOOLEAN NOT NULL DEFAULT true,
  chifa_reimbursable  BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. medicine_equivalents (Self-referencing M:N join)
CREATE TABLE IF NOT EXISTS medicine_equivalents (
  medicine_id       UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  equivalent_id     UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  equivalence_type  equivalence_type NOT NULL,
  notes             TEXT,

  PRIMARY KEY (medicine_id, equivalent_id),
  CONSTRAINT no_self_equivalence CHECK (medicine_id <> equivalent_id)
);

-- 8. pharmacy_stock (Inventory per batch)
CREATE TABLE IF NOT EXISTS pharmacy_stock (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id         UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  medicine_id         UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_barcode       TEXT NOT NULL,
  production_date     DATE,
  expiry_date         DATE NOT NULL,
  total_quantity      INT NOT NULL DEFAULT 0,
  reserved_quantity   INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 5,
  price_dzd           NUMERIC(10,2),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Batch uniqueness per pharmacy+medicine
  CONSTRAINT unique_batch UNIQUE (pharmacy_id, medicine_id, batch_barcode),

  -- Composite FK target for reservations
  CONSTRAINT unique_stock_pharmacy UNIQUE (id, pharmacy_id),

  -- Last-box race protection
  CONSTRAINT stock_quantity_check
    CHECK (total_quantity >= reserved_quantity AND reserved_quantity >= 0)
);

-- ---------------------------------------------------------------------------
-- DOMAIN C: Reservations, Payments & Ratings
-- ---------------------------------------------------------------------------

-- 9. reservations
CREATE TABLE IF NOT EXISTS reservations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID NOT NULL REFERENCES users(id),
  pharmacy_id         UUID NOT NULL REFERENCES pharmacies(id),
  stock_id            UUID NOT NULL,
  quantity            INT NOT NULL CONSTRAINT positive_quantity CHECK (quantity > 0),
  status              reservation_status NOT NULL DEFAULT 'pending_payment',
  hold_duration_hours SMALLINT NOT NULL CONSTRAINT valid_hold CHECK (hold_duration_hours IN (2, 4)),
  hold_expires_at     TIMESTAMPTZ,
  pickup_code         TEXT CONSTRAINT valid_pickup_code CHECK (pickup_code ~ '^\d{6}$'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK to pharmacy_stock (ensures stock belongs to the pharmacy)
  CONSTRAINT fk_stock_pharmacy
    FOREIGN KEY (stock_id, pharmacy_id) REFERENCES pharmacy_stock(id, pharmacy_id)
);

-- 10. payments
CREATE TABLE IF NOT EXISTS payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chargily_checkout_id  TEXT UNIQUE,            -- Webhook idempotency key
  payment_purpose       payment_purpose NOT NULL,
  reservation_id        UUID REFERENCES reservations(id),
  pharmacy_id           UUID NOT NULL REFERENCES pharmacies(id),
  amount_dzd            NUMERIC(12,2) NOT NULL CONSTRAINT positive_amount CHECK (amount_dzd > 0),
  status                payment_status NOT NULL DEFAULT 'pending',
  webhook_verified      BOOLEAN NOT NULL DEFAULT false,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Polymorphic check: reservation_deposit needs reservation_id; pro_plan must NOT have one
  CONSTRAINT payment_purpose_consistency CHECK (
    (payment_purpose = 'reservation_deposit' AND reservation_id IS NOT NULL)
    OR
    (payment_purpose = 'pro_plan' AND reservation_id IS NULL)
  )
);

-- 11. pharmacy_ratings
CREATE TABLE IF NOT EXISTS pharmacy_ratings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES users(id),
  pharmacy_id     UUID NOT NULL REFERENCES pharmacies(id),
  reservation_id  UUID NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE, -- 1 review per completed reservation
  rating          SMALLINT NOT NULL
                    CONSTRAINT valid_rating CHECK (rating >= 1 AND rating <= 5),
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- DOMAIN D: Prescriptions, Alerts & Demand Analytics
-- ---------------------------------------------------------------------------

-- 12. prescriptions
CREATE TABLE IF NOT EXISTS prescriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_storage_path  TEXT NOT NULL,
  wilaya              TEXT,
  patient_notes       TEXT,
  status              prescription_status NOT NULL DEFAULT 'uploaded',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 13. prescription_responses
CREATE TABLE IF NOT EXISTS prescription_responses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id       UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  pharmacy_id           UUID NOT NULL REFERENCES pharmacies(id),
  pharmacist_id         UUID NOT NULL REFERENCES users(id),
  availability_status   availability_status NOT NULL,
  response_notes        TEXT,
  referred_pharmacy_id  UUID REFERENCES pharmacies(id),
  responded_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14. stock_alerts_reminders
CREATE TABLE IF NOT EXISTS stock_alerts_reminders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_id         UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  pharmacy_id         UUID REFERENCES pharmacies(id) ON DELETE CASCADE,
  alert_type          alert_type NOT NULL,
  refill_interval_days INT,
  next_trigger_at     TIMESTAMPTZ,
  last_notified_at    TIMESTAMPTZ,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 15. search_logs
CREATE TABLE IF NOT EXISTS search_logs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  medicine_id     UUID REFERENCES medicines(id) ON DELETE SET NULL,
  raw_query       TEXT NOT NULL,
  wilaya          TEXT,
  search_point    geography(Point, 4326),
  results_count   INT NOT NULL DEFAULT 0,
  found_in_stock  BOOLEAN NOT NULL DEFAULT false,
  searched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- FUNCTIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- fn_stock_status: Derive stock status from available quantity & threshold
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_stock_status(available INT, threshold INT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN available <= 0       THEN 'out_of_stock'
    WHEN available <= threshold THEN 'low_stock'
    ELSE                           'in_stock'
  END;
$$;

-- ---------------------------------------------------------------------------
-- fn_update_pharmacy_rating: Recalculate pharmacy rating_avg
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_update_pharmacy_rating()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pharmacies
  SET    rating_avg = (
           SELECT ROUND(AVG(rating)::numeric, 2)
           FROM   pharmacy_ratings
           WHERE  pharmacy_id = COALESCE(NEW.pharmacy_id, OLD.pharmacy_id)
         ),
         updated_at = now()
  WHERE  id = COALESCE(NEW.pharmacy_id, OLD.pharmacy_id);
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- fn_check_rating_reservation_completed: Only allow rating completed reservations
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_rating_reservation_completed()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  res_status reservation_status;
BEGIN
  SELECT status INTO res_status
  FROM   reservations
  WHERE  id = NEW.reservation_id;

  IF res_status IS NULL THEN
    RAISE EXCEPTION 'Reservation % does not exist', NEW.reservation_id;
  END IF;

  IF res_status <> 'completed' THEN
    RAISE EXCEPTION 'Cannot rate: reservation % has status %, must be completed',
                    NEW.reservation_id, res_status;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- fn_guard_reservation_transitions: Legal state machine for reservation status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_reservation_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- Only guard status changes
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Legal transitions:
  --   pending_payment  -> confirmed_held | cancelled | expired
  --   confirmed_held   -> ready_for_pickup | expired | cancelled
  --   ready_for_pickup -> completed | expired | cancelled
  -- Terminal states: completed, expired, cancelled
  IF OLD.status = 'pending_payment'  AND NEW.status IN ('confirmed_held', 'cancelled', 'expired') THEN RETURN NEW; END IF;
  IF OLD.status = 'confirmed_held'   AND NEW.status IN ('ready_for_pickup', 'expired', 'cancelled') THEN RETURN NEW; END IF;
  IF OLD.status = 'ready_for_pickup' AND NEW.status IN ('completed', 'expired', 'cancelled') THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'Illegal reservation transition: % -> %', OLD.status, NEW.status;
END;
$$;

-- ---------------------------------------------------------------------------
-- fn_set_updated_at: Generic updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- fn_create_reservation: Concurrency-safe reservation creation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_create_reservation(
  p_patient_id   UUID,
  p_stock_id     UUID,
  p_pharmacy_id  UUID,
  p_quantity     INT,
  p_hold_hours   SMALLINT DEFAULT 2
)
RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_available   INT;
  v_expiry_date DATE;
  v_reservation UUID;
  v_pickup_code TEXT;
BEGIN
  -- Lock the stock row to prevent race conditions
  SELECT (total_quantity - reserved_quantity), expiry_date
  INTO   v_available, v_expiry_date
  FROM   pharmacy_stock
  WHERE  id = p_stock_id AND pharmacy_id = p_pharmacy_id
  FOR UPDATE;

  IF v_available IS NULL THEN
    RAISE EXCEPTION 'Stock item % not found in pharmacy %', p_stock_id, p_pharmacy_id;
  END IF;

  IF v_expiry_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'Cannot reserve expired medication batch (expired %)', v_expiry_date;
  END IF;

  IF v_available < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock: available=%, requested=%', v_available, p_quantity;
  END IF;

  -- Reserve the quantity
  UPDATE pharmacy_stock
  SET    reserved_quantity = reserved_quantity + p_quantity,
         updated_at = now()
  WHERE  id = p_stock_id;

  -- Generate 6-digit pickup code
  v_pickup_code := LPAD(FLOOR(random() * 1000000)::text, 6, '0');

  -- Create the reservation
  INSERT INTO reservations (
    patient_id, pharmacy_id, stock_id, quantity,
    status, hold_duration_hours, hold_expires_at, pickup_code
  )
  VALUES (
    p_patient_id, p_pharmacy_id, p_stock_id, p_quantity,
    'pending_payment', p_hold_hours,
    now() + (p_hold_hours || ' hours')::interval,
    v_pickup_code
  )
  RETURNING id INTO v_reservation;

  RETURN v_reservation;
END;
$$;

-- ---------------------------------------------------------------------------
-- fn_close_reservation: Complete or cancel a reservation, releasing stock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_close_reservation(
  p_reservation_id UUID,
  p_new_status     reservation_status
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_res RECORD;
BEGIN
  -- Lock the reservation
  SELECT r.id, r.stock_id, r.pharmacy_id, r.quantity, r.status
  INTO   v_res
  FROM   reservations r
  WHERE  r.id = p_reservation_id
  FOR UPDATE;

  IF v_res IS NULL THEN
    RAISE EXCEPTION 'Reservation % not found', p_reservation_id;
  END IF;

  -- Update status (the trigger will validate the transition)
  UPDATE reservations
  SET    status = p_new_status,
         updated_at = now()
  WHERE  id = p_reservation_id;

  -- Release reserved stock for non-completed closures
  IF p_new_status IN ('cancelled', 'expired') THEN
    UPDATE pharmacy_stock
    SET    reserved_quantity = reserved_quantity - v_res.quantity,
           updated_at = now()
    WHERE  id = v_res.stock_id;
  END IF;

  -- For completed: decrease both total and reserved (item picked up)
  IF p_new_status = 'completed' THEN
    UPDATE pharmacy_stock
    SET    total_quantity    = total_quantity    - v_res.quantity,
           reserved_quantity = reserved_quantity - v_res.quantity,
           updated_at = now()
    WHERE  id = v_res.stock_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- fn_expire_due_reservations: Expire overdue holds (SKIP LOCKED for concurrency)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_expire_due_reservations()
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  v_row RECORD;
  v_count INT := 0;
BEGIN
  FOR v_row IN
    SELECT id, stock_id, quantity
    FROM   reservations
    WHERE  status IN ('pending_payment', 'confirmed_held')
      AND  hold_expires_at < now()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE reservations
    SET    status = 'expired', updated_at = now()
    WHERE  id = v_row.id;

    UPDATE pharmacy_stock
    SET    reserved_quantity = reserved_quantity - v_row.quantity,
           updated_at = now()
    WHERE  id = v_row.stock_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ===========================================================================
-- TRIGGERS
-- ===========================================================================

-- updated_at triggers
DROP TRIGGER IF EXISTS trg_pharmacies_updated_at ON pharmacies;
CREATE TRIGGER trg_pharmacies_updated_at
  BEFORE UPDATE ON pharmacies
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_pharmacy_stock_updated_at ON pharmacy_stock;
CREATE TRIGGER trg_pharmacy_stock_updated_at
  BEFORE UPDATE ON pharmacy_stock
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_reservations_updated_at ON reservations;
CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Reservation state-machine guard
DROP TRIGGER IF EXISTS trg_reservation_state_machine ON reservations;
CREATE TRIGGER trg_reservation_state_machine
  BEFORE UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION fn_guard_reservation_transitions();

-- Rating: check completed reservation first
DROP TRIGGER IF EXISTS trg_check_rating_completed ON pharmacy_ratings;
CREATE TRIGGER trg_check_rating_completed
  BEFORE INSERT ON pharmacy_ratings
  FOR EACH ROW EXECUTE FUNCTION fn_check_rating_reservation_completed();

-- Rating: refresh pharmacy avg rating
DROP TRIGGER IF EXISTS trg_refresh_pharmacy_rating ON pharmacy_ratings;
CREATE TRIGGER trg_refresh_pharmacy_rating
  AFTER INSERT OR UPDATE OR DELETE ON pharmacy_ratings
  FOR EACH ROW EXECUTE FUNCTION fn_update_pharmacy_rating();

-- ===========================================================================
-- VIEWS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- v_pharmacy_stock_status: Per-batch stock with derived status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_pharmacy_stock_status AS
SELECT
  ps.id,
  ps.pharmacy_id,
  ps.medicine_id,
  ps.batch_barcode,
  ps.expiry_date,
  ps.total_quantity,
  ps.reserved_quantity,
  (ps.total_quantity - ps.reserved_quantity) AS available_quantity,
  ps.low_stock_threshold,
  ps.price_dzd,
  fn_stock_status(
    ps.total_quantity - ps.reserved_quantity,
    ps.low_stock_threshold
  ) AS stock_status,
  CASE WHEN ps.expiry_date < CURRENT_DATE THEN true ELSE false END AS is_expired
FROM pharmacy_stock ps;

-- ---------------------------------------------------------------------------
-- v_pharmacy_medicine_availability: Aggregated per pharmacy+medicine (non-expired)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_pharmacy_medicine_availability AS
SELECT
  ps.pharmacy_id,
  ps.medicine_id,
  m.commercial_name,
  m.generic_dci_name,
  m.dosage_form,
  m.strength,
  SUM(ps.total_quantity - ps.reserved_quantity) AS total_available,
  MIN(ps.price_dzd)                            AS min_price_dzd,
  MAX(ps.price_dzd)                            AS max_price_dzd,
  MIN(ps.expiry_date)                          AS nearest_expiry,
  COUNT(*)                                     AS batch_count,
  fn_stock_status(
    SUM(ps.total_quantity - ps.reserved_quantity)::int,
    MAX(ps.low_stock_threshold)
  ) AS stock_status
FROM   pharmacy_stock ps
JOIN   medicines m ON m.id = ps.medicine_id
WHERE  ps.expiry_date >= CURRENT_DATE
GROUP  BY ps.pharmacy_id, ps.medicine_id,
          m.commercial_name, m.generic_dci_name, m.dosage_form, m.strength;

-- ---------------------------------------------------------------------------
-- v_pharmacy_directory: Public pharmacy directory with Pro & on-duty status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_pharmacy_directory AS
SELECT
  p.id,
  p.name,
  p.wilaya,
  p.commune,
  p.address,
  p.phone,
  p.location,
  p.opening_hours,
  p.rating_avg,
  CASE WHEN p.pro_plan_until > now() THEN true ELSE false END AS is_pro_active,
  EXISTS (
    SELECT 1 FROM pharmacy_on_duty_rotas r
    WHERE  r.pharmacy_id = p.id
      AND  now() BETWEEN r.starts_at AND r.ends_at
  ) AS is_on_duty_now
FROM pharmacies p;

-- ---------------------------------------------------------------------------
-- v_unmet_demand: 30-day anonymized unmet demand analytics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_unmet_demand AS
SELECT
  sl.wilaya,
  sl.medicine_id,
  m.commercial_name,
  m.generic_dci_name,
  COUNT(*)            AS search_count,
  COUNT(DISTINCT sl.user_id) AS unique_users
FROM   search_logs sl
LEFT   JOIN medicines m ON m.id = sl.medicine_id
WHERE  sl.found_in_stock = false
  AND  sl.searched_at >= now() - interval '30 days'
GROUP  BY sl.wilaya, sl.medicine_id, m.commercial_name, m.generic_dci_name
ORDER  BY search_count DESC;

-- ===========================================================================
-- INDEXES (< 300 ms target)
-- ===========================================================================

-- GiST spatial indexes
CREATE INDEX IF NOT EXISTS idx_pharmacies_location_gist
  ON pharmacies USING gist (location);

CREATE INDEX IF NOT EXISTS idx_search_logs_search_point_gist
  ON search_logs USING gist (search_point);

-- GIN trigram indexes for fuzzy medicine search
CREATE INDEX IF NOT EXISTS idx_medicines_commercial_name_trgm
  ON medicines USING gin (commercial_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_medicines_generic_dci_name_trgm
  ON medicines USING gin (generic_dci_name gin_trgm_ops);

-- Composite B-tree on pharmacy_stock for efficient lookups
CREATE INDEX IF NOT EXISTS idx_pharmacy_stock_med_pharm_expiry
  ON pharmacy_stock (medicine_id, pharmacy_id, expiry_date);

-- Additional performance indexes
CREATE INDEX IF NOT EXISTS idx_pharmacy_stock_pharmacy_id
  ON pharmacy_stock (pharmacy_id);

CREATE INDEX IF NOT EXISTS idx_reservations_patient_id
  ON reservations (patient_id);

CREATE INDEX IF NOT EXISTS idx_reservations_status_expires
  ON reservations (status, hold_expires_at)
  WHERE status IN ('pending_payment', 'confirmed_held');

CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id
  ON prescriptions (patient_id);

CREATE INDEX IF NOT EXISTS idx_prescriptions_wilaya_status
  ON prescriptions (wilaya, status)
  WHERE status = 'uploaded';

CREATE INDEX IF NOT EXISTS idx_search_logs_searched_at
  ON search_logs (searched_at);

CREATE INDEX IF NOT EXISTS idx_search_logs_wilaya_medicine
  ON search_logs (wilaya, medicine_id)
  WHERE found_in_stock = false;

CREATE INDEX IF NOT EXISTS idx_pharmacy_on_duty_rotas_active
  ON pharmacy_on_duty_rotas (pharmacy_id, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_stock_alerts_active
  ON stock_alerts_reminders (medicine_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pharmacist_verifications_status
  ON pharmacist_verifications (status)
  WHERE status = 'pending';

COMMIT;

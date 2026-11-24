-- ============================================================================
-- DWA – Algerian Pharmacy Stock, Reservation & Prescription Platform
-- Migration: 002_fixes.sql
-- Fixes applied:
--   1. Allow pending_payment -> expired in fn_guard_reservation_transitions()
--   2. Add ON DELETE CASCADE foreign key constraint on pharmacy_ratings(reservation_id)
--   3. Use scalar subquery in fn_update_pharmacy_rating() to reset rating_avg to NULL when last rating deleted
--   4. Reject expired batches (expiry_date < CURRENT_DATE) in fn_create_reservation()
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. fn_guard_reservation_transitions: Allow pending_payment -> expired
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
-- 2. pharmacy_ratings: add REFERENCES reservations(id) ON DELETE CASCADE
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Drop existing constraint if named or present
  ALTER TABLE pharmacy_ratings
    DROP CONSTRAINT IF EXISTS fk_pharmacy_ratings_reservation,
    DROP CONSTRAINT IF EXISTS pharmacy_ratings_reservation_id_fkey;

  ALTER TABLE pharmacy_ratings
    ADD CONSTRAINT fk_pharmacy_ratings_reservation
    FOREIGN KEY (reservation_id)
    REFERENCES reservations(id)
    ON DELETE CASCADE;
END $$;

-- ---------------------------------------------------------------------------
-- 3. fn_update_pharmacy_rating: scalar subquery for proper NULL reset
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
-- 4. fn_create_reservation: reject expired batches (expiry_date < CURRENT_DATE)
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
    RAISE EXCEPTION 'Cannot reserve expired medication batch % (expired %)', p_stock_id, v_expiry_date;
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

COMMIT;

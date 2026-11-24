# DWA Database Data Dictionary

Comprehensive technical reference of all tables, views, functions, triggers, enums, and indexes in the **DWA** PostgreSQL database layer.

---

## 1. Custom ENUM Types

| ENUM Name | Allowed Values | Description |
|---|---|---|
| `user_role` | `'patient'`, `'pharmacist'`, `'admin'` | Access control role for application users |
| `verification_status` | `'pending'`, `'verified'`, `'rejected'` | State of pharmacist professional license verification |
| `shift_type` | `'night'`, `'weekend'`, `'holiday'` | On-duty rota shift classification |
| `equivalence_type` | `'exact_generic'`, `'therapeutic_alternative'` | Pharmaceutical substitution relationship |
| `reservation_status` | `'pending_payment'`, `'confirmed_held'`, `'ready_for_pickup'`, `'completed'`, `'expired'`, `'cancelled'` | Finite state-machine states for medication reservations |
| `payment_purpose` | `'reservation_deposit'`, `'pro_plan'` | Purpose of Chargily financial transaction |
| `payment_status` | `'pending'`, `'paid'`, `'failed'`, `'refunded'` | Gateway payment lifecycle status |
| `prescription_status` | `'uploaded'`, `'answered'`, `'closed'` | Patient prescription fulfillment state |
| `availability_status` | `'available'`, `'partial'`, `'unavailable'` | Pharmacist feedback on prescription availability |
| `alert_type` | `'back_in_stock'`, `'refill_reminder'` | Patient notification trigger type |

---

## 2. Table Specifications

### 2.1 `users`
Stores all platform actors (patients, pharmacists, system administrators). Complies with Algerian Personal Data Law 18-07.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique user identifier |
| `email` | `TEXT` | `NOT NULL UNIQUE CHECK (email = lower(email))` | Case-normalized user email address |
| `password_hash` | `TEXT` | `NOT NULL` | Bcrypt or Argon2 password hash |
| `role` | `user_role` | `NOT NULL DEFAULT 'patient'` | Platform authorization level |
| `full_name` | `TEXT` | `NOT NULL` | User full legal name |
| `phone` | `TEXT` | `NULL` | Algerian phone number (+213...) |
| `chifa_card_number` | `TEXT` | `NULL` | National social security Chifa card identifier |
| `law_18_07_consent_at` | `TIMESTAMPTZ` | `NULL` | Timestamp of statutory personal data consent |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Registration timestamp |

---

### 2.2 `pharmacist_verifications`
Tracks regulatory verification of pharmacists through the Algerian National Order of Pharmacists (CNOP).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Verification record ID |
| `user_id` | `UUID` | `NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Associated user account |
| `license_number` | `TEXT` | `NOT NULL UNIQUE` | Official pharmacy practice license number |
| `document_storage_path` | `TEXT` | `NOT NULL` | Cloud storage URI for scanned diploma/license |
| `status` | `verification_status` | `NOT NULL DEFAULT 'pending'` | Current verification state |
| `rejection_reason` | `TEXT` | `NULL` | Required if status is `'rejected'` |
| `reviewed_by` | `UUID` | `REFERENCES users(id) ON DELETE RESTRICT` | Admin who performed the review |
| `reviewed_at` | `TIMESTAMPTZ` | `NULL` | Review timestamp |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Submission timestamp |

*Constraints:*
- `no_self_review`: `CHECK (reviewed_by IS DISTINCT FROM user_id)`
- `rejection_needs_reason`: `CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)`
- `decided_needs_reviewer`: `CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))`

---

### 2.3 `pharmacies`
Physical pharmacy storefronts across Algeria's 58 wilayas.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique pharmacy ID |
| `owner_id` | `UUID` | `NOT NULL REFERENCES users(id)` | Pharmacist owner |
| `name` | `TEXT` | `NOT NULL` | Commercial name of the pharmacy |
| `wilaya` | `TEXT` | `NOT NULL` | Wilaya name (e.g., 'Alger', 'Oran') |
| `commune` | `TEXT` | `NOT NULL` | Commune name (e.g., 'Bab Ezzouar') |
| `address` | `TEXT` | `NOT NULL` | Street address description |
| `phone` | `TEXT` | `NULL` | Public contact telephone number |
| `location` | `geography(Point, 4326)` | `NULL` | Spatial GPS coordinates (longitude, latitude) |
| `opening_hours` | `JSONB` | `NOT NULL DEFAULT '{}'` | Weekly opening schedule JSON |
| `pro_plan_until` | `TIMESTAMPTZ` | `NULL` | Active Pro subscription if > now() |
| `rating_avg` | `NUMERIC(3,2)` | `CHECK (rating_avg IS NULL OR (rating_avg >= 1 AND rating_avg <= 5))` | Auto-maintained average customer rating |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Record creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Last update timestamp (trigger updated) |

---

### 2.4 `pharmacy_on_duty_rotas`
Night, weekend, and holiday on-duty shifts (*pharmacies de garde*).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Duty record ID |
| `pharmacy_id` | `UUID` | `NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE` | Assigned pharmacy |
| `duty_date` | `DATE` | `NOT NULL` | Shift calendar date |
| `shift_type` | `shift_type` | `NOT NULL` | Shift category (`night`, `weekend`, `holiday`) |
| `starts_at` | `TIMESTAMPTZ` | `NOT NULL` | Shift commencement time |
| `ends_at` | `TIMESTAMPTZ` | `NOT NULL` | Shift conclusion time |
| `notes` | `TEXT` | `NULL` | Instructions for patients |

*Constraints:*
- `ends_after_starts`: `CHECK (ends_at > starts_at)`
- `unique_duty`: `UNIQUE (pharmacy_id, duty_date, shift_type)`

---

### 2.5 `medicines`
Master pharmaceutical catalogue containing 5,425 registered medicines from the Algerian Ministry of Health Nomenclature.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique medicine ID |
| `commercial_name` | `TEXT` | `NOT NULL` | Brand / trade name (e.g., 'DOLIPRANE') |
| `generic_dci_name` | `TEXT` | `NOT NULL` | International Nonproprietary Name (e.g., 'PARACETAMOL') |
| `strength` | `TEXT` | `NULL` | Dosage strength (e.g., '500mg', '1g') |
| `dosage_form` | `TEXT` | `NULL` | Form (e.g., 'Comprimé', 'Sirop', 'Gélule') |
| `barcode_ean` | `TEXT` | `UNIQUE CHECK (barcode_ean ~ '^\d{8,14}$')` | GS1 EAN-13 barcode |
| `is_prescription_only` | `BOOLEAN` | `NOT NULL DEFAULT true` | Regulatory prescription requirement (Liste I/II) |
| `chifa_reimbursable` | `BOOLEAN` | `NOT NULL DEFAULT false` | National Social Security (CNAS) reimbursement eligibility |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Catalog entry timestamp |

---

### 2.6 `medicine_equivalents`
Self-referencing M:N join table mapping bioequivalent and therapeutic substitutes.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `medicine_id` | `UUID` | `NOT NULL REFERENCES medicines(id) ON DELETE CASCADE` | Source medicine |
| `equivalent_id` | `UUID` | `NOT NULL REFERENCES medicines(id) ON DELETE CASCADE` | Target substitute medicine |
| `equivalence_type` | `equivalence_type` | `NOT NULL` | Substitution tier (`exact_generic`, `therapeutic_alternative`) |
| `notes` | `TEXT` | `NULL` | Pharmacological substitution notes |

*Constraints:*
- `PRIMARY KEY (medicine_id, equivalent_id)`
- `no_self_equivalence`: `CHECK (medicine_id <> equivalent_id)`

---

### 2.7 `pharmacy_stock`
Physical batch inventory held by pharmacies.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Stock batch ID |
| `pharmacy_id` | `UUID` | `NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE` | Owning pharmacy |
| `medicine_id` | `UUID` | `NOT NULL REFERENCES medicines(id) ON DELETE CASCADE` | Medicine catalogue item |
| `batch_barcode` | `TEXT` | `NOT NULL` | Manufacturer lot/batch barcode |
| `production_date` | `DATE` | `NULL` | Manufacturing date |
| `expiry_date` | `DATE` | `NOT NULL` | Expiration date |
| `total_quantity` | `INT` | `NOT NULL DEFAULT 0` | Physical boxes on shelf |
| `reserved_quantity` | `INT` | `NOT NULL DEFAULT 0` | Boxes currently held in active reservations |
| `low_stock_threshold` | `INT` | `NOT NULL DEFAULT 5` | Threshold for `'low_stock'` status |
| `price_dzd` | `NUMERIC(10,2)` | `NULL` | Unit price in Algerian Dinars |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Last update timestamp |

*Constraints:*
- `unique_batch`: `UNIQUE (pharmacy_id, medicine_id, batch_barcode)`
- `unique_stock_pharmacy`: `UNIQUE (id, pharmacy_id)`
- `stock_quantity_check`: `CHECK (total_quantity >= reserved_quantity AND reserved_quantity >= 0)`

---

### 2.8 `reservations`
Active holds on stock batches for pickup.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Reservation ID |
| `patient_id` | `UUID` | `NOT NULL REFERENCES users(id)` | Reserving patient |
| `pharmacy_id` | `UUID` | `NOT NULL REFERENCES pharmacies(id)` | Pharmacy fulfilling the order |
| `stock_id` | `UUID` | `NOT NULL` | Specific batch row reserved |
| `quantity` | `INT` | `NOT NULL CHECK (quantity > 0)` | Quantity of boxes held |
| `status` | `reservation_status` | `NOT NULL DEFAULT 'pending_payment'` | Current lifecycle status |
| `hold_duration_hours` | `SMALLINT` | `NOT NULL CHECK (hold_duration_hours IN (2, 4))` | Standard hold window (2 or 4 hrs) |
| `hold_expires_at` | `TIMESTAMPTZ` | `NULL` | Exact expiration deadline |
| `pickup_code` | `TEXT` | `NULL CHECK (pickup_code ~ '^\d{6}$')` | 6-digit physical pickup verification code |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Hold placement timestamp |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Status change timestamp |

*Constraints:*
- `fk_stock_pharmacy`: `FOREIGN KEY (stock_id, pharmacy_id) REFERENCES pharmacy_stock(id, pharmacy_id)`

---

### 2.9 `payments`
Chargily payment transactions (CIB / EDAHABIA cards).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Internal transaction ID |
| `chargily_checkout_id` | `TEXT` | `UNIQUE` | Idempotency key from payment gateway |
| `payment_purpose` | `payment_purpose` | `NOT NULL` | Purpose (`reservation_deposit` or `pro_plan`) |
| `reservation_id` | `UUID` | `REFERENCES reservations(id)` | Linked reservation (for deposits) |
| `pharmacy_id` | `UUID` | `NOT NULL REFERENCES pharmacies(id)` | Beneficiary pharmacy |
| `amount_dzd` | `NUMERIC(12,2)` | `NOT NULL CHECK (amount_dzd > 0)` | Payment amount in DZD |
| `status` | `payment_status` | `NOT NULL DEFAULT 'pending'` | Transaction state |
| `webhook_verified` | `BOOLEAN` | `NOT NULL DEFAULT false` | Cryptographic signature verification flag |
| `paid_at` | `TIMESTAMPTZ` | `NULL` | Settlement timestamp |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Checkout creation timestamp |

*Constraints:*
- `payment_purpose_consistency`: `CHECK ((payment_purpose = 'reservation_deposit' AND reservation_id IS NOT NULL) OR (payment_purpose = 'pro_plan' AND reservation_id IS NULL))`

---

### 2.10 `pharmacy_ratings`
Customer ratings and reviews tied to verified completed reservations.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Rating ID |
| `patient_id` | `UUID` | `NOT NULL REFERENCES users(id)` | Reviewing patient |
| `pharmacy_id` | `UUID` | `NOT NULL REFERENCES pharmacies(id)` | Rated pharmacy |
| `reservation_id` | `UUID` | `NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE` | Associated completed reservation (1 review per pickup) |
| `rating` | `SMALLINT` | `NOT NULL CHECK (rating >= 1 AND rating <= 5)` | Star rating (1 to 5) |
| `comment` | `TEXT` | `NULL` | Optional patient review feedback |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Review submission timestamp |

---

### 2.11 `prescriptions`
Patient uploaded prescriptions for availability inquiry.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Prescription request ID |
| `patient_id` | `UUID` | `NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Inquiring patient |
| `image_storage_path` | `TEXT` | `NOT NULL` | Encrypted image storage path |
| `wilaya` | `TEXT` | `NULL` | Patient search wilaya |
| `patient_notes` | `TEXT` | `NULL` | Clinical context from patient |
| `status` | `prescription_status` | `NOT NULL DEFAULT 'uploaded'` | Inquiry state (`uploaded`, `answered`, `closed`) |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Submission timestamp |

---

### 2.12 `prescription_responses`
Responses provided by regional pharmacies for uploaded prescriptions.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Response ID |
| `prescription_id` | `UUID` | `NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE` | Referenced prescription |
| `pharmacy_id` | `UUID` | `NOT NULL REFERENCES pharmacies(id)` | Responding pharmacy |
| `pharmacist_id` | `UUID` | `NOT NULL REFERENCES users(id)` | Licensed pharmacist responder |
| `availability_status` | `availability_status` | `NOT NULL` | Stock assessment (`available`, `partial`, `unavailable`) |
| `response_notes` | `TEXT` | `NULL` | Instructions or substitute proposals |
| `referred_pharmacy_id` | `UUID` | `REFERENCES pharmacies(id)` | Referral to colleague pharmacy |
| `responded_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Response timestamp |

---

### 2.13 `stock_alerts_reminders`
Patient notifications for back-in-stock events and recurring prescription refills.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Alert subscription ID |
| `user_id` | `UUID` | `NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Subscribed patient |
| `medicine_id` | `UUID` | `NOT NULL REFERENCES medicines(id) ON DELETE CASCADE` | Target medication |
| `pharmacy_id` | `UUID` | `REFERENCES pharmacies(id) ON DELETE CASCADE` | Optional pharmacy-specific subscription |
| `alert_type` | `alert_type` | `NOT NULL` | Alert class (`back_in_stock`, `refill_reminder`) |
| `refill_interval_days` | `INT` | `NULL` | Cycle interval (e.g. 30 days) |
| `next_trigger_at` | `TIMESTAMPTZ` | `NULL` | Scheduled trigger date |
| `last_notified_at` | `TIMESTAMPTZ` | `NULL` | Last dispatch timestamp |
| `is_active` | `BOOLEAN` | `NOT NULL DEFAULT true` | Active state |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Subscription creation timestamp |

---

### 2.14 `search_logs`
High-throughput telemetry of patient search queries for unmet demand analytics.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGINT` | `GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | Sequential event ID |
| `user_id` | `UUID` | `REFERENCES users(id) ON DELETE SET NULL` | Optional logged-in user |
| `medicine_id` | `UUID` | `REFERENCES medicines(id) ON DELETE SET NULL` | Identified catalog medicine |
| `raw_query` | `TEXT` | `NOT NULL` | Raw text entered by patient |
| `wilaya` | `TEXT` | `NULL` | Filtered wilaya |
| `search_point` | `geography(Point, 4326)` | `NULL` | Patient GPS coordinate at time of query |
| `results_count` | `INT` | `NOT NULL DEFAULT 0` | Total pharmacies matched |
| `found_in_stock` | `BOOLEAN` | `NOT NULL DEFAULT false` | True if at least one nearby pharmacy had stock |
| `searched_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Query timestamp |

---

### 2.15 `_migrations`
Internal schema migration tracker.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `SERIAL` | `PRIMARY KEY` | Migration order |
| `filename` | `TEXT` | `NOT NULL UNIQUE` | Executed SQL migration filename |
| `applied_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Execution timestamp |

---

## 3. Database Views

### 3.1 `v_pharmacy_stock_status`
Batch-level view projecting derived stock status and expiration status.
- **Columns:** `id`, `pharmacy_id`, `medicine_id`, `batch_barcode`, `expiry_date`, `total_quantity`, `reserved_quantity`, `available_quantity`, `low_stock_threshold`, `price_dzd`, `stock_status`, `is_expired`.

### 3.2 `v_pharmacy_medicine_availability`
Aggregated non-expired inventory per pharmacy and medicine.
- Filters out expired batches (`ps.expiry_date >= CURRENT_DATE`).
- Computes `total_available`, `min_price_dzd`, `max_price_dzd`, `nearest_expiry`, `batch_count`, and aggregate `stock_status`.

### 3.3 `v_pharmacy_directory`
Public pharmacy directory enriched with real-time operational status.
- Evaluates `is_pro_active` (`pro_plan_until > now()`).
- Evaluates `is_on_duty_now` (`now() BETWEEN starts_at AND ends_at` in `pharmacy_on_duty_rotas`).

### 3.4 `v_unmet_demand`
30-day regional medicine shortage telemetry for pharmacy stocking decisions.
- Aggregates searches where `found_in_stock = false` over the past 30 days.
- Groups by `wilaya`, `medicine_id`, `commercial_name`, `generic_dci_name`.
- Computes `search_count` and `unique_users`.

---

## 4. Stored Procedures & Functions

### `fn_stock_status(available INT, threshold INT) RETURNS TEXT`
Immutable helper calculating stock level status:
- `<= 0` → `'out_of_stock'`
- `<= threshold` → `'low_stock'`
- `> threshold` → `'in_stock'`

### `fn_create_reservation(...) RETURNS UUID`
Concurrency-safe atomic reservation creation with `FOR UPDATE` pessimistic row lock, expiration check, and hold assignment.

### `fn_close_reservation(p_reservation_id UUID, p_new_status reservation_status) RETURNS VOID`
Closes reservations upon completion (deducting physical stock) or cancellation/expiration (releasing held stock).

### `fn_expire_due_reservations() RETURNS INT`
Background sweeper expiring overdue holds using `FOR UPDATE SKIP LOCKED`.

### `fn_guard_reservation_transitions() RETURNS TRIGGER`
Enforces the reservation state-machine transitions and terminal state locks.

### `fn_update_pharmacy_rating() RETURNS TRIGGER`
Maintains `pharmacies.rating_avg` via scalar subquery, safely resetting it to `NULL` when ratings are removed.

### `fn_check_rating_reservation_completed() RETURNS TRIGGER`
Restricts rating submissions strictly to reservations with status `'completed'`.

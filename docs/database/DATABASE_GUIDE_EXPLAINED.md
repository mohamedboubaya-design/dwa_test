# DWA Database Guide — Everything Explained Simply

> A beginner-friendly guide for the DWA development team. No prior database experience required.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Plain-English Glossary of Technical Terms](#2-plain-english-glossary-of-technical-terms)
3. [The 14 Tables Explained in Plain English](#3-the-14-tables-explained-in-plain-english)
4. [How the Medicine Catalogue Was Built](#4-how-the-medicine-catalogue-was-built)
5. [How a Medicine Search Works Step-by-Step](#5-how-a-medicine-search-works-step-by-step)
6. [How to Defend This in Front of the Professor](#6-how-to-defend-this-in-front-of-the-professor)

---

## 1. Executive Summary

### The Problem

In Algeria today, patients face three major frustrations:

1. **You can't find your medicine.** You walk from pharmacy to pharmacy asking "Do you have Doliprane?" — sometimes visiting 5 or 6 pharmacies before finding it, or giving up entirely. There is no centralized system to check which pharmacy has what in stock.

2. **Pharmacies are flying blind.** Pharmacy owners don't know what medicines patients in their area are searching for. They can't see demand patterns, so they over-stock some products and under-stock others. There's no data-driven way to manage inventory.

3. **There is no online reservation system.** Even when a pharmacy has your medicine, by the time you arrive, someone else may have bought the last box. There's no way to hold a medicine remotely and pick it up later.

### Our Solution: DWA

DWA is a platform that connects Algerian patients with pharmacies. It solves all three problems:

- **Patients** can search for any medicine, see which nearby pharmacies have it in stock (with real-time quantities and prices), and **reserve** it for pickup within 2–4 hours.
- **Pharmacists** can manage their stock digitally, see what medicines people in their wilaya are searching for (demand analytics), and receive prescription requests.
- **The database** is the brain that makes all of this work. It stores 5,425 official Algerian medicines, tracks pharmacy stock down to individual batches (with expiry dates), manages the reservation lifecycle, and uses GPS to find nearby pharmacies.

### Why This Database Matters

Every feature of DWA depends on data being stored correctly, consistently, and efficiently:

| Feature | Database Responsibility |
|---|---|
| Medicine search | Fuzzy text matching + geographic filtering |
| Stock availability | Real-time calculation from batch quantities |
| Reservations | Concurrent-safe locking to prevent double-booking |
| "Pharmacy nearby" | PostGIS spatial queries with distance in meters |
| Prescription upload | Linking prescriptions to pharmacies in the same wilaya |
| Demand analytics | Logging searches to identify unmet medicine demand |
| Rating system | Auto-calculated averages via triggers |

---

## 2. Plain-English Glossary of Technical Terms

### PostgreSQL

**What it is:** PostgreSQL (often called "Postgres") is an open-source relational database management system (RDBMS). Think of it as a very sophisticated spreadsheet engine — but instead of Excel files, it stores data in structured tables with strict rules about what data is allowed.

**How it differs from MySQL:** Both are relational databases, but PostgreSQL has more advanced features out of the box. It supports things like JSONB (storing flexible JSON data alongside structured data), PostGIS (geographic queries), custom types (ENUMs), and powerful triggers. MySQL is simpler and historically faster for basic read operations, but PostgreSQL is more feature-rich and standards-compliant.

**Why we chose it:** Supabase — our hosting platform — runs on PostgreSQL. This gives us access to all of PostgreSQL's advanced features (JSONB, PostGIS, triggers, views) plus Supabase's extras (real-time subscriptions, auto-generated REST APIs, built-in authentication). We get a production-grade database with zero infrastructure management.

---

### PostGIS

**What it is:** PostGIS is an extension (a plugin) for PostgreSQL that adds GPS and geographic capabilities. Without PostGIS, PostgreSQL only understands numbers, text, and dates. With PostGIS, it understands *locations on Earth*.

**How we use it:**

- We store each pharmacy's location as `geography(Point, 4326)`. The "Point" means a single GPS coordinate (latitude, longitude). The "4326" is the SRID (Spatial Reference Identifier) — it tells PostGIS to use the WGS 84 coordinate system, which is the same system used by Google Maps and every GPS device on Earth.

- `ST_DWithin(pharmacy.location, patient_point, 5000)` answers the question: "Is this pharmacy within 5,000 meters (5 km) of the patient?" It calculates the real-world distance on the Earth's curved surface — not a flat-plane approximation.

- `ST_Distance(pharmacy.location, patient_point)` returns the exact distance in meters between two points.

**Why this matters for DWA:** When a patient in Bab Ezzouar searches for Doliprane, we can instantly find all pharmacies within 5 km that have it in stock, sorted by distance. Without PostGIS, we'd have to calculate distances in our application code using the Haversine formula — which would be slower and couldn't use spatial indexes.

---

### ENUMs

**What it is:** An ENUM (enumeration) is a restricted set of allowed values for a column. Think of it like a dropdown menu in a form — you can only pick from the options listed.

**Example from DWA:**

```sql
CREATE TYPE reservation_status AS ENUM (
  'pending_payment',
  'confirmed_held',
  'ready_for_pickup',
  'completed',
  'expired',
  'cancelled'
);
```

A reservation's status can ONLY be one of these 6 values. If your application code accidentally tries to insert `"compelted"` (a typo), the database will reject it with an error. This is much safer than using a plain text column where any string would be accepted.

**ENUMs we use in DWA:**

| ENUM Name | Allowed Values | Used For |
|---|---|---|
| `user_role` | `patient`, `pharmacist`, `admin` | Who the user is |
| `reservation_status` | `pending_payment`, `confirmed_held`, `ready_for_pickup`, `completed`, `expired`, `cancelled` | Where a reservation is in its lifecycle |
| `payment_status` | `pending`, `succeeded`, `failed`, `refunded` | Payment state |
| `payment_purpose` | `reservation_deposit`, `pro_plan` | What the payment is for |
| `alert_type` | `back_in_stock`, `refill_reminder` | Type of notification |
| `verification_status` | `pending`, `verified`, `rejected` | Pharmacist license review |

---

### Triggers

**What it is:** A trigger is an automatic function that fires (runs) when data changes in a table. You don't call it manually — the database calls it for you every time a specific event happens (INSERT, UPDATE, or DELETE).

**Think of it like:** An automatic door sensor. You don't press a button to open the door — walking toward it triggers the sensor, which opens the door automatically. Similarly, when you update a reservation's status, a trigger automatically checks if the transition is valid.

**Triggers we use in DWA:**

| Trigger | When It Fires | What It Does |
|---|---|---|
| `set_updated_at` | Any row is updated | Automatically sets the `updated_at` column to the current time. You never have to remember to update this field manually. |
| `trg_reservation_status_machine` | Reservation status changes | Enforces the state machine: you can go from `pending_payment` → `confirmed_held`, but NOT from `completed` → `pending_payment`. Invalid transitions are rejected with an error. |
| `trg_rating_only_completed` | A rating is inserted | Checks that the reservation being rated has status = `completed`. You can't rate a reservation that was cancelled or is still pending. |
| `trg_recalc_pharmacy_rating` | A rating is inserted or updated | Recalculates the pharmacy's `rating_avg` and `rating_count` from all its ratings. This means the average is always correct — no manual recalculation needed. |

---

### Database Views

**What it is:** A view is a virtual table. It doesn't store any data itself — it's a saved SQL query that runs every time you read from it. When you `SELECT * FROM v_pharmacy_stock_status`, PostgreSQL runs the underlying query and returns fresh results.

**Why views are better than storing calculated data:**

Imagine we stored a `stock_status` column directly in the `pharmacy_stock` table. Every time someone makes a reservation, cancels one, or a batch expires, we'd need to recalculate and update that column. If we forget even once, the status is wrong. With a view, the status is calculated on-the-fly every time:

```
available = total_quantity - reserved_quantity

If available = 0       → 'out_of_stock'
If available ≤ 5       → 'low_stock'
If available > 5       → 'in_stock'
```

This is always correct because it reads the current values, not a cached copy.

**Views we use in DWA:**

| View | What It Shows |
|---|---|
| `v_pharmacy_stock_status` | For each stock batch: available quantity and stock status (in_stock / low_stock / out_of_stock) |
| `v_pharmacy_medicine_availability` | For each pharmacy × medicine combo: total available across all non-expired batches, cheapest price, and combined status |
| `v_unmet_demand` | Medicines people are searching for but can't find, grouped by wilaya — helps pharmacies know what to stock |

---

### Concurrency & Row-Level Locking

**The Problem (Race Condition):**

Imagine there's exactly 1 box of Doliprane left at a pharmacy. Two patients — Alice and Bob — both click "Reserve" at the same instant. Without any protection:

1. Alice's request reads: "1 box available" → proceeds to reserve
2. Bob's request reads: "1 box available" → proceeds to reserve
3. Both reservations are created → but only 1 box exists!

This is called a **race condition** — two operations "race" each other and both see stale data.

**The Solution (Row-Level Locking):**

Our `fn_create_reservation` function uses `SELECT ... FOR UPDATE`:

```sql
SELECT total_quantity, reserved_quantity
FROM pharmacy_stock
WHERE id = target_stock_id
FOR UPDATE;  -- ← This locks the row
```

Here's what happens now:

1. Alice's transaction runs first: `FOR UPDATE` locks the stock row
2. Bob's transaction tries to read the same row — it **waits** (the row is locked)
3. Alice's transaction reserves the box: `reserved_quantity` goes from 0 to 1
4. Alice's transaction commits → the lock is released
5. Bob's transaction finally gets the lock, reads the row: available = 1 - 1 = 0
6. Bob's transaction sees 0 available → raises an error: "Not enough stock"

**No double-booking is possible.** The lock guarantees that only one transaction can modify the stock row at a time.

**`FOR UPDATE SKIP LOCKED`** is a variation we use in the batch expiry job (`fn_expire_due_reservations`). Instead of waiting for the lock, it skips rows that are currently locked by other transactions. This prevents the expiry job from blocking patient reservations.

---

### GIN Indexes (pg_trgm)

**The Problem:** Patients make typos. They might type "Dolipran" instead of "Doliprane", or "amociciline" instead of "amoxicilline". A normal database search (`WHERE name = 'Dolipran'`) would return zero results — exact match fails.

**How pg_trgm Works:**

The `pg_trgm` extension breaks every word into overlapping 3-character chunks called trigrams:

```
"Doliprane" → {" d", " do", "dol", "oli", "lip", "ipr", "pra", "ran", "ane", "ne "}
"Dolipran"  → {" d", " do", "dol", "oli", "lip", "ipr", "pra", "ran", "an "}
```

Notice how many trigrams are shared? The similarity score between "Doliprane" and "Dolipran" is very high because most trigrams match. The database uses this to rank results by similarity.

**What a GIN Index does:** GIN (Generalized Inverted Index) pre-computes and stores all trigrams for every medicine name. When a search comes in, instead of scanning all 5,425 medicines and computing trigrams on the fly, the index directly looks up which medicines contain matching trigrams. This is what makes fuzzy search fast (sub-300ms).

**Our GIN Indexes:**

```sql
-- Fuzzy search on medicine commercial name (brand name)
CREATE INDEX idx_med_commercial_trgm ON medicines
  USING gin (commercial_name gin_trgm_ops);

-- Fuzzy search on medicine DCI (generic name)
CREATE INDEX idx_med_dci_trgm ON medicines
  USING gin (dci gin_trgm_ops);
```

---

### GiST Indexes

**The Problem:** When a patient searches for nearby pharmacies, we need to calculate the distance from the patient to every pharmacy. If we have 10,000 pharmacies in the database, that's 10,000 distance calculations — for every single search. This is slow.

**How GiST Indexes Help:**

GiST (Generalized Search Tree) indexes for spatial data work like a geographic hierarchy:

1. They divide the map into large regions
2. Each region is subdivided into smaller regions
3. Each sub-region is further divided, and so on

When a patient searches for pharmacies within 5 km, the index quickly eliminates entire regions that are too far away. Instead of checking 10,000 pharmacies, it might only need to check 50. This is what makes spatial queries fast.

**Our GiST Index:**

```sql
CREATE INDEX idx_pharmacy_location ON pharmacies USING gist (location);
```

Without this index, `ST_DWithin()` would be a full table scan. With it, it's an efficient spatial lookup.

---

## 3. The 14 Tables Explained in Plain English

### Domain A: Users & License Verification (2 tables)

#### Table 1: `users`

**What it represents:** Every person who uses DWA — patients, pharmacists, and admins.

**Analogy:** Think of it as the registration book at the front desk. Everyone who enters the building signs in here.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | A unique identifier for each user (auto-generated) |
| `email` | text | Login email (must be unique) |
| `password_hash` | text | The password, encrypted. We never store plain passwords. |
| `role` | user_role ENUM | Is this person a `patient`, `pharmacist`, or `admin`? |
| `full_name` | text | Their full name |
| `phone` | text | Phone number (optional) |
| `chifa_number` | char(18) | CHIFA social security card number (optional, for patients) |
| `wilaya_code` | char(2) | The 2-digit wilaya code (01 = Adrar, 16 = Alger, etc.) |
| `law_18_07_consent_at` | timestamptz | When the user consented to data storage under Algeria's Personal Data Protection Law 18-07 (June 2018). This field is **legally required** — we cannot store personal data without explicit consent. |
| `created_at` | timestamptz | When the account was created |
| `updated_at` | timestamptz | Last modification time (auto-set by trigger) |

**Important constraints:**
- Email must be unique (no duplicate accounts)
- CHIFA number is exactly 18 characters (if provided)
- Wilaya code is exactly 2 characters

---

#### Table 2: `pharmacist_verifications`

**What it represents:** The review process when a pharmacist signs up. Before they can manage a pharmacy on DWA, an admin must verify their professional license.

**Analogy:** Like a job application review — the applicant submits their credentials, and HR reviews them.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `pharmacist_id` | UUID (FK → users) | Which pharmacist is being verified |
| `document_url` | text | URL of the uploaded license document |
| `status` | verification_status ENUM | `pending`, `verified`, or `rejected` |
| `reviewed_by` | UUID (FK → users) | Which admin reviewed it |
| `reviewed_at` | timestamptz | When the review happened |
| `rejection_reason` | text | Why it was rejected (required if status = rejected) |

**Important constraints:**
- `pharmacist_id ≠ reviewed_by` — A pharmacist cannot review their own verification (prevents fraud)
- If `status = 'rejected'`, then `rejection_reason` must not be null (you must explain why)
- One verification record per pharmacist (unique on `pharmacist_id`)

---

### Domain B: Pharmacies, Catalogue & Batch Stock (5 tables)

#### Table 3: `pharmacies`

**What it represents:** Each physical pharmacy location in Algeria.

**Analogy:** Like a listing on Google Maps — name, address, location pin, opening hours, and reviews.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique pharmacy identifier |
| `owner_id` | UUID (FK → users) | The pharmacist who owns/manages this pharmacy |
| `name` | text | Pharmacy name (e.g., "Pharmacie El Afia") |
| `address` | text | Street address |
| `wilaya_code` | char(2) | Which of Algeria's 58 wilayas |
| `commune` | text | Which commune within the wilaya |
| `location` | geography(Point, 4326) | GPS coordinates (PostGIS point) |
| `phone` | text | Contact phone number |
| `is_active` | boolean | Is this pharmacy currently operating on DWA? |
| `pro_plan_until` | timestamptz | When the paid subscription expires. If this date is in the future, the pharmacy has pro features. We derive "is_pro" from this — we don't store a separate boolean. |
| `rating_avg` | numeric(2,1) | Average rating (e.g., 4.5). Auto-calculated by trigger. |
| `rating_count` | integer | Number of ratings received. Auto-calculated by trigger. |

**Design note:** One pharmacist (`owner_id`) can own multiple pharmacies (a chain). The `rating_avg` and `rating_count` are denormalized (stored directly instead of calculated each time) because they're read very frequently (every search result shows them) but updated rarely (only when a new rating is submitted). The trigger keeps them in sync.

---

#### Table 4: `pharmacy_on_duty_rotas`

**What it represents:** The "pharmacie de garde" (on-duty pharmacy) schedule.

**Analogy:** Like a hospital shift schedule — which pharmacy is on duty for each night, weekend, or holiday.

**Why this exists:** Algerian law requires that certain pharmacies stay open during nights, weekends, and public holidays on a rotating basis. Patients need to know which pharmacy is on duty tonight.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `pharmacy_id` | UUID (FK → pharmacies) | Which pharmacy is on duty |
| `duty_date` | date | The specific date of the duty shift |
| `duty_type` | text | Type of shift: `night`, `weekend`, `holiday` |

**Important constraints:**
- Unique on `(pharmacy_id, duty_date)` — a pharmacy can't be listed twice for the same date
- `duty_date` must be today or in the future (no backdating)

---

#### Table 5: `medicines`

**What it represents:** The master catalogue of all 5,425 officially registered medicines in Algeria.

**Analogy:** Like a library catalogue — every book (medicine) that exists is listed here with its details, whether or not any library branch (pharmacy) currently has it in stock.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique medicine identifier |
| `commercial_name` | text | Brand name (e.g., "DOLIPRANE") |
| `dci` | text | Generic name / active ingredient (e.g., "PARACETAMOL"). DCI stands for "Dénomination Commune Internationale" (International Nonproprietary Name). |
| `dosage_form` | text | How the medicine is taken (e.g., "COMPRIME" = tablet, "SIROP" = syrup, "INJECTABLE" = injection) |
| `strength` | text | Dose per unit (e.g., "500 MG", "1000 MG") |
| `laboratory` | text | The manufacturer |
| `ean13` | char(13) | EAN-13 barcode (13-digit international barcode, generated with Algeria's GS1 prefix 613) |
| `nomenclature_year` | smallint | Which edition of the nomenclature (e.g., 2026) |

**Important constraints:**
- `ean13` must be unique (no two medicines share a barcode)
- Commercial name is required (not null)
- DCI is required (not null)

---

#### Table 6: `medicine_equivalents`

**What it represents:** Links between medicines that can substitute for each other.

**Analogy:** Think of it like a "See also" section in an encyclopedia. If you look up "DOLIPRANE 500MG", it says "See also: DAFALGAN 500MG, EFFERALGAN 500MG" — because they all contain PARACETAMOL 500MG.

**Why this exists:** One of DWA's killer features. If the medicine you're looking for is out of stock, we can suggest alternatives with the same active ingredient and dosage. This saves patients from going home empty-handed.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `medicine_id` | UUID (FK → medicines) | The first medicine |
| `equivalent_id` | UUID (FK → medicines) | The equivalent medicine |
| `equivalence_type` | text | `exact_generic` or `therapeutic_alternative` |

**Equivalence types:**
- **`exact_generic`** — Same molecule, same dose, same form. DOLIPRANE 500MG and DAFALGAN 500MG are both PARACETAMOL 500MG tablets. They are interchangeable.
- **`therapeutic_alternative`** — Different molecule, but same therapeutic effect. PARACETAMOL and IBUPROFENE both treat pain and fever, but they're different molecules. A pharmacist might suggest one if the other is unavailable.

**Important constraints:**
- `medicine_id ≠ equivalent_id` — a medicine can't be equivalent to itself
- Unique on `(medicine_id, equivalent_id)` — no duplicate links

---

#### Table 7: `pharmacy_stock`

**What it represents:** What each pharmacy actually has on its shelves, tracked per batch.

**Analogy:** Like a warehouse inventory system. Each row is a specific batch of a specific medicine at a specific pharmacy. Batch #12345 of Doliprane at Pharmacie El Afia: 50 boxes, produced Jan 2026, expires Jan 2028, 10 boxes currently reserved.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique stock entry identifier |
| `pharmacy_id` | UUID (FK → pharmacies) | Which pharmacy has this stock |
| `medicine_id` | UUID (FK → medicines) | Which medicine |
| `batch_number` | text | Manufacturer's batch/lot number |
| `barcode` | text | The barcode on the physical box |
| `production_date` | date | When this batch was manufactured |
| `expiry_date` | date | When this batch expires |
| `total_quantity` | integer | How many boxes are on the shelf |
| `reserved_quantity` | integer | How many boxes are currently held for reservations |
| `unit_price_dzd` | numeric(10,2) | Price per box in Algerian Dinars |

**The critical constraint:**

```sql
CHECK (total_quantity >= reserved_quantity)
```

This means you can never reserve more boxes than exist. If `total_quantity = 10` and `reserved_quantity = 10`, all stock is reserved — the next reservation attempt will fail.

**Available quantity** is calculated as: `total_quantity - reserved_quantity` (shown in the view, not stored).

---

### Domain C: Reservations, Payments & Ratings (3 tables)

#### Table 8: `reservations`

**What it represents:** When a patient reserves medicine for pickup at a pharmacy.

**Analogy:** Like a restaurant reservation — you book a table (medicine) for a specific time. If you don't show up within the hold period, the reservation expires and the table becomes available again.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique reservation identifier |
| `patient_id` | UUID (FK → users) | Who made the reservation |
| `stock_id` | UUID (FK → pharmacy_stock) | Which specific stock batch is being reserved |
| `quantity` | integer | How many boxes (must be ≥ 1) |
| `status` | reservation_status ENUM | Current state in the lifecycle |
| `pickup_code` | char(6) | A 6-digit code the patient shows at the pharmacy to prove the reservation is theirs |
| `hold_expires_at` | timestamptz | When the hold expires if the patient hasn't picked up |
| `total_price_dzd` | numeric(10,2) | Total price (quantity × unit price) |

**The Reservation State Machine:**

A reservation moves through states in a specific order. Not all transitions are allowed:

```
                    ┌──────────────┐
                    │   cancelled  │
                    └──────────────┘
                          ↑
┌────────────────┐   ┌────┴───────────┐   ┌──────────────────┐   ┌─────────────┐
│ pending_payment│──→│ confirmed_held │──→│ ready_for_pickup │──→│  completed  │
└────────────────┘   └────────────────┘   └──────────────────┘   └─────────────┘
        │                    │
        ↓                    ↓
┌────────────────┐   ┌──────────────┐
│   cancelled    │   │   expired    │
└────────────────┘   └──────────────┘
```

**Allowed transitions (enforced by trigger):**
- `pending_payment` → `confirmed_held` (payment successful)
- `pending_payment` → `cancelled` (patient cancels before paying)
- `confirmed_held` → `ready_for_pickup` (pharmacist marks it ready)
- `confirmed_held` → `expired` (patient didn't pick up in time)
- `confirmed_held` → `cancelled` (patient or pharmacist cancels)
- `ready_for_pickup` → `completed` (patient picked up the medicine)

**Any other transition is rejected by the trigger.** For example, you cannot go from `completed` back to `pending_payment`.

---

#### Table 9: `payments`

**What it represents:** Every financial transaction processed through Chargily (Algeria's main payment gateway).

**Analogy:** Like a receipt book — one entry per transaction, recording what was paid, how much, and whether it succeeded.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique payment identifier |
| `user_id` | UUID (FK → users) | Who made the payment |
| `reservation_id` | UUID (FK → reservations) | Which reservation this pays for (null for pro plan payments) |
| `purpose` | payment_purpose ENUM | `reservation_deposit` or `pro_plan` |
| `amount_dzd` | numeric(10,2) | Amount in Algerian Dinars |
| `status` | payment_status ENUM | `pending`, `succeeded`, `failed`, `refunded` |
| `chargily_checkout_id` | text | Unique ID from Chargily's system |

**Webhook Idempotency:** The `chargily_checkout_id` column has a UNIQUE constraint. When Chargily sends us a webhook notification saying "payment X succeeded", we update the payment record. If Chargily sends the same notification twice (which can happen due to network retries), the second attempt either updates the same row or is safely ignored. Without this, we could accidentally process a payment twice.

**Two payment purposes:**
1. **`reservation_deposit`** — Patient pays a deposit to hold medicine. Linked to a specific reservation via `reservation_id`.
2. **`pro_plan`** — Pharmacy pays for a subscription plan. `reservation_id` is null.

---

#### Table 10: `pharmacy_ratings`

**What it represents:** Patient reviews of pharmacies after completing a reservation.

**Analogy:** Like Google Reviews — you can only review a restaurant after you've actually eaten there (completed a reservation).

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique rating identifier |
| `reservation_id` | UUID (FK → reservations) | Which completed reservation this review is for |
| `pharmacy_id` | UUID (FK → pharmacies) | Which pharmacy is being reviewed |
| `patient_id` | UUID (FK → users) | Who wrote the review |
| `rating` | smallint | Score from 1 to 5 stars |
| `comment` | text | Optional text review |

**Important constraints:**
- Rating must be between 1 and 5 (CHECK constraint)
- One rating per reservation (UNIQUE on `reservation_id`)
- The reservation must be `completed` (enforced by trigger `trg_rating_only_completed`)
- When a rating is inserted/updated, trigger `trg_recalc_pharmacy_rating` auto-updates the pharmacy's `rating_avg` and `rating_count`

---

### Domain D: Prescriptions, Alerts & Demand Analytics (4 tables)

#### Table 11: `prescriptions`

**What it represents:** When a patient uploads a photo of their prescription and broadcasts it to pharmacies in their wilaya.

**Analogy:** Like posting a "wanted" ad on a bulletin board — "I need these medicines, which pharmacy has them?"

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique prescription identifier |
| `patient_id` | UUID (FK → users) | Who uploaded the prescription |
| `image_url` | text | URL of the prescription photo |
| `wilaya_code` | char(2) | Which wilaya to broadcast to |
| `notes` | text | Optional notes from the patient |
| `is_active` | boolean | Whether the prescription is still open for responses |

**How it works:** A patient uploads their prescription photo. All pharmacies in the same wilaya can see it and respond with availability information. Once the patient finds what they need, they mark the prescription as inactive.

---

#### Table 12: `prescription_responses`

**What it represents:** A pharmacist's reply to a prescription request.

**Analogy:** Like a contractor responding to a "Request for Quote" — "I have these items, here's my price, and if I don't have something, try this other pharmacy."

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique response identifier |
| `prescription_id` | UUID (FK → prescriptions) | Which prescription this responds to |
| `pharmacy_id` | UUID (FK → pharmacies) | Which pharmacy is responding |
| `availability_status` | text | `full` (have everything), `partial` (have some), or `unavailable` |
| `message` | text | Optional message to the patient |
| `referral_pharmacy_id` | UUID (FK → pharmacies) | Suggested alternative pharmacy (optional) |

**Important constraint:**
- Unique on `(prescription_id, pharmacy_id)` — a pharmacy can only respond once to each prescription

---

#### Table 13: `stock_alerts_reminders`

**What it represents:** Notifications that patients set up for themselves.

**Analogy:** Like a "notify me when back in stock" button on Amazon, or a phone reminder to refill your prescription.

**Two types:**
1. **`back_in_stock`** — "Notify me when Doliprane 500MG is available at a pharmacy near me." Useful when a medicine is currently out of stock everywhere.
2. **`refill_reminder`** — "Remind me in 30 days to buy more of my blood pressure medication." Useful for chronic conditions requiring regular refills.

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique alert identifier |
| `patient_id` | UUID (FK → users) | Who set up the alert |
| `medicine_id` | UUID (FK → medicines) | Which medicine |
| `alert_type` | alert_type ENUM | `back_in_stock` or `refill_reminder` |
| `remind_at` | timestamptz | When to send the reminder (for refill reminders) |
| `is_triggered` | boolean | Has the alert already fired? (Prevents duplicate notifications) |
| `location` | geography(Point, 4326) | Patient's location (for back-in-stock: search nearby pharmacies) |

---

#### Table 14: `search_logs`

**What it represents:** An anonymous log of every medicine search performed on the platform.

**Analogy:** Like Google Analytics but for medicine searches — what are people looking for, where, and did they find it?

**Key columns explained:**

| Column | Type | What It Stores |
|---|---|---|
| `id` | UUID | Unique log entry identifier |
| `query_text` | text | What the patient typed (e.g., "Doliprane") |
| `medicine_id` | UUID (FK → medicines) | Which medicine was matched (null if no match) |
| `wilaya_code` | char(2) | Where the search was made |
| `found_in_stock` | boolean | Was the medicine available at any nearby pharmacy? |
| `location` | geography(Point, 4326) | Where the search originated (for distance-based analytics) |
| `searched_at` | timestamptz | When the search happened |

**Why this matters — The `v_unmet_demand` View:**

This view aggregates search logs where `found_in_stock = false`, grouped by medicine and wilaya. It answers: "What medicines are people searching for but can't find in Wilaya 16 (Algiers)?"

This is gold for pharmacies: if 500 people searched for "AUGMENTIN" in Algiers this week but none found it, that's a clear signal for pharmacies to stock it.

---

## 4. How the Medicine Catalogue Was Built

### Source: Official Algerian Nomenclature

The medicines table was populated from the **"NOMENCLATURE NATIONALE DES PRODUITS PHARMACEUTIQUES"** (National Nomenclature of Pharmaceutical Products), published by the Algerian **Ministry of Pharmaceutical Industry** (Ministère de l'Industrie Pharmaceutique).

We used the **August 2026 edition**, which contains **5,425 registered pharmaceutical products** — each one has an official "Décision d'Enregistrement" (Registration Decision) number.

### What the Nomenclature Contains

Each entry in the official Excel file includes:

| Field | Example | Our Column |
|---|---|---|
| Nom Commercial | DOLIPRANE | `commercial_name` |
| DCI | PARACETAMOL | `dci` |
| Forme | COMPRIME | `dosage_form` |
| Dosage | 500 MG | `strength` |
| Laboratoire | SANOFI AVENTIS | `laboratory` |

### What is DCI?

**DCI** stands for **"Dénomination Commune Internationale"** — in English, **International Nonproprietary Name (INN)**. It is the universal scientific name for a drug's active ingredient, assigned by the World Health Organization (WHO).

**Why DCI matters:**
- The same molecule can have many brand names. PARACETAMOL is sold as Doliprane, Dafalgan, Efferalgan, Tylenol, and dozens more.
- DCI is the common thread. By storing the DCI, we can link all brands of the same molecule together — enabling the "medicine equivalents" feature.

### Generated EAN-13 Barcodes

The official nomenclature does **not** include barcodes. We generated EAN-13 barcodes using:
- **Algeria's GS1 country prefix: 613**
- A sequential product code
- The EAN-13 check digit algorithm

This allows pharmacists to scan medicine barcodes to add stock entries quickly.

### Auto-Generated Medicine Equivalents

We automatically created `exact_generic` equivalence links by grouping medicines that share the same:
- DCI (active ingredient)
- Strength (dosage)
- Dosage form

For example, all medicines with `dci = 'PARACETAMOL'`, `strength = '500 MG'`, and `dosage_form = 'COMPRIME'` are linked as exact generics of each other.

### Generated Pharmacy Data

We generated **500 pharmacies** across all **58 Algerian wilayas** using the `algerian-geo` package, which provides:
- Real commune names for every wilaya
- Authentic GPS coordinates for each commune

This ensures realistic spatial queries during development and testing.

---

## 5. How a Medicine Search Works Step-by-Step

### Scenario: A patient in Bab Ezzouar, Algiers searches for "Doliprane"

Let's trace every step from the moment the patient taps "Search" to the results appearing on screen.

---

**Step 1: The Frontend Sends the Request**

The patient types "Doliprane" in the search bar. The app sends this to our backend:

```json
{
  "query": "Doliprane",
  "latitude": 36.7225,
  "longitude": 3.1822,
  "radius_meters": 5000
}
```

The coordinates `(36.7225, 3.1822)` are the patient's GPS location in Bab Ezzouar, a commune in eastern Algiers.

---

**Step 2: Fuzzy Text Matching (pg_trgm)**

The database searches the `medicines` table using trigram similarity:

```sql
SELECT id, commercial_name, dci
FROM medicines
WHERE commercial_name % 'Doliprane'  -- trigram similarity operator
ORDER BY similarity(commercial_name, 'Doliprane') DESC;
```

The `%` operator returns rows where the similarity score exceeds a threshold (default 0.3). This means even misspellings work:
- "Dolipran" (missing the 'e') → matches ✓
- "doliprane" (lowercase) → matches ✓
- "Dolyprane" (wrong vowel) → matches ✓

The GIN index (`idx_med_commercial_trgm`) makes this fast — no full table scan needed.

**Result:** Medicine found → `DOLIPRANE`, DCI = `PARACETAMOL`

---

**Step 3: Find Equivalent Medicines**

We query `medicine_equivalents` to find all medicines with the same DCI:

```sql
SELECT equivalent_id FROM medicine_equivalents
WHERE medicine_id = '<doliprane_id>'
AND equivalence_type = 'exact_generic';
```

**Result:** DAFALGAN 500MG, EFFERALGAN 500MG, and other paracetamol generics.

---

**Step 4: Check Stock Availability**

We query the `v_pharmacy_medicine_availability` view for all pharmacies that have Doliprane **or any of its equivalents** in stock:

```sql
SELECT *
FROM v_pharmacy_medicine_availability
WHERE medicine_id IN ('<doliprane_id>', '<dafalgan_id>', '<efferalgan_id>', ...)
AND stock_status != 'out_of_stock';
```

This view automatically filters out expired batches (`expiry_date > now()`) and calculates available quantity (`total - reserved`).

---

**Step 5: Geographic Filtering (PostGIS)**

From the pharmacies with stock, we filter only those within 5 km:

```sql
SELECT p.name, p.address,
       ST_Distance(p.location, ST_MakePoint(3.1822, 36.7225)::geography) AS distance_meters
FROM pharmacies p
WHERE ST_DWithin(
    p.location,
    ST_MakePoint(3.1822, 36.7225)::geography,
    5000  -- 5 km in meters
);
```

**Note:** `ST_MakePoint(longitude, latitude)` — longitude comes first! This is a common gotcha.

The GiST index (`idx_pharmacy_location`) makes this efficient — it doesn't check every pharmacy, just those in the spatial neighborhood.

---

**Step 6: Sort by Distance**

Results are ordered by distance so the closest pharmacy appears first:

```sql
ORDER BY distance_meters ASC;
```

---

**Step 7: Build the Response**

Each result sent to the frontend includes:

| Field | Example Value |
|---|---|
| Pharmacy name | Pharmacie El Afia |
| Distance | 1.2 km |
| Medicine name | DOLIPRANE 500MG COMPRIME |
| Price | 150.00 DZD |
| Available quantity | 23 boxes |
| Stock status | in_stock |
| Rating | ⭐ 4.5 (42 reviews) |

If the original medicine (Doliprane) isn't available nearby but an equivalent is, the result shows:
- "DOLIPRANE not found nearby. **DAFALGAN 500MG** (same DCI: PARACETAMOL) available at Pharmacie Central — 2.3 km away."

---

**Step 8: Log the Search**

The search is recorded in `search_logs`:

```sql
INSERT INTO search_logs (query_text, medicine_id, wilaya_code, found_in_stock, location)
VALUES ('Doliprane', '<medicine_id>', '16', true,
        ST_MakePoint(3.1822, 36.7225)::geography);
```

If no stock was found anywhere, `found_in_stock = false`. This feeds into the `v_unmet_demand` view, helping pharmacies identify what medicines people need but can't find.

---

## 6. How to Defend This in Front of the Professor

Here are five questions a professor is likely to ask about the database design, with clear, confident answers.

---

### Q1: "Why didn't you just store `stock_status` as a column?"

**Answer:**

Because `stock_status` is **derived data** — it's calculated from other values that already exist in the database:

```
available = total_quantity - reserved_quantity

if available = 0  → 'out_of_stock'
if available ≤ 5  → 'low_stock'
if available > 5  → 'in_stock'
```

If we stored `stock_status` as a column, we'd have to update it every time:
- A reservation is created (reserved_quantity goes up)
- A reservation is cancelled or expires (reserved_quantity goes down)
- Stock is added or removed (total_quantity changes)

That's at least 3 different places in the code that must remember to recalculate the status. If even one forgets, the status gets out of sync — a pharmacy might show "in stock" when it's actually empty.

Our solution: the view `v_pharmacy_stock_status` calculates it on the fly. It's **always correct** because it reads the current values, not a cached copy. This is a textbook application of the **DRY principle** (Don't Repeat Yourself) applied to data.

---

### Q2: "What happens if two patients try to reserve the last box at the same time?"

**Answer:**

This is the classic **race condition** problem, and we solve it with **row-level locking**.

Our `fn_create_reservation` function does this:

```sql
SELECT total_quantity, reserved_quantity
FROM pharmacy_stock
WHERE id = $1
FOR UPDATE;  -- Locks this specific row
```

Here's the timeline:

1. **Patient A's transaction** starts first, executes `FOR UPDATE` — the stock row is now **locked**
2. **Patient B's transaction** tries to read the same row — it **waits** (the row is locked)
3. Patient A's transaction sees `available = 1`, creates the reservation, sets `reserved_quantity = 1`
4. Patient A's transaction **commits** → lock is released
5. Patient B's transaction now runs, reads the row: `available = 10 - 10 = 0`
6. Patient B's transaction raises an error: **"Insufficient stock"**

No double-booking is possible. This is PostgreSQL's built-in row-level locking — it's ACID-compliant (Atomic, Consistent, Isolated, Durable) and battle-tested.

---

### Q3: "Why 14 tables? Isn't that too many?"

**Answer:**

Each table represents **one distinct real-world concept** — this is the **Single Responsibility Principle** applied to database design, also known as **normalization**.

Consider the alternative: merging `prescriptions` into `reservations`. Every reservation row would then have columns like `prescription_image_url`, `prescription_notes`, `prescription_is_active` — all null for non-prescription reservations. And every prescription row would have `pickup_code`, `hold_expires_at`, `total_price_dzd` — all null for prescriptions that haven't become reservations yet.

Problems with "wide tables":
1. **Wasted space** — Most columns are null most of the time
2. **Ambiguous data** — Is a row a reservation, a prescription, or both?
3. **Update anomalies** — Changing a prescription's status might accidentally affect the reservation
4. **Weak constraints** — You can't enforce "rejection_reason is required when status = rejected" as cleanly

Our 14 tables are **normalized to 3NF** (Third Normal Form): no data redundancy, no update anomalies, and every non-key column depends only on the primary key. The only intentional denormalization is `rating_avg` and `rating_count` on the `pharmacies` table (kept in sync by a trigger for read performance).

---

### Q4: "How do you handle expired reservations?"

**Answer:**

We have a function called `fn_expire_due_reservations()` that runs periodically (called by a cron job or background worker):

```sql
-- Find all reservations that should have expired
UPDATE reservations
SET status = 'expired', updated_at = now()
WHERE status IN ('pending_payment', 'confirmed_held')
  AND hold_expires_at < now()
  -- ...using FOR UPDATE SKIP LOCKED to avoid blocking
```

Key design decisions:

1. **`FOR UPDATE SKIP LOCKED`** — If a patient is actively completing a reservation at the exact moment the expiry job runs, the expiry job **skips** that row instead of waiting. This prevents the expiry job from blocking real-time user operations.

2. **Releasing stock** — When a reservation expires, the `reserved_quantity` on the stock row is decremented, making those units available for other patients.

3. **Idempotency** — Running the function twice doesn't cause problems. Reservations already marked `expired` have a status that can't transition again (the state machine trigger prevents it).

---

### Q5: "Why PostGIS instead of just storing latitude and longitude as numbers?"

**Answer:**

We could store `latitude NUMERIC(9,6)` and `longitude NUMERIC(9,6)` — but then:

1. **No spatial indexes.** Finding pharmacies within 5 km would require calculating the Haversine formula for **every single pharmacy** in the database. With 10,000 pharmacies, that's 10,000 trigonometric calculations per search. PostGIS's GiST index eliminates 99% of candidates before any distance calculation.

2. **Haversine in application code is error-prone.** You have to implement the formula yourself, handle edge cases (international date line, poles), and hope you got the math right. PostGIS's `ST_DWithin()` is tested, optimized, and handles all edge cases.

3. **`geography` type understands Earth's curvature.** Plain numbers treat lat/lng as a flat plane. At Algeria's latitude (~36°N), 1 degree of longitude ≈ 90 km, but 1 degree of latitude ≈ 111 km. A flat-plane distance formula would be inaccurate. PostGIS's geography type uses a geodesic model of the Earth.

4. **Performance.** Our target is **sub-300ms search response**. Without spatial indexing, we'd never hit that target with a growing pharmacy database. PostGIS + GiST index gives us O(log n) spatial lookups instead of O(n) full scans.

**In summary:** PostGIS gives us correctness (accurate distances), performance (spatial indexes), and developer productivity (built-in functions like `ST_DWithin`, `ST_Distance`, `ST_MakePoint`) — all without writing a single line of distance calculation code ourselves.

---

> **Final note:** This database design was built with three principles in mind: **correctness** (constraints, triggers, and state machines prevent bad data), **performance** (GIN, GiST, and row-level locking for concurrent access), and **Algerian context** (Law 18-07 compliance, CHIFA integration, wilaya-based organization, pharmacie de garde schedules, and the official medicine nomenclature). Every design decision has a reason, and this guide explains them all.

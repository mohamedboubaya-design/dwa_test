# DWA – Algerian Pharmacy Stock, Reservation & Prescription Platform

[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-blue.svg)](https://www.postgresql.org/)
[![PostGIS](https://img.shields.io/badge/PostGIS-Spatial%20GIS-green.svg)](https://postgis.net/)
[![pg_trgm](https://img.shields.io/badge/pg__trgm-Fuzzy%20Search-orange.svg)](https://www.postgresql.org/docs/current/pgtrgm.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%2B-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

DWA is a production-grade database and backend infrastructure layer designed to solve medicine availability, pharmacy discovery, concurrent holds, and prescription fulfillment across all 58 wilayas of Algeria.

---

## Features & Architectural Highlights

- **5,425 Official Algerian Medicines**: Seeded from the Ministry of Health Nomenclature Excel with barcodes, strength, dosage forms, prescription list status, and Chifa reimbursement flags.
- **pg_trgm Fuzzy Search**: Sub-millisecond typo-tolerant matching on brand names (e.g. *Doliprane*) and generic DCI names (*Paracétamol*) without external search engines.
- **PostGIS Geodesic Proximity**: Spatial filtering and sorting with `ST_DWithin` and `ST_Distance` on `geography(Point, 4326)` across 500+ geo-located Algerian pharmacies.
- **Exact Generic Equivalents**: M:N self-referencing relationship mapping bioequivalents with automatic search fallback when primary products are out of stock.
- **Pessimistic Concurrency Protection**: Zero double-booking on last-box reservations using row-level locking (`SELECT ... FOR UPDATE`) in `fn_create_reservation()`.
- **Database-Enforced State Machine**: Reservation lifecycle transitions (`pending_payment -> confirmed_held -> ready_for_pickup -> completed`) strictly validated by triggers.
- **Verified Rating Guard**: Enforces that only completed reservations can be reviewed, with auto-recalculated ratings and `ON DELETE CASCADE`.
- **30-Day Unmet Demand Analytics**: Real-time regional shortage telemetry (`v_unmet_demand`) derived from patient search logs.

---

## Getting Started

### Prerequisites

- **Node.js**: `v18.0.0` or higher
- **Package Manager**: `npm`
- **PostgreSQL**: PostgreSQL 15+ with `postgis` and `pg_trgm` extensions enabled (or a Supabase project)

### 1. Environment Configuration

Copy the example environment file and provide your database credentials:

```bash
cp .env.example .env
```

Ensure `.env` contains your connection URL:

```env
DATABASE_URL="postgresql://<user>:<password>@<host>:5432/postgres"
SUPABASE_PROJECT_ID="<your-project-id>"
```

---

## Database Management & CLI Commands

All database operations are managed via TypeScript scripts using `tsx`:

| Command | Script | Description |
|---|---|---|
| `npm run db:migrate` | `db/scripts/migrate.ts` | Runs incremental SQL migrations (`001_initial_schema.sql`, `002_fixes.sql`) |
| `npm run db:seed` | `db/seeds/seed.ts` | Seeds 5,425 medicines, 17,000+ equivalents, 500 pharmacies, stock batches, and logs |
| `npm run db:test` | `db/tests/schema.test.ts` | Concurrency, race condition, state machine, and rating trigger test suite |
| `npm run db:load-test` | `db/tests/load-test.ts` | 200 concurrent spatial search load test measuring p50, p95, p99 latencies (< 300ms SLA) |
| `npm run db:backup` | `db/scripts/backup.ts` | Dumps database tables and PostGIS geometries into a portable JSON snapshot |
| `npm run db:restore` | `db/scripts/restore.ts` | Restores database tables in strict dependency order and verifies row integrity |

---

## Running Migrations

To apply the database schema, functions, triggers, views, and performance indexes:

```bash
npm run db:migrate
```

*Output:*
```text
🚀 Applying migration: 001_initial_schema.sql
✅ Applied 001_initial_schema.sql in 5344ms
🚀 Applying migration: 002_fixes.sql
✅ Applied 002_fixes.sql in 3080ms
🎉 All migrations applied successfully!
```

---

## Seeding Sample & Official Data

To populate the database with official Algerian nomenclature data and realistic pharmacy stock across 58 wilayas:

```bash
npm run db:seed
```

---

## Running Automated Tests

Run the schema, constraint, and concurrency test suite:

```bash
npm run db:test
```

### Verified Test Cases:
1. **`fn_stock_status` Boundaries**: Evaluates threshold logic at `-2`, `0` (`out_of_stock`), `1`, `5` (`low_stock`), and `6`, `100` (`in_stock`).
2. **Last-Box Race Condition (`Promise.allSettled`)**: Concurrently fires 10 simultaneous reservations on a single remaining box; verifies exactly 1 succeeds and 9 are rejected.
3. **Expired Batch Rejection**: Verifies `fn_create_reservation` rejects expired inventory (`expiry_date < CURRENT_DATE`).
4. **Reservation State Machine**: Rejects invalid transitions (e.g. `pending_payment -> ready_for_pickup`, `completed -> cancelled`) while allowing legal transitions and `pending_payment -> expired`.
5. **Rating Integrity**: Rejects reviews for incomplete reservations, recalculates `rating_avg` via scalar subquery, and cascades on reservation deletion.

---

## Running the Load Test Benchmark

Simulates 200 concurrent spatial medicine searches combining `pg_trgm`, `ST_DWithin`, and availability view joins:

```bash
npm run db:load-test
```

The benchmark measures p50, p95, and p99 response times and saves a detailed report to [`docs/database/load-test-report.md`](file:///C:/Users/PC/DWA/docs/database/load-test-report.md).

---

## Database Backup and Disaster Recovery

### Creating a Backup
```bash
npm run db:backup
```
Dumps all 15 relational tables, PostGIS WKT spatial coordinates, and foreign key dependencies into `db/backups/latest.json`.

### Restoring from Backup
```bash
npm run db:restore
```
Truncates tables in reverse foreign-key order, batch-restores all records in dependency order, resets identity sequences, and executes a full verification check against the manifest.

---

## Query Modules Reference

- **Medicine Search** (`db/queries/search.ts`):
  ```typescript
  import { searchMedicines } from './db/queries/search';

  const results = await searchMedicines({
    query: 'Doliprane',
    latitude: 36.7225,
    longitude: 3.1822,
    radiusMeters: 5000,
    inStockOnly: true,
    allowEquivalents: true,
  });
  ```

- **Unmet Demand Analytics** (`db/queries/analytics.ts`):
  ```typescript
  import { getUnmetDemand, getWilayaDemandSummary } from './db/queries/analytics';

  const shortages = await getUnmetDemand({ wilaya: 'Alger', minSearches: 5 });
  const nationalSummary = await getWilayaDemandSummary();
  ```

---

## Documentation

- [Data Dictionary](file:///C:/Users/PC/DWA/docs/database/data-dictionary.md): Detailed specifications of all 15 tables, enums, views, and functions.
- [Architecture Decision Records (ADRs)](file:///C:/Users/PC/DWA/docs/database/ADR.md): Formal documentation of the 5 core architectural decisions.
- [Load Test Report](file:///C:/Users/PC/DWA/docs/database/load-test-report.md): 200-query latency and throughput verification report.
- [Backup & Restore Proof](file:///C:/Users/PC/DWA/docs/database/backup-restore-proof.md): Verified backup and restore log.

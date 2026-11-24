/**
 * db/seeds/seed.ts
 * Seeds the DWA database with:
 *   1. 5,425 official Algerian medicines from the Ministry Nomenclature Excel
 *   2. Medicine equivalents (same DCI = exact_generic)
 *   3. Test users (patients, pharmacists, admin)
 *   4. 500 pharmacies across all 58 Algerian wilayas with real GPS coordinates
 *   5. On-duty rotas, batch stock inventory, and sample search logs
 *
 * Usage: npm run db:seed
 */
import { PoolClient } from 'pg';
import { pool } from '../client';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Helpers ─────────────────────────────────────────────────────────────
function generateEAN13(index: number): string {
  // Algeria GS1 prefix: 613 + 9-digit product code + check digit
  const prefix = '613';
  const productCode = String(index).padStart(9, '0');
  const raw = prefix + productCode;
  // EAN-13 check digit calculation
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(raw[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return raw + check;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomPrice(min: number, max: number): string {
  return (Math.random() * (max - min) + min).toFixed(2);
}

function futureDate(minDays: number, maxDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + randomInt(minDays, maxDays));
  return d.toISOString().split('T')[0];
}

function pastDate(minDays: number, maxDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - randomInt(minDays, maxDays));
  return d.toISOString().split('T')[0];
}

// ── XLSX Parsing ────────────────────────────────────────────────────────
interface MedicineRow {
  dci: string;
  brandName: string;
  form: string;
  dosage: string;
  code: string;          // Nomenclature code (groups generics)
  list: string;          // LISTE I / LISTE II / empty
  type: string;          // GE, RE, etc.
}

function parseMedicinesFromExcel(): MedicineRow[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx');
  const filePath = path.resolve(__dirname, '../../database/seeds/clean_NOMENCLATURE.VERSION.AOUT_.2026-.xlsx');
  console.log(`📄 Reading Excel: ${filePath}`);

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Nomenclature Aout 2026'];
  if (!ws) {
    console.error('❌ Sheet "Nomenclature Aout 2026" not found. Available:', wb.SheetNames);
    process.exit(1);
  }

  // Row 15 (0-indexed) = header, data starts at row 16
  const allRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const medicines: MedicineRow[] = [];

  for (let i = 16; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || !row[3] || !row[4]) continue; // Skip empty rows

    const dci = String(row[3] || '').trim().toUpperCase();
    const brandName = String(row[4] || '').trim().toUpperCase();
    const form = String(row[5] || '').trim();
    const dosage = String(row[6] || '').trim();
    const code = String(row[2] || '').trim();
    const list = String(row[8] || '').trim();
    const type = String(row[16] || '').trim();

    if (dci && brandName) {
      medicines.push({ dci, brandName, form, dosage, code, list, type });
    }
  }

  return medicines;
}

// ── Algerian Geo ────────────────────────────────────────────────────────
interface GeoCommune {
  id: string;
  name: string;
  wilaya_id: string;
  longitude: string; // Actually latitude (fields are swapped in the package!)
  latitude: string;  // Actually longitude
}

interface GeoWilaya {
  id: string;
  name: string;
}

function getAlgerianLocations(): { wilayas: GeoWilaya[]; communesByWilaya: Map<string, GeoCommune[]> } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ag = require('algerian-geo');
  const wilayas: GeoWilaya[] = ag.getAllWilayas();
  const communesByWilaya = new Map<string, GeoCommune[]>();

  for (const w of wilayas) {
    const communes: GeoCommune[] = ag.getCommunesByWilaya(w.id);
    if (communes && communes.length > 0) {
      communesByWilaya.set(w.id, communes);
    }
  }

  console.log(`🗺️  Loaded ${wilayas.length} wilayas, ${Array.from(communesByWilaya.values()).reduce((s, c) => s + c.length, 0)} communes`);
  return { wilayas, communesByWilaya };
}

// ── Main Seed ───────────────────────────────────────────────────────────
async function seed() {
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    // ─── Phase 0: Clean existing data ─────────────────────────────────
    console.log('\n🧹 Cleaning existing data...');
    await client.query('DELETE FROM search_logs');
    await client.query('DELETE FROM stock_alerts_reminders');
    await client.query('DELETE FROM prescription_responses');
    await client.query('DELETE FROM prescriptions');
    await client.query('DELETE FROM pharmacy_ratings');
    await client.query('DELETE FROM payments');
    await client.query('DELETE FROM reservations');
    await client.query('DELETE FROM pharmacy_stock');
    await client.query('DELETE FROM pharmacy_on_duty_rotas');
    await client.query('DELETE FROM medicine_equivalents');
    await client.query('DELETE FROM medicines');
    await client.query('DELETE FROM pharmacist_verifications');
    await client.query('DELETE FROM pharmacies');
    await client.query('DELETE FROM users');
    console.log('   ✅ All tables cleared');

    // ─── Phase 1: Create test users ───────────────────────────────────
    console.log('\n👤 Creating test users...');
    const adminResult = await client.query(`
      INSERT INTO users (email, password_hash, role, full_name, phone)
      VALUES ('admin@dwa.dz', '$2b$10$placeholder_admin_hash', 'admin', 'Admin DWA', '+213550000001')
      RETURNING id
    `);
    const adminId = adminResult.rows[0].id;

    // Create 10 pharmacist users
    const pharmacistIds: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const res = await client.query(`
        INSERT INTO users (email, password_hash, role, full_name, phone, law_18_07_consent_at)
        VALUES ($1, '$2b$10$placeholder_pharmacist_hash', 'pharmacist', $2, $3, now())
        RETURNING id
      `, [
        `pharmacist${i}@dwa.dz`,
        `Dr. Pharmacist ${i}`,
        `+2135500000${String(10 + i)}`,
      ]);
      pharmacistIds.push(res.rows[0].id);
    }

    // Create 20 patient users
    const patientIds: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const res = await client.query(`
        INSERT INTO users (email, password_hash, role, full_name, phone, chifa_card_number, law_18_07_consent_at)
        VALUES ($1, '$2b$10$placeholder_patient_hash', 'patient', $2, $3, $4, now())
        RETURNING id
      `, [
        `patient${i}@dwa.dz`,
        `Patient User ${i}`,
        `+2136600000${String(20 + i)}`,
        `300${String(100000000 + i)}`,
      ]);
      patientIds.push(res.rows[0].id);
    }
    console.log(`   ✅ Created 1 admin, ${pharmacistIds.length} pharmacists, ${patientIds.length} patients`);

    // ─── Phase 2: Insert medicines from Excel ─────────────────────────
    console.log('\n💊 Inserting medicines from official Nomenclature...');
    const medicineRows = parseMedicinesFromExcel();
    console.log(`   📋 Parsed ${medicineRows.length} medicines from Excel`);

    const medicineIds: string[] = [];
    const dciToMedicineIds = new Map<string, string[]>(); // For equivalents
    let insertedCount = 0;
    const BATCH_SIZE = 200;

    for (let batchStart = 0; batchStart < medicineRows.length; batchStart += BATCH_SIZE) {
      const batch = medicineRows.slice(batchStart, batchStart + BATCH_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < batch.length; j++) {
        const m = batch[j];
        const globalIdx = batchStart + j;
        const ean = generateEAN13(globalIdx + 1);
        const isPrescription = m.list.includes('LISTE');
        const offset = j * 7;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`);
        values.push(
          m.brandName,      // commercial_name
          m.dci,            // generic_dci_name
          m.dosage || null,  // strength
          m.form || null,    // dosage_form
          ean,              // barcode_ean
          isPrescription,   // is_prescription_only
          false             // chifa_reimbursable (default)
        );
      }

      const result = await client.query(`
        INSERT INTO medicines (commercial_name, generic_dci_name, strength, dosage_form, barcode_ean, is_prescription_only, chifa_reimbursable)
        VALUES ${placeholders.join(', ')}
        RETURNING id, generic_dci_name, strength, dosage_form
      `, values);

      for (const row of result.rows) {
        medicineIds.push(row.id);
        // Build DCI+strength+form grouping key for equivalents
        const key = `${row.generic_dci_name}||${row.strength || ''}||${row.dosage_form || ''}`;
        if (!dciToMedicineIds.has(key)) {
          dciToMedicineIds.set(key, []);
        }
        dciToMedicineIds.get(key)!.push(row.id);
      }

      insertedCount += batch.length;
      if (insertedCount % 1000 === 0 || insertedCount === medicineRows.length) {
        console.log(`   💊 Inserted ${insertedCount} / ${medicineRows.length} medicines...`);
      }
    }
    console.log(`   ✅ Inserted ${insertedCount} medicines total`);

    // ─── Phase 3: Generate medicine equivalents ───────────────────────
    console.log('\n🔗 Generating medicine equivalents (same DCI + strength + form)...');
    let equivCount = 0;
    let equivBatchValues: any[] = [];
    let equivBatchPlaceholders: string[] = [];

    for (const [_key, ids] of dciToMedicineIds) {
      if (ids.length < 2) continue;
      // Link all pairs (bidirectional)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const offset = equivBatchValues.length;
          equivBatchPlaceholders.push(`($${offset + 1}, $${offset + 2}, 'exact_generic')`);
          equivBatchValues.push(ids[i], ids[j]);
          equivBatchPlaceholders.push(`($${offset + 3}, $${offset + 4}, 'exact_generic')`);
          equivBatchValues.push(ids[j], ids[i]);
          equivCount += 2;

          // Flush every 2000 pairs
          if (equivBatchPlaceholders.length >= 2000) {
            await client.query(`
              INSERT INTO medicine_equivalents (medicine_id, equivalent_id, equivalence_type)
              VALUES ${equivBatchPlaceholders.join(', ')}
              ON CONFLICT DO NOTHING
            `, equivBatchValues);
            equivBatchPlaceholders = [];
            equivBatchValues = [];
            if (equivCount % 10000 === 0) {
              console.log(`   🔗 Inserted ${equivCount} equivalent links...`);
            }
          }
        }
      }
    }
    // Flush remaining
    if (equivBatchPlaceholders.length > 0) {
      await client.query(`
        INSERT INTO medicine_equivalents (medicine_id, equivalent_id, equivalence_type)
        VALUES ${equivBatchPlaceholders.join(', ')}
        ON CONFLICT DO NOTHING
      `, equivBatchValues);
    }
    console.log(`   ✅ Inserted ${equivCount} equivalent links across ${Array.from(dciToMedicineIds.values()).filter(ids => ids.length >= 2).length} DCI groups`);

    // ─── Phase 4: Create 500 pharmacies across Algeria ────────────────
    console.log('\n🏥 Creating 500 pharmacies across 58 wilayas...');
    const { wilayas, communesByWilaya } = getAlgerianLocations();

    const pharmacyNames = [
      'Pharmacie Centrale', 'Pharmacie du Soleil', 'Pharmacie El-Amal',
      'Pharmacie El-Hayat', 'Pharmacie Ibn Sina', 'Pharmacie El-Nour',
      'Pharmacie El-Shifa', 'Pharmacie El-Razi', 'Pharmacie Pasteur',
      'Pharmacie de la Gare', 'Pharmacie du Marché', 'Pharmacie de la Paix',
      'Pharmacie El-Farabi', 'Pharmacie Avicenne', 'Pharmacie du Parc',
      'Pharmacie des Oliviers', 'Pharmacie du Boulevard', 'Pharmacie El-Baraka',
      'Pharmacie du Quartier', 'Pharmacie de la Place',
    ];

    const pharmacyIds: string[] = [];
    const pharmacyWilayas: string[] = [];
    let pharmacyCount = 0;

    // Distribute pharmacies across wilayas (weighted by major cities)
    const majorWilayas = ['16', '31', '25', '19', '9', '15', '23', '6', '35', '26']; // Alger, Oran, Constantine, Sétif, Blida, Tizi Ouzou, Annaba, Béjaïa, Boumerdès, Médéa
    const pharmaciesPerWilaya: Map<string, number> = new Map();

    // Major wilayas get more pharmacies
    for (const wId of majorWilayas) {
      pharmaciesPerWilaya.set(wId, randomInt(15, 25));
    }
    // Remaining wilayas get fewer
    let allocated = Array.from(pharmaciesPerWilaya.values()).reduce((s, n) => s + n, 0);
    const remainingWilayas = wilayas.filter(w => !majorWilayas.includes(w.id));
    const perRemaining = Math.floor((500 - allocated) / remainingWilayas.length);

    for (const w of remainingWilayas) {
      pharmaciesPerWilaya.set(w.id, Math.max(2, perRemaining + randomInt(-1, 1)));
    }

    for (const w of wilayas) {
      const count = pharmaciesPerWilaya.get(w.id) || 3;
      const communes = communesByWilaya.get(w.id) || [];
      if (communes.length === 0) continue;

      for (let i = 0; i < count && pharmacyCount < 500; i++) {
        const commune = communes[i % communes.length];
        const ownerId = randomElement(pharmacistIds);
        const pharmacyName = `${randomElement(pharmacyNames)} ${commune.name}`;

        // algerian-geo has longitude/latitude fields swapped!
        // longitude field = actual latitude, latitude field = actual longitude
        const lat = parseFloat(commune.longitude) + (Math.random() - 0.5) * 0.01;
        const lng = parseFloat(commune.latitude) + (Math.random() - 0.5) * 0.01;

        const isPro = Math.random() < 0.2;
        const proPlanUntil = isPro ? futureDate(30, 365) : null;

        const openingHours = JSON.stringify({
          mon_fri: '08:00-20:00',
          sat: '08:00-18:00',
          sun: randomElement(['closed', '09:00-13:00']),
        });

        const res = await client.query(`
          INSERT INTO pharmacies (owner_id, name, wilaya, commune, address, phone, location, opening_hours, pro_plan_until)
          VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, $9::jsonb, $10)
          RETURNING id
        `, [
          ownerId,
          pharmacyName,
          w.name,
          commune.name,
          `${randomInt(1, 200)} Rue ${commune.name}, ${w.name}`,
          `+2130${randomInt(5, 7)}${String(randomInt(10000000, 99999999))}`,
          lng,  // ST_MakePoint(longitude, latitude)
          lat,
          openingHours,
          proPlanUntil,
        ]);

        pharmacyIds.push(res.rows[0].id);
        pharmacyWilayas.push(w.name);
        pharmacyCount++;

        if (pharmacyCount % 100 === 0) {
          console.log(`   🏥 Created ${pharmacyCount} / 500 pharmacies...`);
        }
      }
    }
    console.log(`   ✅ Created ${pharmacyCount} pharmacies across ${wilayas.length} wilayas`);

    // ─── Phase 5: On-duty rotas ───────────────────────────────────────
    console.log('\n📅 Creating on-duty rotas...');
    let rotaCount = 0;
    const shiftTypes = ['night', 'weekend', 'holiday'] as const;

    for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
      // Pick 2-4 pharmacies per day for duty
      const dutyCount = randomInt(2, 4);
      const selectedPharmacies = new Set<number>();
      while (selectedPharmacies.size < Math.min(dutyCount, pharmacyIds.length)) {
        selectedPharmacies.add(randomInt(0, pharmacyIds.length - 1));
      }

      for (const pIdx of selectedPharmacies) {
        const d = new Date();
        d.setDate(d.getDate() + dayOffset);
        const dutyDate = d.toISOString().split('T')[0];
        const dayOfWeek = d.getDay();

        let shift: typeof shiftTypes[number];
        if (dayOfWeek === 0 || dayOfWeek === 6) shift = 'weekend';
        else shift = 'night';

        const startsAt = shift === 'night'
          ? `${dutyDate}T20:00:00+01:00`
          : `${dutyDate}T08:00:00+01:00`;
        const endsAt = shift === 'night'
          ? `${dutyDate.replace(/\d{2}$/, String(parseInt(dutyDate.slice(-2)) + 1).padStart(2, '0'))}T08:00:00+01:00`
          : `${dutyDate}T20:00:00+01:00`;

        // Fix: ensure valid next day for night shifts
        const endDate = new Date(d);
        if (shift === 'night') endDate.setDate(endDate.getDate() + 1);
        const endDateStr = endDate.toISOString().split('T')[0];
        const actualEndsAt = shift === 'night'
          ? `${endDateStr}T08:00:00+01:00`
          : `${dutyDate}T20:00:00+01:00`;

        try {
          await client.query(`
            INSERT INTO pharmacy_on_duty_rotas (pharmacy_id, duty_date, shift_type, starts_at, ends_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (pharmacy_id, duty_date, shift_type) DO NOTHING
          `, [pharmacyIds[pIdx], dutyDate, shift, startsAt, actualEndsAt]);
          rotaCount++;
        } catch { /* skip conflicts */ }
      }
    }
    console.log(`   ✅ Created ${rotaCount} on-duty rota entries`);

    // ─── Phase 6: Pharmacy stock (batch inventory) ────────────────────
    console.log('\n📦 Seeding pharmacy stock...');
    let stockCount = 0;

    for (const pharmacyId of pharmacyIds) {
      // Each pharmacy stocks 20-60 random medicines
      const numMedicines = randomInt(20, 60);
      const selectedMedicines = new Set<number>();
      while (selectedMedicines.size < Math.min(numMedicines, medicineIds.length)) {
        selectedMedicines.add(randomInt(0, medicineIds.length - 1));
      }

      const stockValues: any[] = [];
      const stockPlaceholders: string[] = [];
      let paramIdx = 0;

      for (const mIdx of selectedMedicines) {
        const numBatches = randomInt(1, 3);
        for (let b = 0; b < numBatches; b++) {
          const totalQty = randomInt(0, 200);
          const reservedQty = Math.min(randomInt(0, 5), totalQty);
          const offset = paramIdx * 9;
          stockPlaceholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
          );
          stockValues.push(
            pharmacyId,
            medicineIds[mIdx],
            `BATCH-${String(mIdx + 1).padStart(5, '0')}-${String(b + 1).padStart(2, '0')}`,
            pastDate(30, 365),                     // production_date
            futureDate(30, 730),                    // expiry_date
            totalQty,
            reservedQty,
            parseFloat(randomPrice(50, 5000)),      // price_dzd
            randomInt(3, 10),                       // low_stock_threshold
          );
          paramIdx++;
        }
      }

      if (stockPlaceholders.length > 0) {
        await client.query(`
          INSERT INTO pharmacy_stock (pharmacy_id, medicine_id, batch_barcode, production_date, expiry_date, total_quantity, reserved_quantity, price_dzd, low_stock_threshold)
          VALUES ${stockPlaceholders.join(', ')}
          ON CONFLICT (pharmacy_id, medicine_id, batch_barcode) DO NOTHING
        `, stockValues);
        stockCount += stockPlaceholders.length;
      }

      if (pharmacyIds.indexOf(pharmacyId) % 100 === 0 && pharmacyIds.indexOf(pharmacyId) > 0) {
        console.log(`   📦 Stocked ${pharmacyIds.indexOf(pharmacyId)} / ${pharmacyIds.length} pharmacies (${stockCount} batch rows)...`);
      }
    }
    console.log(`   ✅ Created ${stockCount} stock batch entries`);

    // ─── Phase 7: Sample search logs ──────────────────────────────────
    console.log('\n🔍 Generating sample search logs...');
    let searchCount = 0;
    const searchQueries = [
      'Doliprane', 'Amoxicilline', 'Augmentin', 'Ventoline', 'Aspirin',
      'Ibuprofen', 'Paracetamol', 'Metformine', 'Oméprazole', 'Prednisolone',
      'Ciprofloxacine', 'Amlodipine', 'Loratadine', 'Cetirizine', 'Diclofenac',
    ];

    for (let i = 0; i < 500; i++) {
      const query = randomElement(searchQueries);
      const userId = Math.random() < 0.3 ? null : randomElement(patientIds);
      const medId = Math.random() < 0.4 ? null : randomElement(medicineIds);
      const wilaya = randomElement(pharmacyWilayas);
      const foundInStock = Math.random() < 0.65;
      const resultsCount = foundInStock ? randomInt(1, 20) : 0;

      await client.query(`
        INSERT INTO search_logs (user_id, medicine_id, raw_query, wilaya, results_count, found_in_stock, searched_at)
        VALUES ($1, $2, $3, $4, $5, $6, now() - (random() * interval '30 days'))
      `, [userId, medId, query, wilaya, resultsCount, foundInStock]);
      searchCount++;
    }
    console.log(`   ✅ Created ${searchCount} search log entries`);

    // ─── Final Stats ──────────────────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n' + '═'.repeat(60));
    console.log('🎉 SEED COMPLETE');
    console.log('═'.repeat(60));

    const stats = await client.query(`
      SELECT
        (SELECT count(*) FROM users)              AS users,
        (SELECT count(*) FROM medicines)           AS medicines,
        (SELECT count(*) FROM medicine_equivalents) AS equivalents,
        (SELECT count(*) FROM pharmacies)           AS pharmacies,
        (SELECT count(*) FROM pharmacy_on_duty_rotas) AS rotas,
        (SELECT count(*) FROM pharmacy_stock)       AS stock_rows,
        (SELECT count(*) FROM search_logs)          AS search_logs
    `);
    const s = stats.rows[0];
    console.log(`   👤 Users:              ${s.users}`);
    console.log(`   💊 Medicines:          ${s.medicines}`);
    console.log(`   🔗 Equivalents:        ${s.equivalents}`);
    console.log(`   🏥 Pharmacies:         ${s.pharmacies}`);
    console.log(`   📅 On-duty rotas:      ${s.rotas}`);
    console.log(`   📦 Stock batches:      ${s.stock_rows}`);
    console.log(`   🔍 Search logs:        ${s.search_logs}`);
    console.log(`   ⏱️  Elapsed:            ${elapsed}s`);
    console.log('═'.repeat(60));

  } catch (err: any) {
    console.error('\n❌ Seed failed:', err.message);
    if (err.detail) console.error('   Detail:', err.detail);
    if (err.hint) console.error('   Hint:', err.hint);
    if (err.where) console.error('   Where:', err.where);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));

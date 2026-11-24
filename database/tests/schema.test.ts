/**
 * database/tests/schema.test.ts
 * Comprehensive database schema, constraints, and concurrency tests:
 *   1. Last-box race condition (Promise.allSettled concurrency test on fn_create_reservation)
 *   2. Reservation state-machine transitions (legal transitions and illegal rejections)
 *   3. fn_stock_status threshold boundaries (0, 5, 6)
 *   4. Completed-reservation rating guard and rating_avg cascade/NULL reset
 *
 * Usage: npm run db:test
 */
import { pool } from '../client';

interface TestContext {
  userId: string;
  patientId2: string;
  pharmacyId: string;
  medicineId: string;
  stockId: string;
}

let ctx: TestContext = {
  userId: '',
  patientId2: '',
  pharmacyId: '',
  medicineId: '',
  stockId: '',
};

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    failedCount++;
    console.error(`   ❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passedCount++;
    console.log(`   ✅ PASS: ${message}`);
  }
}

async function setupTestData(): Promise<void> {
  console.log('🔧 Setting up temporary test fixtures...');

  // 1. Create test user (patient)
  const userRes = await pool.query(`
    INSERT INTO users (email, password_hash, role, full_name, phone)
    VALUES ('test_patient_schema@dwa.dz', 'hash_test', 'patient', 'Test Patient', '+213550999001')
    RETURNING id;
  `);
  ctx.userId = userRes.rows[0].id;

  const user2Res = await pool.query(`
    INSERT INTO users (email, password_hash, role, full_name, phone)
    VALUES ('test_patient_schema2@dwa.dz', 'hash_test', 'patient', 'Test Patient 2', '+213550999002')
    RETURNING id;
  `);
  ctx.patientId2 = user2Res.rows[0].id;

  // 2. Create test pharmacy
  const pharmRes = await pool.query(`
    INSERT INTO pharmacies (owner_id, name, wilaya, commune, address, location)
    VALUES (
      $1,
      'Pharmacie Test Schema',
      'Alger',
      'Bab Ezzouar',
      'Rue Test 123',
      ST_SetSRID(ST_MakePoint(3.1822, 36.7225), 4326)::geography
    )
    RETURNING id;
  `, [ctx.userId]);
  ctx.pharmacyId = pharmRes.rows[0].id;

  // 3. Create or fetch test medicine
  const medRes = await pool.query(`
    INSERT INTO medicines (commercial_name, generic_dci_name, strength, dosage_form, barcode_ean)
    VALUES ('PARACETAMOL TEST SCHEMA 500MG', 'PARACETAMOL', '500mg', 'Comprimé', '6139999999991')
    ON CONFLICT (barcode_ean) DO UPDATE SET commercial_name = EXCLUDED.commercial_name
    RETURNING id;
  `);
  ctx.medicineId = medRes.rows[0].id;

  // 4. Create test stock row (single batch with 1 box)
  const stockRes = await pool.query(`
    INSERT INTO pharmacy_stock (
      pharmacy_id, medicine_id, batch_barcode, production_date, expiry_date,
      total_quantity, reserved_quantity, low_stock_threshold, price_dzd
    )
    VALUES (
      $1, $2, 'BATCH-TEST-SCHEMA-001', CURRENT_DATE - 30, CURRENT_DATE + 365,
      1, 0, 5, 150.00
    )
    RETURNING id;
  `, [ctx.pharmacyId, ctx.medicineId]);
  ctx.stockId = stockRes.rows[0].id;

  console.log('   ✅ Test fixtures ready.\n');
}

async function cleanupTestData(): Promise<void> {
  console.log('\n🧹 Cleaning up temporary test fixtures...');
  try {
    if (ctx.pharmacyId) {
      await pool.query('DELETE FROM pharmacy_ratings WHERE pharmacy_id = $1', [ctx.pharmacyId]);
      await pool.query('DELETE FROM reservations WHERE pharmacy_id = $1', [ctx.pharmacyId]);
      await pool.query('DELETE FROM pharmacy_stock WHERE pharmacy_id = $1', [ctx.pharmacyId]);
      await pool.query('DELETE FROM pharmacies WHERE id = $1', [ctx.pharmacyId]);
    }
    if (ctx.medicineId) {
      await pool.query('DELETE FROM medicines WHERE id = $1', [ctx.medicineId]);
    }
    if (ctx.userId) {
      await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [ctx.userId, ctx.patientId2]);
    }
    console.log('   ✅ Test fixtures cleaned up successfully.');
  } catch (err: any) {
    console.error('⚠️ Cleanup error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Test 1: fn_stock_status boundaries (0, 5, 6)
// ---------------------------------------------------------------------------
async function testStockStatusBoundaries(): Promise<void> {
  console.log('🧪 Test 1: fn_stock_status boundaries (0, 5, 6)');

  const res0 = await pool.query('SELECT fn_stock_status(0, 5) AS status');
  assert(res0.rows[0].status === 'out_of_stock', 'available=0, threshold=5 -> out_of_stock');

  const resNeg = await pool.query('SELECT fn_stock_status(-2, 5) AS status');
  assert(resNeg.rows[0].status === 'out_of_stock', 'available=-2, threshold=5 -> out_of_stock');

  const res1 = await pool.query('SELECT fn_stock_status(1, 5) AS status');
  assert(res1.rows[0].status === 'low_stock', 'available=1, threshold=5 -> low_stock');

  const res5 = await pool.query('SELECT fn_stock_status(5, 5) AS status');
  assert(res5.rows[0].status === 'low_stock', 'available=5, threshold=5 -> low_stock (boundary inclusive)');

  const res6 = await pool.query('SELECT fn_stock_status(6, 5) AS status');
  assert(res6.rows[0].status === 'in_stock', 'available=6, threshold=5 -> in_stock (boundary + 1)');

  const res100 = await pool.query('SELECT fn_stock_status(100, 5) AS status');
  assert(res100.rows[0].status === 'in_stock', 'available=100, threshold=5 -> in_stock');
}

// ---------------------------------------------------------------------------
// Test 2: Last-box race condition concurrency (Promise.allSettled)
// ---------------------------------------------------------------------------
async function testLastBoxRaceCondition(): Promise<void> {
  console.log('\n🧪 Test 2: Last-Box Race Condition Concurrency (Promise.allSettled)');

  // Ensure stock has exactly 1 box
  await pool.query(`
    UPDATE pharmacy_stock
    SET total_quantity = 1, reserved_quantity = 0
    WHERE id = $1;
  `, [ctx.stockId]);

  // Simulate 10 simultaneous patients attempting to reserve the last 1 box
  const CONCURRENT_ATTEMPTS = 10;
  const attempts = Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
    pool.query(`SELECT fn_create_reservation($1::uuid, $2::uuid, $3::uuid, 1, 2::smallint) AS res_id`, [
      ctx.userId,
      ctx.stockId,
      ctx.pharmacyId,
    ])
  );

  const results = await Promise.allSettled(attempts);

  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  if (fulfilled.length === 0 && rejected.length > 0) {
    console.error('   🔍 First rejection error:', rejected[0].reason);
  }

  assert(fulfilled.length === 1, `Exactly 1 concurrent reservation succeeded (got ${fulfilled.length})`);
  assert(rejected.length === CONCURRENT_ATTEMPTS - 1, `Exactly ${CONCURRENT_ATTEMPTS - 1} concurrent reservations rejected (got ${rejected.length})`);

  // Verify stock constraint in DB: reserved_quantity must be 1, total_quantity 1
  const stockCheck = await pool.query(`
    SELECT total_quantity, reserved_quantity
    FROM pharmacy_stock
    WHERE id = $1;
  `, [ctx.stockId]);

  assert(stockCheck.rows[0].reserved_quantity === 1, 'Stock reserved_quantity is exactly 1');
  assert(stockCheck.rows[0].total_quantity === 1, 'Stock total_quantity is exactly 1');

  // Verify expired batch rejection in fn_create_reservation
  const expiredStockRes = await pool.query(`
    INSERT INTO pharmacy_stock (
      pharmacy_id, medicine_id, batch_barcode, production_date, expiry_date,
      total_quantity, reserved_quantity, low_stock_threshold, price_dzd
    )
    VALUES (
      $1, $2, 'BATCH-EXPIRED-TEST-001', CURRENT_DATE - 365, CURRENT_DATE - 10,
      5, 0, 5, 120.00
    )
    RETURNING id;
  `, [ctx.pharmacyId, ctx.medicineId]);
  const expiredStockId = expiredStockRes.rows[0].id;

  try {
    await pool.query(`SELECT fn_create_reservation($1::uuid, $2::uuid, $3::uuid, 1, 2::smallint)`, [
      ctx.userId,
      expiredStockId,
      ctx.pharmacyId,
    ]);
    assert(false, 'Expected fn_create_reservation to reject expired batch');
  } catch (err: any) {
    assert(err.message.includes('expired'), `Expired batch rejected: ${err.message}`);
  } finally {
    await pool.query('DELETE FROM pharmacy_stock WHERE id = $1', [expiredStockId]);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Reservation state-machine transitions
// ---------------------------------------------------------------------------
async function testReservationStateMachine(): Promise<void> {
  console.log('\n🧪 Test 3: Reservation State-Machine Transitions');

  // Reset stock for new reservations
  await pool.query(`
    UPDATE pharmacy_stock
    SET total_quantity = 10, reserved_quantity = 0
    WHERE id = $1;
  `, [ctx.stockId]);

  // Create a fresh reservation in pending_payment
  const createRes = await pool.query(`
    SELECT fn_create_reservation($1::uuid, $2::uuid, $3::uuid, 1, 2::smallint) AS res_id
  `, [ctx.userId, ctx.stockId, ctx.pharmacyId]);
  const resId = createRes.rows[0].res_id;

  // Test Illegal transition: pending_payment -> ready_for_pickup (must skip confirmed_held)
  try {
    await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['ready_for_pickup', resId]);
    assert(false, 'Expected illegal transition pending_payment -> ready_for_pickup to fail');
  } catch (err: any) {
    assert(err.message.includes('Illegal reservation transition'), `Illegal transition blocked: ${err.message}`);
  }

  // Test Legal transition: pending_payment -> confirmed_held
  await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['confirmed_held', resId]);
  const checkHeld = await pool.query('SELECT status FROM reservations WHERE id = $1', [resId]);
  assert(checkHeld.rows[0].status === 'confirmed_held', 'Legal transition: pending_payment -> confirmed_held');

  // Test Legal transition: confirmed_held -> ready_for_pickup
  await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['ready_for_pickup', resId]);
  const checkReady = await pool.query('SELECT status FROM reservations WHERE id = $1', [resId]);
  assert(checkReady.rows[0].status === 'ready_for_pickup', 'Legal transition: confirmed_held -> ready_for_pickup');

  // Test Legal transition: ready_for_pickup -> completed
  await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['completed', resId]);
  const checkCompleted = await pool.query('SELECT status FROM reservations WHERE id = $1', [resId]);
  assert(checkCompleted.rows[0].status === 'completed', 'Legal transition: ready_for_pickup -> completed');

  // Test Terminal state violation: completed -> cancelled
  try {
    await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['cancelled', resId]);
    assert(false, 'Expected illegal transition from terminal completed state to fail');
  } catch (err: any) {
    assert(err.message.includes('Illegal reservation transition'), `Terminal state change blocked: ${err.message}`);
  }

  // Test bug fix 1: pending_payment -> expired (must succeed for fn_expire_due_reservations)
  const res2 = await pool.query(`
    SELECT fn_create_reservation($1::uuid, $2::uuid, $3::uuid, 1, 2::smallint) AS res_id
  `, [ctx.userId, ctx.stockId, ctx.pharmacyId]);
  const resId2 = res2.rows[0].res_id;

  await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['expired', resId2]);
  const checkExpired = await pool.query('SELECT status FROM reservations WHERE id = $1', [resId2]);
  assert(checkExpired.rows[0].status === 'expired', 'Fixed transition: pending_payment -> expired succeeds');
}

// ---------------------------------------------------------------------------
// Test 4: Completed-reservation rating guard, cascade, and rating_avg NULL reset
// ---------------------------------------------------------------------------
async function testRatingGuardAndAverage(): Promise<void> {
  console.log('\n🧪 Test 4: Rating Guard, Cascade, and rating_avg NULL Reset');

  // 1. Create a non-completed reservation (pending_payment)
  const nonCompRes = await pool.query(`
    SELECT fn_create_reservation($1::uuid, $2::uuid, $3::uuid, 1, 2::smallint) AS res_id
  `, [ctx.userId, ctx.stockId, ctx.pharmacyId]);
  const nonCompId = nonCompRes.rows[0].res_id;

  // 2. Attempt rating non-completed reservation (must be blocked by trg_check_rating_completed)
  try {
    await pool.query(`
      INSERT INTO pharmacy_ratings (patient_id, pharmacy_id, reservation_id, rating, comment)
      VALUES ($1, $2, $3, 5, 'Great pharmacy!')
    `, [ctx.userId, ctx.pharmacyId, nonCompId]);
    assert(false, 'Expected rating non-completed reservation to fail');
  } catch (err: any) {
    assert(err.message.includes('must be completed'), `Rating guard blocked uncompleted reservation: ${err.message}`);
  }

  // 3. Complete the reservation
  await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['confirmed_held', nonCompId]);
  await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['ready_for_pickup', nonCompId]);
  await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', ['completed', nonCompId]);

  // 4. Rate the completed reservation (should succeed)
  const ratingRes = await pool.query(`
    INSERT INTO pharmacy_ratings (patient_id, pharmacy_id, reservation_id, rating, comment)
    VALUES ($1, $2, $3, 5, 'Excellent service!')
    RETURNING id;
  `, [ctx.userId, ctx.pharmacyId, nonCompId]);
  assert(ratingRes.rows.length === 1, 'Rating completed reservation succeeded');

  // 5. Verify pharmacy rating_avg updated to 5.00
  const pharmCheck1 = await pool.query('SELECT rating_avg FROM pharmacies WHERE id = $1', [ctx.pharmacyId]);
  assert(parseFloat(pharmCheck1.rows[0].rating_avg) === 5.00, `Pharmacy rating_avg updated to 5.00 (got ${pharmCheck1.rows[0].rating_avg})`);

  // 6. Test scalar subquery fix: Delete the only rating, verify rating_avg resets to NULL
  await pool.query('DELETE FROM pharmacy_ratings WHERE id = $1', [ratingRes.rows[0].id]);
  const pharmCheck2 = await pool.query('SELECT rating_avg FROM pharmacies WHERE id = $1', [ctx.pharmacyId]);
  assert(pharmCheck2.rows[0].rating_avg === null, 'Pharmacy rating_avg reset to NULL after deleting the last rating');

  // 7. Test ON DELETE CASCADE fix on pharmacy_ratings(reservation_id)
  // Re-insert rating for nonCompId
  await pool.query(`
    INSERT INTO pharmacy_ratings (patient_id, pharmacy_id, reservation_id, rating, comment)
    VALUES ($1, $2, $3, 4, 'Very good')
  `, [ctx.userId, ctx.pharmacyId, nonCompId]);

  // Delete the reservation - rating should be deleted automatically via CASCADE
  await pool.query('DELETE FROM reservations WHERE id = $1', [nonCompId]);
  const ratingAfterDelete = await pool.query('SELECT count(*) FROM pharmacy_ratings WHERE reservation_id = $1', [nonCompId]);
  assert(parseInt(ratingAfterDelete.rows[0].count, 10) === 0, 'Deleting reservation cascaded and deleted its pharmacy_rating');
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------
async function runAllTests(): Promise<void> {
  const startTime = Date.now();
  console.log('====================================================');
  console.log('🧪 DWA Schema, Constraints & Concurrency Test Suite');
  console.log('====================================================\n');

  try {
    await setupTestData();
    await testStockStatusBoundaries();
    await testLastBoxRaceCondition();
    await testReservationStateMachine();
    await testRatingGuardAndAverage();

    const elapsed = Date.now() - startTime;
    console.log('\n====================================================');
    console.log(`🎉 ALL TESTS PASSED: ${passedCount} assertions passed (${failedCount} failed)`);
    console.log(`⏱️  Duration: ${elapsed} ms`);
    console.log('====================================================\n');
  } catch (err: any) {
    console.error('\n❌ Test suite failed with error:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanupTestData();
    await pool.end();
  }
}

runAllTests();

/**
 * database/scripts/restore.ts
 * Restores the DWA PostgreSQL database from a backup JSON archive.
 * Truncates tables in reverse dependency order, inserts records in forward
 * foreign-key dependency order, handles PostGIS geographies, and verifies counts.
 *
 * Usage: npm run db:restore [optional_path_to_backup_json]
 */
import { pool } from '../client';
import { BACKUP_TABLES, DatabaseBackupManifest } from './backup';
import * as fs from 'fs';
import * as path from 'path';

export interface RestoreVerificationResult {
  table: string;
  expectedCount: number;
  restoredCount: number;
  matches: boolean;
}

export async function restoreBackup(
  backupFilePath?: string
): Promise<{ success: boolean; results: RestoreVerificationResult[] }> {
  const startTime = Date.now();
  console.log('🔄 Starting DWA database restore...');

  const backupDir = path.resolve(__dirname, '../backups');
  const targetPath =
    backupFilePath ||
    process.argv[2] ||
    path.join(backupDir, 'latest.json');

  if (!fs.existsSync(targetPath)) {
    throw new Error(`❌ Backup file not found at: ${targetPath}`);
  }

  console.log(`📂 Reading backup from: ${targetPath}`);
  const rawData = fs.readFileSync(targetPath, 'utf-8');
  const manifest: DatabaseBackupManifest = JSON.parse(rawData);

  console.log(`📋 Backup Metadata:`);
  console.log(`   Created At:   ${manifest.createdAt}`);
  console.log(`   Total Tables: ${manifest.totalTables}`);
  console.log(`   Total Rows:   ${manifest.totalRows}`);

  const client = await pool.connect();

  try {
    await client.query('BEGIN;');

    // Step 1: Truncate existing tables in reverse dependency order
    console.log('\n🧹 Clearing existing data in reverse dependency order...');
    const reverseTables = [...BACKUP_TABLES].reverse();
    for (const table of reverseTables) {
      await client.query(`DELETE FROM ${table};`);
    }
    console.log('   ✅ All tables cleared.');

    // Step 2: Insert rows in foreign-key dependency order
    console.log('\n📥 Restoring table data in dependency order...');
    for (const table of BACKUP_TABLES) {
      const tableData = manifest.tables[table];
      if (!tableData || tableData.count === 0) {
        console.log(`   ⏭️  Table ${table.padEnd(25)} : 0 rows (skipped)`);
        continue;
      }

      const columns = tableData.columns;
      const rows = tableData.rows;
      const BATCH_SIZE = 100;

      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const valuePlaceholders: string[] = [];
        const paramValues: any[] = [];

        batch.forEach((row, rowIdx) => {
          const rowPlaceholders = columns.map((col, colIdx) => {
            const paramNum = rowIdx * columns.length + colIdx + 1;
            const val = row[col];

            // PostGIS geography conversion from WKT string
            if ((col === 'location' || col === 'search_point') && val) {
              return `ST_GeographyFromText($${paramNum})`;
            }

            return `$${paramNum}`;
          });

          valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);

          for (const col of columns) {
            let val = row[col];
            // Format object/JSON columns if necessary
            if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
              val = JSON.stringify(val);
            }
            paramValues.push(val);
          }
        });

        // Identity override for search_logs if restoring explicit IDs
        const overridingClause =
          table === 'search_logs' ? 'OVERRIDING SYSTEM VALUE' : '';

        const insertSql = `
          INSERT INTO ${table} (${columns.join(', ')})
          ${overridingClause}
          VALUES ${valuePlaceholders.join(', ')}
          ON CONFLICT DO NOTHING;
        `;

        await client.query(insertSql, paramValues);
      }

      // Reset sequences if applicable
      if (table === '_migrations') {
        await client.query(`
          SELECT setval(
            pg_get_serial_sequence('_migrations', 'id'),
            COALESCE((SELECT MAX(id) FROM _migrations), 1)
          );
        `);
      } else if (table === 'search_logs') {
        await client.query(`
          SELECT setval(
            pg_get_serial_sequence('search_logs', 'id'),
            COALESCE((SELECT MAX(id) FROM search_logs), 1)
          );
        `);
      }

      console.log(`   ✅ Restored ${table.padEnd(25)} : ${rows.length.toString().padStart(6)} rows`);
    }

    await client.query('COMMIT;');

    // Step 3: Verification check
    console.log('\n🔍 Running post-restore verification check...');
    const verificationResults: RestoreVerificationResult[] = [];
    let allPassed = true;

    for (const table of BACKUP_TABLES) {
      const expected = manifest.tables[table]?.count || 0;
      const countRes = await client.query(`SELECT count(*)::int AS count FROM ${table};`);
      const restored = countRes.rows[0].count;
      const matches = expected === restored;

      if (!matches) allPassed = false;

      verificationResults.push({
        table,
        expectedCount: expected,
        restoredCount: restored,
        matches,
      });

      const icon = matches ? '✅' : '❌';
      console.log(`   ${icon} ${table.padEnd(25)} : expected ${expected.toString().padStart(5)}, restored ${restored.toString().padStart(5)}`);
    }

    const elapsed = Date.now() - startTime;
    console.log('\n========================================');
    if (allPassed) {
      console.log('🎉 RESTORE VERIFICATION PASSED: All tables match!');
    } else {
      console.warn('⚠️ RESTORE WARNING: Some table row counts mismatch!');
    }
    console.log(`⏱️  Duration: ${elapsed} ms`);
    console.log('========================================\n');

    return {
      success: allPassed,
      results: verificationResults,
    };
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  } finally {
    client.release();
  }
}

// Run standalone if executed directly
if (require.main === module || process.argv[1]?.endsWith('restore.ts')) {
  restoreBackup()
    .then(() => pool.end())
    .catch(err => {
      console.error('❌ Restore failed:', err);
      pool.end();
      process.exit(1);
    });
}

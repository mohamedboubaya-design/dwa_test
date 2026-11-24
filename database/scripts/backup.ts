/**
 * database/scripts/backup.ts
 * Backs up the entire DWA PostgreSQL database into a portable JSON archive.
 * Preserves all schemas, relationships, UUIDs, ENUMs, and PostGIS geometries.
 *
 * Usage: npm run db:backup
 */
import { pool } from '../client';
import * as fs from 'fs';
import * as path from 'path';

// Order matters for clean foreign-key dumps and restores
export const BACKUP_TABLES = [
  '_migrations',
  'users',
  'pharmacist_verifications',
  'pharmacies',
  'pharmacy_on_duty_rotas',
  'medicines',
  'medicine_equivalents',
  'pharmacy_stock',
  'reservations',
  'payments',
  'pharmacy_ratings',
  'prescriptions',
  'prescription_responses',
  'stock_alerts_reminders',
  'search_logs',
];

export interface TableBackupData {
  count: number;
  columns: string[];
  rows: any[];
}

export interface DatabaseBackupManifest {
  version: string;
  database: string;
  createdAt: string;
  totalTables: number;
  totalRows: number;
  tables: Record<string, TableBackupData>;
}

export async function createBackup(customOutputPath?: string): Promise<string> {
  const startTime = Date.now();
  console.log('📦 Starting DWA database backup...');

  const backupDir = path.resolve(__dirname, '../backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `dwa_backup_${timestamp}.json`;
  const outputPath = customOutputPath || path.join(backupDir, filename);
  const latestPath = path.join(backupDir, 'latest.json');

  const manifest: DatabaseBackupManifest = {
    version: '1.0.0',
    database: 'dwa_database',
    createdAt: new Date().toISOString(),
    totalTables: 0,
    totalRows: 0,
    tables: {},
  };

  const client = await pool.connect();

  try {
    for (const table of BACKUP_TABLES) {
      // Check if table exists
      const checkRes = await client.query(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables 
           WHERE table_schema = 'public' AND table_name = $1
         ) AS exists;`,
        [table]
      );

      if (!checkRes.rows[0].exists) {
        console.log(`⚠️  Table ${table} does not exist, skipping...`);
        continue;
      }

      // Handle PostGIS geography columns as WKT for clean serialization
      let selectClause = '*';
      if (table === 'pharmacies') {
        selectClause = `
          id, owner_id, name, wilaya, commune, address, phone,
          CASE WHEN location IS NOT NULL THEN ST_AsText(location) ELSE NULL END AS location,
          opening_hours, pro_plan_until, rating_avg, created_at, updated_at
        `;
      } else if (table === 'search_logs') {
        selectClause = `
          id, user_id, medicine_id, raw_query, wilaya,
          CASE WHEN search_point IS NOT NULL THEN ST_AsText(search_point) ELSE NULL END AS search_point,
          results_count, found_in_stock, searched_at
        `;
      }

      const rowsRes = await client.query(`SELECT ${selectClause} FROM ${table}`);
      const rows = rowsRes.rows;
      const columns = rowsRes.fields.map(f => f.name);

      manifest.tables[table] = {
        count: rows.length,
        columns,
        rows,
      };

      manifest.totalTables += 1;
      manifest.totalRows += rows.length;

      console.log(`   📄 Backed up table ${table.padEnd(25)} : ${rows.length.toString().padStart(6)} rows`);
    }

    const jsonContent = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(outputPath, jsonContent, 'utf-8');
    fs.writeFileSync(latestPath, jsonContent, 'utf-8');

    const elapsed = Date.now() - startTime;
    const stats = fs.statSync(outputPath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

    console.log('\n========================================');
    console.log('✅ Backup completed successfully!');
    console.log(`📁 File:        ${outputPath}`);
    console.log(`📊 Total tables: ${manifest.totalTables}`);
    console.log(`📈 Total rows:   ${manifest.totalRows}`);
    console.log(`💾 File size:    ${sizeMb} MB`);
    console.log(`⏱️  Duration:     ${elapsed} ms`);
    console.log('========================================\n');

    return outputPath;
  } finally {
    client.release();
  }
}

// Run standalone if executed directly
if (require.main === module || process.argv[1]?.endsWith('backup.ts')) {
  createBackup()
    .then(() => pool.end())
    .catch(err => {
      console.error('❌ Backup failed:', err);
      pool.end();
      process.exit(1);
    });
}

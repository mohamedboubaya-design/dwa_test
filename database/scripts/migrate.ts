/**
 * database/scripts/migrate.ts
 * Runs SQL migration files against the Supabase PostgreSQL database.
 * Usage: npm run db:migrate
 */
import { pool } from '../client';
import * as fs from 'fs';
import * as path from 'path';

async function runMigrations(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('⚠️  No migration files found in', migrationsDir);
    return;
  }

  const client = await pool.connect();
  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id        SERIAL PRIMARY KEY,
        filename  TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    for (const file of files) {
      // Check if already applied
      const { rows } = await client.query(
        'SELECT 1 FROM _migrations WHERE filename = $1',
        [file]
      );

      if (rows.length > 0) {
        console.log(`⏭️  Skipping (already applied): ${file}`);
        continue;
      }

      console.log(`🚀 Applying migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      const startTime = Date.now();
      await client.query(sql);
      const elapsed = Date.now() - startTime;

      // Record migration
      await client.query(
        'INSERT INTO _migrations (filename) VALUES ($1)',
        [file]
      );

      console.log(`✅ Applied ${file} in ${elapsed}ms`);
    }

    console.log('\n🎉 All migrations applied successfully!');
  } catch (err: any) {
    console.error('❌ Migration failed:', err.message);
    if (err.detail) console.error('   Detail:', err.detail);
    if (err.hint)   console.error('   Hint:', err.hint);
    if (err.position) console.error('   Position:', err.position);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();

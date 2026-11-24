/**
 * database/client.ts
 * Centralized PostgreSQL client pool for DWA.
 * Exports a single shared pg.Pool singleton configured for Supabase with SSL.
 */
import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from project root .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('⚠️  DATABASE_URL environment variable is not defined.');
}

const poolConfig: PoolConfig = {
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

export const pool = new Pool(poolConfig);

/**
 * Convenience query helper using the shared pool.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export default pool;

/**
 * db/queries/analytics.ts
 * Pharmacist unmet demand analytics queries powered by v_unmet_demand
 * and underlying search_logs. Helps pharmacy owners and health authorities
 * identify medicine shortages, search spikes, and regional demand patterns.
 */
import { query } from '../client';

export interface UnmetDemandItem {
  wilaya: string | null;
  medicineId: string | null;
  commercialName: string | null;
  genericDciName: string | null;
  searchCount: number;
  uniqueUsers: number;
}

export interface UnmetDemandFilterOptions {
  wilaya?: string;
  medicineId?: string;
  minSearches?: number;
  limit?: number;
  offset?: number;
}

export interface WilayaDemandSummary {
  wilaya: string;
  unmetSearchCount: number;
  distinctMedicinesCount: number;
  affectedUsersCount: number;
}

export interface DailyDemandTrend {
  date: string;
  wilaya: string | null;
  unmetSearchCount: number;
  uniqueUsersCount: number;
}

/**
 * Retrieves the 30-day unmet demand analytics from v_unmet_demand.
 * Can be filtered by wilaya, specific medicine, and search thresholds.
 */
export async function getUnmetDemand(
  options: UnmetDemandFilterOptions = {}
): Promise<UnmetDemandItem[]> {
  const {
    wilaya,
    medicineId,
    minSearches = 1,
    limit = 50,
    offset = 0,
  } = options;

  const conditions: string[] = ['search_count >= $1'];
  const params: any[] = [minSearches];
  let paramIdx = 2;

  if (wilaya) {
    conditions.push(`wilaya ILIKE $${paramIdx++}`);
    params.push(wilaya);
  }

  if (medicineId) {
    conditions.push(`medicine_id = $${paramIdx++}`);
    params.push(medicineId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const sql = `
    SELECT
      wilaya,
      medicine_id,
      commercial_name,
      generic_dci_name,
      search_count,
      unique_users
    FROM v_unmet_demand
    ${whereClause}
    ORDER BY search_count DESC, unique_users DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++};
  `;

  params.push(limit, offset);

  const res = await query(sql, params);

  return res.rows.map(r => ({
    wilaya: r.wilaya,
    medicineId: r.medicine_id,
    commercialName: r.commercial_name,
    genericDciName: r.generic_dci_name,
    searchCount: parseInt(r.search_count, 10) || 0,
    uniqueUsers: parseInt(r.unique_users, 10) || 0,
  }));
}

/**
 * Retrieves the top most searched but unavailable medicines nationwide.
 */
export async function getTopUnmetDemandMedicines(
  limit: number = 10
): Promise<UnmetDemandItem[]> {
  const sql = `
    SELECT
      NULL AS wilaya,
      medicine_id,
      commercial_name,
      generic_dci_name,
      SUM(search_count)::bigint AS search_count,
      SUM(unique_users)::bigint AS unique_users
    FROM v_unmet_demand
    GROUP BY medicine_id, commercial_name, generic_dci_name
    ORDER BY search_count DESC
    LIMIT $1;
  `;

  const res = await query(sql, [limit]);

  return res.rows.map(r => ({
    wilaya: null,
    medicineId: r.medicine_id,
    commercialName: r.commercial_name,
    genericDciName: r.generic_dci_name,
    searchCount: parseInt(r.search_count, 10) || 0,
    uniqueUsers: parseInt(r.unique_users, 10) || 0,
  }));
}

/**
 * Retrieves unmet demand filtered for a specific wilaya.
 */
export async function getUnmetDemandByWilaya(
  wilaya: string,
  limit: number = 20
): Promise<UnmetDemandItem[]> {
  return getUnmetDemand({ wilaya, limit });
}

/**
 * Aggregates unmet demand across Algerian wilayas.
 */
export async function getWilayaDemandSummary(): Promise<WilayaDemandSummary[]> {
  const sql = `
    SELECT
      COALESCE(wilaya, 'Unknown') AS wilaya,
      SUM(search_count)::bigint AS unmet_search_count,
      COUNT(DISTINCT medicine_id)::bigint AS distinct_medicines_count,
      SUM(unique_users)::bigint AS affected_users_count
    FROM v_unmet_demand
    GROUP BY wilaya
    ORDER BY unmet_search_count DESC;
  `;

  const res = await query(sql);

  return res.rows.map(r => ({
    wilaya: r.wilaya,
    unmetSearchCount: parseInt(r.unmet_search_count, 10) || 0,
    distinctMedicinesCount: parseInt(r.distinct_medicines_count, 10) || 0,
    affectedUsersCount: parseInt(r.affected_users_count, 10) || 0,
  }));
}

/**
 * Retrieves daily timeline trends of unmet demand over a given interval (e.g., past 30 days).
 */
export async function getUnmetDemandTrends(
  days: number = 30,
  wilaya?: string
): Promise<DailyDemandTrend[]> {
  const params: any[] = [days];
  let wilayaFilter = '';

  if (wilaya) {
    wilayaFilter = 'AND sl.wilaya ILIKE $2';
    params.push(wilaya);
  }

  const sql = `
    SELECT
      date_trunc('day', sl.searched_at)::date::text AS date,
      sl.wilaya,
      COUNT(*)::bigint AS unmet_search_count,
      COUNT(DISTINCT sl.user_id)::bigint AS unique_users_count
    FROM search_logs sl
    WHERE sl.found_in_stock = false
      AND sl.searched_at >= now() - ($1 || ' days')::interval
      ${wilayaFilter}
    GROUP BY date_trunc('day', sl.searched_at)::date, sl.wilaya
    ORDER BY date DESC, unmet_search_count DESC;
  `;

  const res = await query(sql, params);

  return res.rows.map(r => ({
    date: r.date,
    wilaya: r.wilaya,
    unmetSearchCount: parseInt(r.unmet_search_count, 10) || 0,
    uniqueUsersCount: parseInt(r.unique_users_count, 10) || 0,
  }));
}

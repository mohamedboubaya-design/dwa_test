/**
 * database/queries/search.ts
 * Parameterized medicine search module with pg_trgm fuzzy matching,
 * PostGIS spatial proximity (ST_DWithin, ST_Distance), stock filtering,
 * generic equivalents fallback, and search logging into search_logs.
 */
import { pool, query } from '../client';

export interface SearchMedicinesParams {
  query: string;               // Medicine commercial or generic DCI name
  latitude?: number;           // User GPS latitude (-90 to 90)
  longitude?: number;          // User GPS longitude (-180 to 180)
  radiusMeters?: number;       // Radius in meters (default: 50,000 m = 50 km)
  wilaya?: string;             // Filter by wilaya
  commune?: string;            // Filter by commune
  inStockOnly?: boolean;       // Filter out out-of-stock results
  onDutyOnly?: boolean;        // Filter pharmacies currently on-duty
  chifaOnly?: boolean;         // Only reimbursable medicines
  prescriptionOnly?: boolean;  // Filter by prescription requirement
  allowEquivalents?: boolean;  // Fallback to exact_generic equivalents if not found (default: true)
  userId?: string;             // Authenticated patient UUID for search_logs
  limit?: number;              // Limit results (default: 20)
  offset?: number;             // Pagination offset (default: 0)
}

export interface MatchedMedicine {
  id: string;
  commercialName: string;
  genericDciName: string;
  dosageForm: string | null;
  strength: string | null;
  chifaReimbursable: boolean;
  isPrescriptionOnly: boolean;
  similarityScore: number;
}

export interface SearchResultItem {
  medicineId: string;
  commercialName: string;
  genericDciName: string;
  dosageForm: string | null;
  strength: string | null;
  chifaReimbursable: boolean;
  isPrescriptionOnly: boolean;
  isEquivalent: boolean;
  equivalentToMedicineId?: string;
  pharmacyId: string;
  pharmacyName: string;
  wilaya: string;
  commune: string;
  address: string;
  phone: string | null;
  location: { lat: number; lng: number } | null;
  distanceMeters: number | null;
  totalAvailable: number;
  minPriceDzd: number | null;
  maxPriceDzd: number | null;
  nearestExpiry: string | null;
  stockStatus: 'in_stock' | 'low_stock' | 'out_of_stock';
  batchCount: number;
  ratingAvg: number | null;
  isOnDutyNow: boolean;
  isProActive: boolean;
}

export interface SearchMedicinesResponse {
  query: string;
  matchedMedicines: MatchedMedicine[];
  usedEquivalents: boolean;
  results: SearchResultItem[];
  totalCount: number;
  searchLogId?: number | string;
}

/**
 * Searches medicines by commercial brand name or DCI generic name,
 * matching nearest pharmacies with available stock, and falling back
 * to generic equivalents when needed. Logs every search in search_logs.
 */
export async function searchMedicines(
  params: SearchMedicinesParams
): Promise<SearchMedicinesResponse> {
  const {
    query: rawQuery,
    latitude,
    longitude,
    radiusMeters = 50000,
    wilaya,
    commune,
    inStockOnly = false,
    onDutyOnly = false,
    chifaOnly,
    prescriptionOnly,
    allowEquivalents = true,
    userId,
    limit = 20,
    offset = 0,
  } = params;

  const trimmedQuery = rawQuery ? rawQuery.trim() : '';
  if (!trimmedQuery) {
    return {
      query: rawQuery,
      matchedMedicines: [],
      usedEquivalents: false,
      results: [],
      totalCount: 0,
    };
  }

  const hasGeo = typeof latitude === 'number' && typeof longitude === 'number';

  // Step 1: Find matching medicines using pg_trgm similarity and substring ILIKE
  const medSql = `
    SELECT
      id,
      commercial_name,
      generic_dci_name,
      dosage_form,
      strength,
      chifa_reimbursable,
      is_prescription_only,
      GREATEST(
        similarity(commercial_name, $1),
        similarity(generic_dci_name, $1)
      ) AS sim
    FROM medicines
    WHERE commercial_name % $1
       OR generic_dci_name % $1
       OR commercial_name ILIKE ('%' || $1 || '%')
       OR generic_dci_name ILIKE ('%' || $1 || '%')
    ORDER BY sim DESC, commercial_name ASC
    LIMIT 10;
  `;
  const medRes = await query(medSql, [trimmedQuery]);

  const matchedMedicines: MatchedMedicine[] = medRes.rows.map(r => ({
    id: r.id,
    commercialName: r.commercial_name,
    genericDciName: r.generic_dci_name,
    dosageForm: r.dosage_form,
    strength: r.strength,
    chifaReimbursable: r.chifa_reimbursable,
    isPrescriptionOnly: r.is_prescription_only,
    similarityScore: parseFloat(r.sim) || 0,
  }));

  const primaryMedicineIds = matchedMedicines.map(m => m.id);

  // Helper function to query pharmacy availability for a set of medicine IDs
  async function queryAvailability(
    targetMedIds: string[],
    isEquiv: boolean,
    parentMedIdMap?: Map<string, string>
  ): Promise<SearchResultItem[]> {
    if (targetMedIds.length === 0) return [];

    const conditions: string[] = ['a.medicine_id = ANY($1)'];
    const sqlParams: any[] = [targetMedIds];
    let paramIdx = 2;

    if (inStockOnly) {
      conditions.push(`a.stock_status != 'out_of_stock'`);
      conditions.push(`a.total_available > 0`);
    }

    if (chifaOnly !== undefined) {
      conditions.push(`m.chifa_reimbursable = $${paramIdx++}`);
      sqlParams.push(chifaOnly);
    }

    if (prescriptionOnly !== undefined) {
      conditions.push(`m.is_prescription_only = $${paramIdx++}`);
      sqlParams.push(prescriptionOnly);
    }

    if (wilaya) {
      conditions.push(`p.wilaya ILIKE $${paramIdx++}`);
      sqlParams.push(wilaya);
    }

    if (commune) {
      conditions.push(`p.commune ILIKE $${paramIdx++}`);
      sqlParams.push(commune);
    }

    if (onDutyOnly) {
      conditions.push(`p.is_on_duty_now = true`);
    }

    let geoSelect = 'NULL::numeric AS distance_meters,';
    let geoOrder = '';

    if (hasGeo) {
      const lonParam = paramIdx++;
      const latParam = paramIdx++;
      const radiusParam = paramIdx++;
      sqlParams.push(longitude, latitude, radiusMeters);

      conditions.push(
        `ST_DWithin(p.location, ST_SetSRID(ST_MakePoint($${lonParam}, $${latParam}), 4326)::geography, $${radiusParam})`
      );
      geoSelect = `ROUND(ST_Distance(p.location, ST_SetSRID(ST_MakePoint($${lonParam}, $${latParam}), 4326)::geography)::numeric, 1) AS distance_meters,`;
      geoOrder = `distance_meters ASC NULLS LAST,`;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const availSql = `
      SELECT
        a.medicine_id,
        a.commercial_name,
        a.generic_dci_name,
        a.dosage_form,
        a.strength,
        m.chifa_reimbursable,
        m.is_prescription_only,
        a.pharmacy_id,
        p.name AS pharmacy_name,
        p.wilaya,
        p.commune,
        p.address,
        p.phone,
        CASE
          WHEN p.location IS NOT NULL THEN
            json_build_object(
              'lng', ST_X(p.location::geometry),
              'lat', ST_Y(p.location::geometry)
            )
          ELSE NULL
        END AS location_coords,
        ${geoSelect}
        a.total_available,
        a.min_price_dzd,
        a.max_price_dzd,
        a.nearest_expiry,
        a.stock_status,
        a.batch_count,
        p.rating_avg,
        CASE WHEN p.pro_plan_until > now() THEN true ELSE false END AS is_pro_active,
        EXISTS (
          SELECT 1 FROM pharmacy_on_duty_rotas r
          WHERE r.pharmacy_id = p.id AND now() BETWEEN r.starts_at AND r.ends_at
        ) AS is_on_duty_now
      FROM v_pharmacy_medicine_availability a
      JOIN medicines m ON m.id = a.medicine_id
      JOIN pharmacies p ON p.id = a.pharmacy_id
      ${whereClause}
      ORDER BY
        ${geoOrder}
        p.rating_avg DESC NULLS LAST,
        a.total_available DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++};
    `;

    sqlParams.push(limit, offset);

    const availRes = await query(availSql, sqlParams);

    return availRes.rows.map(r => ({
      medicineId: r.medicine_id,
      commercialName: r.commercial_name,
      genericDciName: r.generic_dci_name,
      dosageForm: r.dosage_form,
      strength: r.strength,
      chifaReimbursable: r.chifa_reimbursable,
      isPrescriptionOnly: r.is_prescription_only,
      isEquivalent: isEquiv,
      equivalentToMedicineId: parentMedIdMap?.get(r.medicine_id),
      pharmacyId: r.pharmacy_id,
      pharmacyName: r.pharmacy_name,
      wilaya: r.wilaya,
      commune: r.commune,
      address: r.address,
      phone: r.phone,
      location: r.location_coords,
      distanceMeters: r.distance_meters != null ? parseFloat(r.distance_meters) : null,
      totalAvailable: parseInt(r.total_available, 10) || 0,
      minPriceDzd: r.min_price_dzd != null ? parseFloat(r.min_price_dzd) : null,
      maxPriceDzd: r.max_price_dzd != null ? parseFloat(r.max_price_dzd) : null,
      nearestExpiry: r.nearest_expiry ? String(r.nearest_expiry) : null,
      stockStatus: r.stock_status,
      batchCount: parseInt(r.batch_count, 10) || 0,
      ratingAvg: r.rating_avg != null ? parseFloat(r.rating_avg) : null,
      isOnDutyNow: Boolean(r.is_on_duty_now),
      isProActive: Boolean(r.is_pro_active),
    }));
  }

  // Step 2: Query availability for primary matched medicines
  let results: SearchResultItem[] = [];
  let usedEquivalents = false;

  if (primaryMedicineIds.length > 0) {
    results = await queryAvailability(primaryMedicineIds, false);
  }

  // Step 3: If no in-stock results found and allowEquivalents is enabled, check exact_generic equivalents
  if (
    results.filter(r => r.stockStatus !== 'out_of_stock' && r.totalAvailable > 0).length === 0 &&
    allowEquivalents &&
    primaryMedicineIds.length > 0
  ) {
    const equivSql = `
      SELECT DISTINCT me.medicine_id, me.equivalent_id
      FROM medicine_equivalents me
      WHERE me.medicine_id = ANY($1)
        AND me.equivalence_type = 'exact_generic'
      LIMIT 20;
    `;
    const equivRes = await query(equivSql, [primaryMedicineIds]);

    if (equivRes.rows.length > 0) {
      const equivMap = new Map<string, string>();
      const equivIds: string[] = [];
      for (const row of equivRes.rows) {
        equivIds.push(row.equivalent_id);
        equivMap.set(row.equivalent_id, row.medicine_id);
      }

      const equivResults = await queryAvailability(equivIds, true, equivMap);
      if (equivResults.length > 0) {
        results = equivResults;
        usedEquivalents = true;
      }
    }
  }

  // Step 4: Log the search into search_logs asynchronously (non-blocking for low latency)
  try {
    const primaryMedId = primaryMedicineIds[0] || null;
    const foundInStock = results.some(
      r => r.stockStatus !== 'out_of_stock' && r.totalAvailable > 0
    );

    const logSql = `
      INSERT INTO search_logs (
        user_id,
        medicine_id,
        raw_query,
        wilaya,
        search_point,
        results_count,
        found_in_stock
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        CASE
          WHEN $5::float IS NOT NULL AND $6::float IS NOT NULL
          THEN ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography
          ELSE NULL
        END,
        $7,
        $8
      );
    `;
    query(logSql, [
      userId || null,
      primaryMedId,
      trimmedQuery,
      wilaya || null,
      hasGeo ? longitude : null,
      hasGeo ? latitude : null,
      results.length,
      foundInStock,
    ]).catch((err) => {
      // Non-fatal telemetry logging
    });
  } catch (err: any) {
    // Logging failure should not crash the user's search
  }

  return {
    query: rawQuery,
    matchedMedicines,
    usedEquivalents,
    results,
    totalCount: results.length,
  };
}

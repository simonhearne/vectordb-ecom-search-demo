/**
 * POST /api/facets — live facets scoped to the current filters and, when a query is
 * committed, to products that lexically match it (TEXT_MATCH). Everything here runs over
 * `entities/query`, not vector search, so it is "in catalogue matching your search".
 *
 * Three things come back:
 *  - `total`            — `count(*)` scalar aggregation.
 *  - `priceMin/Max`     — `min(price)`/`max(price)` (cannot share a call with count(*):
 *                         CAPS.aggregationCountWithOthers is false).
 *  - `brands/categories`— per-value counts. GROUP BY does not exist on this cluster's REST v2
 *                         (CAPS.aggregationGroupBy is false), so the proxy fetches the matching
 *                         rows' `store` + `categories` columns (PK-ordered, paged by
 *                         `parent_asin > last`) and counts them itself (src/lib/facetCounts.ts).
 *                         Standard faceting: brand counts ignore the brand filter, category
 *                         counts ignore the category filter. Sets beyond ROW_CAP * MAX_PAGES
 *                         rows are reported as approximate (`exact: false`, `sampled` rows).
 */
import type { FacetBucket, FacetsRequest, FacetsResponse, Filters } from "../../src/lib/types";
import { compileFilter, dateCutoffIso, esc } from "../../src/lib/filter";
import { countFacets, type FacetRow } from "../../src/lib/facetCounts";
import { CAPS, REST_NAMES } from "./rest";

const COLLECTION = "amazon_reviews_v3";
const CACHE_TTL = 86400;
const CACHE_KEY_BASE = "https://cache.vdb-ecom/api/facets";
const TOP_BRANDS = 40;
const TOP_CATEGORIES = 60;
// `limit + offset <= 16384` on this cluster; we page by PK instead of offset so each page
// can be the full window. Two pages = 32,768 rows before counts become approximate.
const ROW_CAP = 16384;
const MAX_PAGES = 2;
const ROW_FIELDS = ["parent_asin", "store", "categories"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Canonical filters for the cache key: fixed key order + sorted brands so two semantically
// equivalent filter objects (different key order, reordered brands) hash to one entry.
// `compileFilter` was never designed to be cache-key-canonical (it renders `brands` in
// array order) — duplicated from functions/api/search.ts's `canonicalFilters`, which the
// same-origin edge-cache pattern here mirrors. Kept in sync manually; do not diverge.
function canonicalFilters(f: Filters = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isNum(f.priceMin)) out.priceMin = f.priceMin;
  if (isNum(f.priceMax)) out.priceMax = f.priceMax;
  if (isNum(f.minRating)) out.minRating = f.minRating;
  if (isNum(f.minReviews)) out.minReviews = f.minReviews;
  if (f.brands?.length) out.brands = [...f.brands].sort();
  if (f.category) out.category = f.category;
  if (f.phrase?.trim()) out.phrase = f.phrase.trim();
  if (isNum(f.listedWithinDays) && f.listedWithinDays > 0 && f.listedWithinDays <= 3650)
    out.listedCutoff = dateCutoffIso(f.listedWithinDays);
  if (f.near?.city && isNum(f.near.km)) out.near = { city: f.near.city.trim().toLowerCase(), km: f.near.km };
  return out;
}

interface Env {
  ZILLIZ_ENDPOINT: string;
  ZILLIZ_TOKEN: string;
}
type Ctx = { request: Request; env: Env; waitUntil?: (p: Promise<unknown>) => void };

async function zilliz(env: Env, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${env.ZILLIZ_ENDPOINT}/v2/vectordb/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZILLIZ_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (json.code !== 0 && json.code !== 200) throw new Error(`Zilliz ${path}: ${json.message ?? JSON.stringify(json)}`);
  return json;
}

// Folds an optional lexical-match constraint into the compiled filter. TEXT_MATCH text is
// escaped with `esc` — it is user-supplied query text landing inside a Milvus string literal.
const withQuery = (filter: string, q: string): string => {
  if (!q) return filter;
  const tm = `TEXT_MATCH(text_snippet, "${esc(q)}")`;
  return filter ? `${filter} and ${tm}` : tm;
};

const andClause = (filter: string, clause: string): string => (filter ? `(${filter}) and ${clause}` : clause);

// Fetch the `store`/`categories` columns of every row matching `filter`, PK-ordered and paged
// by `parent_asin > <last>`. Stops after MAX_PAGES full pages and reports the set as inexact.
async function fetchFacetRows(env: Env, filter: string): Promise<{ rows: FacetRow[]; exact: boolean; pages: number }> {
  const rows: FacetRow[] = [];
  let lastPk = "";
  // Without a native PK order we cannot page safely; a single unordered window is then the
  // best available and is exact only if it did not fill up.
  const pageable = CAPS.orderByQuery;
  for (let page = 0; page < (pageable ? MAX_PAGES : 1); page++) {
    const f = lastPk ? andClause(filter, `parent_asin > "${esc(lastPk)}"`) : filter;
    const out = await zilliz(env, "entities/query", {
      collectionName: COLLECTION,
      filter: f,
      outputFields: ROW_FIELDS,
      ...(pageable ? { [REST_NAMES.orderBy]: ["parent_asin"] } : {}),
      limit: ROW_CAP,
    });
    const data: any[] = out.data ?? [];
    for (const r of data) rows.push({ store: r.store, categories: r.categories });
    if (data.length < ROW_CAP) return { rows, exact: true, pages: page + 1 };
    lastPk = String(data[data.length - 1]?.parent_asin ?? "");
    if (!lastPk) return { rows, exact: false, pages: page + 1 };
  }
  return { rows, exact: false, pages: pageable ? MAX_PAGES : 1 };
}

const pyFilter = (s: string) => (s ? `"""${s}"""` : '""');
function pyAgg(filter: string, fields: string[]): string {
  return [
    `client.query(`,
    `    collection_name="${COLLECTION}",`,
    `    filter=${pyFilter(filter)},`,
    `    output_fields=[${fields.map((f) => `"${f}"`).join(", ")}],`,
    `)`,
  ].join("\n");
}
function pyRows(filter: string, label: string): string {
  return [
    `# ${label}: no GROUP BY over REST v2 here, so the proxy fetches the matching rows'`,
    `# store/categories (PK-ordered, paged by parent_asin > last) and counts them itself.`,
    `client.query(`,
    `    collection_name="${COLLECTION}",`,
    `    filter=${pyFilter(filter)},`,
    `    output_fields=[${ROW_FIELDS.map((f) => `"${f}"`).join(", ")}],`,
    ...(CAPS.orderByQuery ? [`    order_by_fields=["parent_asin"],`] : []),
    `    limit=${ROW_CAP},`,
    `)`,
  ].join("\n");
}

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  if (!env.ZILLIZ_ENDPOINT || !env.ZILLIZ_TOKEN) return json({ error: "Server missing ZILLIZ_ENDPOINT / ZILLIZ_TOKEN." }, 500);
  let body: FacetsRequest;
  try {
    body = (await ctx.request.json()) as FacetsRequest;
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 502);
  }

  const q = (body.q ?? "").trim();
  const filters: Filters = body.filters ?? {};
  const now = new Date();

  // Best-effort cache lookup — key derivation (canonicalFilters/sha256) lives inside this
  // try too, so an error there (or in the Cache API itself) can never escape as an
  // unhandled exception; it just falls through to a live run with no cache.
  let cache: Cache | undefined;
  let key: string | undefined;
  try {
    key = `${CACHE_KEY_BASE}?k=${await sha256(JSON.stringify({ q, filters: canonicalFilters(filters) }))}`;
    cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-cache", "HIT");
      return r;
    }
  } catch {
    cache = undefined;
    key = undefined;
  }

  try {
    const filter = withQuery(compileFilter(filters, now), q);
    // Standard faceting: each dimension's counts are computed with its own filter removed.
    const brandFilter = withQuery(compileFilter({ ...filters, brands: [] }, now), q);
    const categoryFilter = withQuery(compileFilter({ ...filters, category: null }, now), q);
    const sameRows = brandFilter === categoryFilter;

    const t0 = Date.now();
    const [countOut, boundsOut, brandRows, categoryRows] = await Promise.all([
      zilliz(env, "entities/query", { collectionName: COLLECTION, filter, outputFields: ["count(*)"], limit: 1 }),
      zilliz(env, "entities/query", { collectionName: COLLECTION, filter, outputFields: ["min(price)", "max(price)"], limit: 1 }),
      fetchFacetRows(env, brandFilter),
      sameRows ? Promise.resolve(null) : fetchFacetRows(env, categoryFilter),
    ]);
    const zillizMs = Date.now() - t0;

    const c = countOut.data?.[0] ?? {};
    const b = boundsOut.data?.[0] ?? {};
    const brands: FacetBucket[] = countFacets(brandRows.rows, { topBrands: TOP_BRANDS, topCategories: 0 }).brands;
    const catSource = categoryRows ?? brandRows;
    const categories: FacetBucket[] = countFacets(catSource.rows, { topBrands: 0, topCategories: TOP_CATEGORIES }).categories;
    const exact = brandRows.exact && catSource.exact;
    const sampled = Math.max(brandRows.rows.length, catSource.rows.length);

    const payload: FacetsResponse = {
      total: Number(c["count(*)"] ?? 0),
      priceMin: Math.floor(Number(b["min(price)"] ?? 0)),
      priceMax: Math.ceil(Number(b["max(price)"] ?? 0)),
      brands,
      categories,
      exact,
      sampled,
      debug: {
        filter,
        pymilvusQuery: [
          pyAgg(filter, ["count(*)"]),
          pyAgg(filter, ["min(price)", "max(price)"]),
          pyRows(brandFilter, sameRows ? "brand + category counts" : "brand counts"),
          ...(sameRows ? [] : [pyRows(categoryFilter, "category counts")]),
        ].join("\n\n"),
        zillizMs,
      },
    };
    const res = json(payload, 200);
    if (cache && key) {
      try {
        const stored = new Response(res.clone().body, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_TTL}` },
        });
        const p = cache.put(key, stored);
        if (ctx.waitUntil) ctx.waitUntil(p);
        else await p;
      } catch (e: any) {
        console.error("facets cache store failed:", e?.message ?? e);
      }
      res.headers.set("x-cache", "MISS");
    }
    return res;
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 502);
  }
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

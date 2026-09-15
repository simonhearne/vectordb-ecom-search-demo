/**
 * POST /api/facets — live facets scoped to the current filters and, when a query is
 * committed, to products that lexically match it (TEXT_MATCH). Everything here runs over
 * `entities/query`, not vector search, so it is "in catalogue matching your search".
 *
 * Four things come back:
 *  - `total`            — `count(*)` scalar aggregation.
 *  - `priceMin/Max`     — `min(price)`/`max(price)` (cannot share a call with a *global*
 *                         count(*): CAPS.aggregationCountWithOthers is false).
 *  - `brands`           — native GROUP BY: `groupByFields:["store"]` with `count(*)` in
 *                         `outputFields` (CAPS.aggregationGroupBy, v3.0.1). Exact over the
 *                         whole matching set, whatever its size — `store` has more distinct
 *                         values than one 16,384-bucket window holds, so the buckets are
 *                         paged by `store > last` under an ascending order_by.
 *  - `categories`       — still counted in the proxy: `categories` is ARRAY<VARCHAR> and
 *                         group-by rejects ARRAY keys (CAPS.aggregationGroupByArray), so the
 *                         matching rows' `categories` column is fetched (PK-ordered, paged by
 *                         `parent_asin > last`) and tallied by src/lib/facetCounts.ts. Sets
 *                         beyond ROW_CAP * MAX_PAGES rows are approximate (`exact: false`,
 *                         `sampled` rows); brand counts are never approximate.
 *
 * Standard faceting throughout: brand counts ignore the brand filter, category counts
 * ignore the category filter.
 *
 * Not used here: the search-side `searchAggregation` spec. Its bucket `count` tracks
 * `topHits.size` rather than the match set (CAPS.searchAggregationFacetCounts), so it
 * answers "top groups with their best hits", not "how many products per brand".
 */
import type { FacetBucket, FacetsRequest, FacetsResponse, Filters } from "../../src/lib/types";
import { compileFilter, dateCutoffIso, esc } from "../../src/lib/filter";
import { countFacets, topBuckets, type FacetRow } from "../../src/lib/facetCounts";
import { CAPS, facetGroupByParam, facetOrderByParam } from "./rest";

const COLLECTION = "amazon_reviews_v3";
const CACHE_TTL = 86400;
const CACHE_KEY_BASE = "https://cache.vdb-ecom/api/facets";
const TOP_BRANDS = 40;
const TOP_CATEGORIES = 60;
// `limit + offset <= 16384` on this cluster; we page by key instead of offset so each page
// can be the full window. Two pages = 32,768 rows before category counts go approximate.
const ROW_CAP = CAPS.aggregationBucketWindow;
const MAX_PAGES = 2;
const ROW_FIELDS = ["parent_asin", "categories"];
// Brand buckets are cheap (one row per distinct store, not per product), so they get a
// higher page budget than the row fetch — enough for the whole collection several times
// over. `store` fills 1.5 windows unfiltered; the cap is a runaway guard, not a limit.
const MAX_BUCKET_PAGES = 8;

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

/**
 * Walk a windowed `entities/query` result set, paging by `<key> > <last>` under an
 * ascending order_by on that key rather than by offset (offset+limit is capped at one
 * window). Returns `exact: false` if the page budget ran out with a full page in hand.
 *
 * Both facet halves page this way — brands by bucket key `store`, categories by PK — so
 * the key-paging rule lives in one place.
 *
 * `groupBy: true` turns the walk into a GROUP BY over that same `key`. The group key is
 * `key` and nothing else, by construction: an ORDER BY narrower than the group key returns
 * silently partial counts under truncation (CAPS.aggregationPrefixOrderExact), and these
 * queries truncate routinely. There is deliberately no way to pass a wider group key here.
 */
async function pageByKey<T>(
  env: Env,
  opts: { filter: string; key: string; outputFields: string[]; groupBy?: boolean; maxPages: number },
  take: (row: any) => T,
): Promise<{ rows: T[]; exact: boolean; pages: number }> {
  const rows: T[] = [];
  let last = "";
  // Without a native order we cannot page safely; a single unordered window is then the
  // best available and is exact only if it did not fill up. A grouped walk needs the order
  // for correctness too, not just for paging — see the note above.
  const pageable = CAPS.orderByQuery;
  const maxPages = pageable ? opts.maxPages : 1;
  for (let page = 0; page < maxPages; page++) {
    const f = last ? andClause(opts.filter, `${opts.key} > "${esc(last)}"`) : opts.filter;
    const out = await zilliz(env, "entities/query", {
      collectionName: COLLECTION,
      filter: f,
      outputFields: opts.outputFields,
      ...(pageable ? facetOrderByParam(opts.key) : {}),
      ...(opts.groupBy ? facetGroupByParam(opts.key) : {}),
      limit: ROW_CAP,
    });
    const data: any[] = out.data ?? [];
    for (const r of data) rows.push(take(r));
    if (data.length < ROW_CAP) return { rows, exact: true, pages: page + 1 };
    last = String(data[data.length - 1]?.[opts.key] ?? "");
    // An empty final key cannot advance the cursor — stop rather than re-fetch the page.
    if (!last) return { rows, exact: false, pages: page + 1 };
  }
  return { rows, exact: false, pages: maxPages };
}

/**
 * Per-brand counts straight from Milvus: one row per distinct `store` carrying `count(*)`
 * over the whole matching set. Ranking happens here because ORDER BY on an aggregate is
 * not supported yet (CAPS.aggregationOrderByCount) — the server can only order by the
 * bucket key, which is what the paging needs anyway, and (per
 * CAPS.aggregationPrefixOrderExact) what keeps the counts exact under truncation.
 */
async function fetchBrandBuckets(env: Env, filter: string): Promise<{ brands: FacetBucket[]; exact: boolean; buckets: number }> {
  const { rows, exact } = await pageByKey(
    env,
    { filter, key: "store", outputFields: ["store", "count(*)"], groupBy: true, maxPages: MAX_BUCKET_PAGES },
    (r): FacetBucket => ({ value: typeof r.store === "string" ? r.store.trim() : "", count: Number(r["count(*)"] ?? 0) }),
  );
  return { brands: topBuckets(rows, TOP_BRANDS), exact, buckets: rows.length };
}

/** The `categories` half, still fetch-and-count: group-by rejects ARRAY keys. */
const fetchCategoryRows = (env: Env, filter: string) =>
  pageByKey(
    env,
    { filter, key: "parent_asin", outputFields: ROW_FIELDS, maxPages: MAX_PAGES },
    (r): FacetRow => ({ categories: r.categories }),
  );

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
function pyBrandBuckets(filter: string): string {
  return [
    `# brand counts: native GROUP BY. ORDER BY count(*) is not supported yet, so buckets come`,
    `# back ordered by key and the proxy ranks them — and pages by store > last, since one`,
    `# window holds ${ROW_CAP} buckets and the catalogue has ~24k distinct stores.`,
    `# The order_by is not just for paging: a grouped query whose ORDER BY covers only part`,
    `# of the group key returns silently PARTIAL counts once the limit truncates the bucket`,
    `# list (milvus#52067). Ordering by the whole group key keeps every count exact.`,
    `client.query(`,
    `    collection_name="${COLLECTION}",`,
    `    filter=${pyFilter(filter)},`,
    `    output_fields=["store", "count(*)"],`,
    ...(CAPS.aggregationGroupBy ? [`    group_by_fields=["store"],`] : []),
    ...(CAPS.orderByQuery ? [`    order_by_fields=["store"],`] : []),
    `    limit=${ROW_CAP},`,
    `)`,
  ].join("\n");
}
function pyCategoryRows(filter: string): string {
  return [
    `# category counts: \`categories\` is ARRAY<VARCHAR> and group-by rejects ARRAY keys,`,
    `# so the proxy fetches the matching rows' categories (PK-ordered, paged by`,
    `# parent_asin > last) and counts them itself.`,
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

    const t0 = Date.now();
    const [countOut, boundsOut, brandOut, categoryRows] = await Promise.all([
      zilliz(env, "entities/query", { collectionName: COLLECTION, filter, outputFields: ["count(*)"], limit: 1 }),
      zilliz(env, "entities/query", { collectionName: COLLECTION, filter, outputFields: ["min(price)", "max(price)"], limit: 1 }),
      fetchBrandBuckets(env, brandFilter),
      fetchCategoryRows(env, categoryFilter),
    ]);
    const zillizMs = Date.now() - t0;

    const c = countOut.data?.[0] ?? {};
    const b = boundsOut.data?.[0] ?? {};
    const brands = brandOut.brands;
    const categories: FacetBucket[] = countFacets(categoryRows.rows, { topBrands: 0, topCategories: TOP_CATEGORIES }).categories;
    // Only the category half can be truncated now; brand counts are exact by construction.
    const exact = brandOut.exact && categoryRows.exact;
    const sampled = categoryRows.rows.length;

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
          pyBrandBuckets(brandFilter),
          pyCategoryRows(categoryFilter),
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

/**
 * POST /api/search — same-origin proxy. Holds the Zilliz read-only key, embeds the
 * query via Workers AI, runs the Zilliz search/query, returns display-ready results.
 * The browser never sees the DB key and never calls Zilliz directly.
 */
import type {
  Boost,
  Filters,
  Fusion,
  Product,
  SearchRequest,
  SearchResponse,
  SortKey,
} from "../../src/lib/types";
import { POOL_SIZE, DEFAULT_HYBRID_ALPHA } from "../../src/lib/config";
import { compileFilter, dateCutoffIso, esc, extractPhrase } from "../../src/lib/filter";
import type { QueryMode } from "./rest";
import {
  CAPS,
  decayParam,
  groupParam,
  highlighterParam,
  nativeOrderByFields,
  orderByFor,
  orderByParam,
  pyGroup,
  pyHighlighter,
  pyList,
  pyOrderBy,
  pyRanker,
  rrfRerank,
  weightedRerank,
} from "./rest";

const MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const COLLECTION = "amazon_reviews_v3";
const ANNS_FIELD = "text_vec";
// Chosen in STEP 0: the instruction-prefixed `queries` form aligns NL queries with the
// plain-embedded documents and gives clean ranking (parity 6/6, mean cosine ~0.87).
const INSTRUCTION = "Given a shopping query, retrieve relevant product listings";

// Query understanding: an instruct model (JSON mode) extracts numeric filter constraints
// from the query so they don't pollute the embedding. Llama 4 Scout handles ranges and
// multi-constraint queries reliably at ~0.6-1s (the 70B was ~60s; smaller models dropped
// constraints). Confirmed current and non-deprecated as of 2026-06.
const UNDERSTAND_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

const OUTPUT_FIELDS = [
  "parent_asin",
  "title",
  "main_category",
  "store",
  "price",
  "average_rating",
  "rating_number",
  "categories",
  "image_url",
  "text_snippet",
  "first_seen",
  "store_city",
];

// Zilliz serverless caps (from docs): limit <= 1024, limit + offset < 16384.
const MAX_LIMIT = 1024;
const MAX_WINDOW = 16384;

// POOL_SIZE (sort depth) is shared with the client via src/lib/config so the UI can detect
// a truncated pool. When sorting by a scalar we over-fetch that many relevance-ranked
// candidates, sort the whole pool, then slice the page — capped at MAX_LIMIT below.

interface Env {
  AI: { run: (model: string, inputs: Record<string, unknown>) => Promise<any> };
  ZILLIZ_ENDPOINT: string;
  ZILLIZ_TOKEN: string;
}

// Pages Functions provide `waitUntil` on the event context; optional so a missing one
// (some local-dev shims) degrades to awaiting the cache write.
type Ctx = {
  request: Request;
  env: Env;
  waitUntil?: (promise: Promise<unknown>) => void;
};

// Edge cache: the whole pipeline is deterministic for a given input (static collection,
// temperature:0 understanding), so we cache the full response keyed by a hash of the
// normalized request body. 1-hour TTL; entirely best-effort (any Cache API failure falls
// through to a live run).
const CACHE_TTL = 86400; // seconds
// Synthetic key base — POSTs aren't cacheable, so we key on a canonical GET URL.
const CACHE_KEY_BASE = "https://cache.vdb-ecom/api/search";

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

// --- Effective pymilvus query rendering ----------------------------------------------
// The proxy talks Zilliz REST v2, but the diagnostics panel shows the equivalent pymilvus
// (MilvusClient) call so the active search is legible as code. These builders mirror — and
// are driven by — the exact params handed to each REST branch below.

// Python string literal for arbitrary text (data values, comments).
const pyStr = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

// Filter expressions carry their own double-quoted Milvus literals, so render them with
// triple quotes to avoid escaping noise; "" when there is no filter.
const pyFilter = (s: string) => (s ? `"""${s}"""` : '""');

// `client.query` is the browse branch, hence the fixed "browse" mode: it is the only
// call `orderByFields` exists on (probe 2), so it is the only transcript that can carry
// an `order_by_fields=` line.
function pyQuery(filter: string, limit: number, offset: number, sort: SortKey): string {
  return [
    `client.query(`,
    `    collection_name="${COLLECTION}",`,
    `    filter=${pyFilter(filter)},`,
    ...pyOrderBy(sort, "browse"),
    `    limit=${limit},`,
    `    offset=${offset},`,
    `    output_fields=${pyList(OUTPUT_FIELDS)},`,
    `)`,
  ].join("\n");
}

function pySearch(opts: {
  data: string; // Python expression for the data arg, e.g. "[query_vector]"
  dataComment?: string;
  annsField: string;
  filter: string;
  limit: number;
  offset: number;
  sort?: SortKey;
  mode?: QueryMode;
  group?: boolean;
  highlight?: boolean;
  // The FunctionScore rendering of a decay boost — only the single-field paths carry one.
  ranker?: string | null;
}): string {
  return [
    `client.search(`,
    `    collection_name="${COLLECTION}",`,
    `    data=${opts.data},${opts.dataComment ? `  # ${opts.dataComment}` : ""}`,
    `    anns_field="${opts.annsField}",`,
    ...(opts.filter ? [`    filter=${pyFilter(opts.filter)},`] : []),
    ...(opts.ranker ? [`    ranker=${opts.ranker},`] : []),
    ...pyGroup(opts.group ?? false),
    ...pyHighlighter(opts.highlight ?? false),
    ...pyOrderBy(opts.sort ?? "relevance", opts.mode ?? "search"),
    `    limit=${opts.limit},`,
    `    offset=${opts.offset},`,
    `    output_fields=${pyList(OUTPUT_FIELDS)},`,
    `)`,
  ].join("\n");
}

function pyHybrid(opts: {
  reqs: { data: string; annsField: string; filter: string; limit: number }[];
  ranker: string;
  limit: number;
  offset: number;
  sort?: SortKey;
  mode?: QueryMode;
  group?: boolean;
  highlight?: boolean;
}): string {
  const reqLines = opts.reqs.map(
    (r) =>
      `        AnnSearchRequest(data=${r.data}, anns_field="${r.annsField}", param={}, limit=${r.limit}${r.filter ? `, expr=${pyFilter(r.filter)}` : ""}),`,
  );
  return [
    `client.hybrid_search(`,
    `    collection_name="${COLLECTION}",`,
    `    reqs=[`,
    ...reqLines,
    `    ],`,
    `    ranker=${opts.ranker},`,
    ...pyGroup(opts.group ?? false),
    ...pyHighlighter(opts.highlight ?? false),
    ...pyOrderBy(opts.sort ?? "relevance", opts.mode ?? "search"),
    `    limit=${opts.limit},`,
    `    offset=${opts.offset},`,
    `    output_fields=${pyList(OUTPUT_FIELDS)},`,
    `)`,
  ].join("\n");
}

async function zilliz(env: Env, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${env.ZILLIZ_ENDPOINT}/v2/vectordb/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ZILLIZ_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (json.code !== 0 && json.code !== 200) {
    throw new Error(`Zilliz ${path}: ${json.message ?? JSON.stringify(json)}`);
  }
  return json;
}

async function embedQuery(env: Env, q: string): Promise<number[]> {
  const out = await env.AI.run(MODEL, { queries: q, instruction: INSTRUCTION });
  const vec = out?.data?.[0];
  if (!Array.isArray(vec)) {
    throw new Error("Unexpected Workers AI embedding response shape");
  }
  return vec as number[];
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    cleaned_query: {
      type: "string",
      description: "The product description with all price/rating/review phrases removed.",
    },
    price_min: { type: "number", description: "Lower USD price bound, if stated." },
    price_max: { type: "number", description: "Upper USD price bound, if stated." },
    min_rating: { type: "number", description: "Minimum star rating 1-5, if implied." },
    min_reviews: { type: "number", description: "Minimum number of reviews, if stated." },
  },
  required: ["cleaned_query"],
};

const UNDERSTAND_SYSTEM = `You convert a shopping search query for an electronics store into a product description plus optional filters. Output must match the schema.

CRITICAL: a number is a FILTER only when an explicit signal word makes it one. Numbers that are part of a product name or spec (e.g. "iphone 13", "usb 3.0", "4k", "5g", "type-c", "cat6") are NOT filters — leave them in cleaned_query.

Signals:
- price_min / price_max: ONLY when the number is money — it has "$", "dollar(s)", "buck(s)", or a clear price phrase. "under/below/less than/cheaper than/up to" -> price_max. "over/above/more than/at least/from" -> price_min. "$X to $Y" or "between X and Y dollars" -> both. A bare number with NO money signal is NOT a price.
- min_rating (1-5): set ONLY when the word "star", "stars", "rated", or "rating" appears. "N star(s)" -> N. "rated N" / "N+ stars" -> N. "highly rated", "well rated", "top rated" -> 4. If none of those words appear, DO NOT set min_rating — a spec like "5g", "5ghz", "4k" is NOT a rating.
- min_reviews: set ONLY when "review(s)" or "rating(s)" (count) appears. "N reviews", "with N reviews", "N+ reviews", "at least N ratings", "more than N reviews" all -> N.

cleaned_query: the product description with ONLY the matched filter phrases removed; keep everything else (including product numbers and specs) intact and natural. If nothing else remains, repeat the product noun.
Omit any field not clearly signalled. Never guess. Never invent brands or categories.

Examples:
"micro usb cable 5 star" -> {"cleaned_query":"micro usb cable","min_rating":5}
"iphone 13 case under $20" -> {"cleaned_query":"iphone 13 case","price_max":20}
"usb 3.0 hub" -> {"cleaned_query":"usb 3.0 hub"}
"5g phone case" -> {"cleaned_query":"5g phone case"}
"cat6 ethernet cable 50ft" -> {"cleaned_query":"cat6 ethernet cable 50ft"}
"wireless earbuds over $50 with 100 reviews" -> {"cleaned_query":"wireless earbuds","price_min":50,"min_reviews":100}
"tablet stand with 500 reviews" -> {"cleaned_query":"tablet stand","min_reviews":500}
"highly rated 4k monitor between $200 and $400" -> {"cleaned_query":"4k monitor","price_min":200,"price_max":400,"min_rating":4}
"headphones for kids with at least 4 stars under $60" -> {"cleaned_query":"headphones for kids","price_max":60,"min_rating":4}
"cheap hdmi cable" -> {"cleaned_query":"hdmi cable"}`;

// Returns the embedding text with filter phrases stripped, plus the implied filters.
// Scope is intentionally limited to unambiguous numeric constraints.
async function understandQuery(
  env: Env,
  q: string,
): Promise<{ cleanedQuery: string; filters: Filters }> {
  const out = await env.AI.run(UNDERSTAND_MODEL, {
    messages: [
      { role: "system", content: UNDERSTAND_SYSTEM },
      { role: "user", content: q },
    ],
    response_format: { type: "json_schema", json_schema: EXTRACT_SCHEMA },
    max_tokens: 200,
    temperature: 0,
  });
  // In JSON mode the parsed object is at `out.response`; guard for a string too.
  const raw = (out as any)?.response;
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;

  const pos = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

  const filters: Filters = {};
  const pMin = pos(data?.price_min);
  const pMax = pos(data?.price_max);
  if (pMin !== undefined) filters.priceMin = pMin;
  if (pMax !== undefined) filters.priceMax = pMax;
  const rating = pos(data?.min_rating);
  if (rating !== undefined) filters.minRating = Math.min(5, rating);
  const reviews = pos(data?.min_reviews);
  if (reviews !== undefined) filters.minReviews = Math.round(reviews);

  const cleaned =
    typeof data?.cleaned_query === "string" && data.cleaned_query.trim()
      ? data.cleaned_query.trim()
      : q;
  return { cleanedQuery: cleaned, filters };
}

const toNum = (s: string) => Number(s.replace(/,/g, ""));

// Deterministic backstop for explicit "$N / N star / N reviews" patterns — guarantees the
// LLM never drops an obvious filter, and recovers filters even if the LLM call failed.
// Only fills fields the model left unset; never overrides the model.
function backstopFilters(q: string, base: Filters): Filters {
  const f: Filters = { ...base };
  const lc = q.toLowerCase();

  // A bare number followed by star/rating/review is NOT a price ("at least 4 stars",
  // "at least 100 reviews") — the negative lookahead keeps those out of the price bounds.
  // `(?![\d.,])` forbids truncating the number (so "100" can't shrink to "10" to slip past
  // the next assertion); then reject a number immediately followed by a rating/review word.
  const NOT_RATING_OR_REVIEW = String.raw`(?![\d.,])(?!\s*\+?\s*(?:stars?|ratings?|reviews?)\b)`;
  if (f.priceMax == null) {
    const m = lc.match(new RegExp(String.raw`(?:under|below|less than|cheaper than|up to|<=?)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)` + NOT_RATING_OR_REVIEW));
    if (m) f.priceMax = toNum(m[1]);
  }
  if (f.priceMin == null) {
    const m = lc.match(new RegExp(String.raw`(?:over|above|more than|at least|starting at|from|>=?)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)` + NOT_RATING_OR_REVIEW));
    if (m) f.priceMin = toNum(m[1]);
  }
  if (f.minRating == null) {
    const m = lc.match(/(\d(?:\.\d)?)\s*\+?\s*-?\s*stars?\b/) ?? lc.match(/\brated\s*(\d(?:\.\d)?)/);
    if (m) f.minRating = Math.min(5, toNum(m[1]));
  }
  if (f.minReviews == null) {
    const m = lc.match(/(\d[\d,]*)\s*\+?\s*(?:reviews?|ratings?)\b/);
    if (m) f.minReviews = Math.round(toNum(m[1]));
  }
  return f;
}

// Milvus REST v2 serializes ARRAY<VARCHAR> as { Data: { StringData: { data: [...] } } }.
function asStringArray(v: any): string[] | undefined {
  if (Array.isArray(v)) return v;
  const data = v?.Data?.StringData?.data;
  return Array.isArray(data) ? data : undefined;
}

function toProduct(row: Record<string, any>): Product {
  return {
    parent_asin: row.parent_asin,
    title: row.title,
    main_category: row.main_category,
    store: row.store,
    price: typeof row.price === "number" ? row.price : undefined,
    average_rating: row.average_rating,
    rating_number: row.rating_number,
    categories: asStringArray(row.categories),
    image_url: row.image_url,
    text_snippet: row.text_snippet,
    first_seen: typeof row.first_seen === "string" ? row.first_seen : undefined,
    store_city: row.store_city,
    score: typeof row.distance === "number" ? row.distance : undefined,
  };
}

/**
 * Documented no-op: probe 4 found no highlighter on this build, so a row never carries a
 * highlight block and there is no fragment to return (and `Product` has no `highlight`
 * field). Exported as the seam a highlighting build would fill in — parse
 * `row.highlight?.text_snippet` / `row.entity?.highlight?.text_snippet` here and return
 * the first fragment containing `HL_OPEN`.
 */
export function firstFragment(_row: Record<string, any>): string | undefined {
  return undefined;
}

// Sort the retrieved candidate window. Relevance keeps native vector/scan order.
// Unknown prices (<= 0) always sort last on price sorts.
function applySort(results: Product[], sort: SortKey): Product[] {
  const r = [...results];
  switch (sort) {
    case "price_asc":
      return r.sort((a, b) => priceKey(a) - priceKey(b));
    case "price_desc":
      return r.sort((a, b) => priceKeyDesc(b) - priceKeyDesc(a));
    case "rating":
      return r.sort(
        (a, b) =>
          (b.average_rating ?? 0) - (a.average_rating ?? 0) ||
          (b.rating_number ?? 0) - (a.rating_number ?? 0),
      );
    case "reviews":
      return r.sort((a, b) => (b.rating_number ?? 0) - (a.rating_number ?? 0));
    case "newest":
      // first_seen is an RFC3339 string, so lexicographic compare is chronological.
      // Rows without one sort last.
      return r.sort((a, b) => {
        const fa = a.first_seen ?? "";
        const fb = b.first_seen ?? "";
        return fa === fb ? 0 : fa > fb ? -1 : 1;
      });
    case "relevance":
    default:
      return r;
  }
}
const priceKey = (p: Product) =>
  p.price && p.price > 0 ? p.price : Number.POSITIVE_INFINITY;
const priceKeyDesc = (p: Product) =>
  p.price && p.price > 0 ? p.price : Number.NEGATIVE_INFINITY;

// Canonical filters for the cache key: fixed key order + sorted brands so two semantically
// equivalent filter objects (different key order, reordered brands) hash to one entry.
function canonicalFilters(f: Filters = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isNum(f.priceMin)) out.priceMin = f.priceMin;
  if (isNum(f.priceMax)) out.priceMax = f.priceMax;
  if (isNum(f.minRating)) out.minRating = f.minRating;
  if (isNum(f.minReviews)) out.minReviews = f.minReviews;
  if (f.brands?.length) out.brands = [...f.brands].sort();
  if (f.category) out.category = f.category;
  if (f.phrase?.trim()) out.phrase = f.phrase.trim();
  // Key on the day-rounded cutoff, not the raw day count: that is what the compiled filter
  // actually carries, so two requests a minute apart still share one entry.
  if (isNum(f.listedWithinDays) && f.listedWithinDays > 0) out.listedCutoff = dateCutoffIso(f.listedWithinDays);
  if (f.near?.city && isNum(f.near.km)) out.near = { city: f.near.city.trim().toLowerCase(), km: f.near.km };
  return out;
}

// Reduce a request to its determinant fields, applying the same defaults/clamping the
// handler uses, so equivalent requests collide on one cache entry.
function normalizeForKey(body: SearchRequest): Record<string, unknown> {
  const alpha = Math.min(
    1,
    Math.max(0, typeof body.alpha === "number" ? body.alpha : DEFAULT_HYBRID_ALPHA),
  );
  const limit = Math.min(Math.max(1, Math.floor(body.limit ?? 24)), MAX_LIMIT);
  return {
    q: (body.q ?? "").trim(),
    similarTo: (body.similarTo ?? "").trim(),
    sort: body.sort ?? "relevance",
    alpha,
    offset: Math.max(0, Math.floor(body.offset ?? 0)),
    limit,
    understand: body.understand !== false,
    fusion: body.fusion === "rrf" ? "rrf" : "weighted",
    synonyms: body.synonyms !== false,
    groupByBrand: body.groupByBrand === true,
    boost: body.boost ?? null,
    day: new Date().toISOString().slice(0, 10), // boost "newest" origin and date cutoffs roll daily
    filters: canonicalFilters(body.filters),
  };
}

// Build the synthetic GET key: SHA-256 of the normalized body, hex-encoded into the URL.
async function cacheKeyFor(body: SearchRequest): Promise<string> {
  const normalized = JSON.stringify(normalizeForKey(body));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${CACHE_KEY_BASE}?k=${hex}`;
}

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  if (!env.ZILLIZ_ENDPOINT || !env.ZILLIZ_TOKEN) {
    return json({ error: "Server missing ZILLIZ_ENDPOINT / ZILLIZ_TOKEN." }, 500);
  }

  let body: SearchRequest;
  try {
    body = (await ctx.request.json()) as SearchRequest;
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 502);
  }

  // Cache lookup — best-effort. A miss (or any Cache API error, e.g. local wrangler where
  // the Cache API can be a no-op) just falls through to a live pipeline run.
  let cache: Cache | undefined;
  let key: string | undefined;
  try {
    // `caches.default` is a Cloudflare extension; the DOM `CacheStorage` type omits it.
    cache = (caches as unknown as { default: Cache }).default;
    key = await cacheKeyFor(body);
    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("x-cache", "HIT");
      return res;
    }
  } catch (e: any) {
    console.error("cache lookup failed:", e?.message ?? e);
    cache = undefined;
  }

  const res = await runSearch(env, body);

  // Only successful responses are cached; 500/502 are never written.
  if (cache && key && res.status === 200) {
    try {
      const cloned = res.clone();
      const headers = new Headers(cloned.headers);
      headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
      const toStore = new Response(cloned.body, {
        status: cloned.status,
        statusText: cloned.statusText,
        headers,
      });
      const stored = cache.put(key, toStore);
      // Storing must never block (or fail) the response.
      if (ctx.waitUntil) ctx.waitUntil(stored);
      else await stored;
    } catch (e: any) {
      console.error("cache store failed:", e?.message ?? e);
    }
    res.headers.set("x-cache", "MISS");
  }

  return res;
}

// Runs the full search/browse/similar pipeline for a parsed request body. Returns a 200
// payload, or a 502 on any failure (caller decides whether to cache).
async function runSearch(env: Env, body: SearchRequest): Promise<Response> {
  try {
    const now = new Date();
    const rawQ = (body.q ?? "").trim();
    const seedId = (body.similarTo ?? "").trim();
    const sort: SortKey = body.sort ?? "relevance";
    // Which branch runs is decided by the request alone, and the sort strategy depends on
    // it (`orderByFields` exists only on `entities/query`), so resolve it up front.
    const mode: QueryMode = seedId ? "similar" : rawQ ? "search" : "browse";
    // Dense/semantic weight for hybrid search: 0 = pure BM25, 1 = pure dense. Clamp to [0,1].
    const alpha = Math.min(1, Math.max(0, typeof body.alpha === "number" ? body.alpha : DEFAULT_HYBRID_ALPHA));
    // How the two sub-searches are fused when both run: weighted (α-tunable) or RRF.
    const fusion: Fusion = body.fusion === "rrf" ? "rrf" : "weighted";
    // Lexical field: the synonym-expanded analyzer by default ("tablet" also matches iPad),
    // or the plain BM25 field when the UI switches synonyms off.
    const synonyms = body.synonyms !== false;
    const sparseField = synonyms ? "text_syn_sparse" : "text_sparse";
    const groupByBrand = body.groupByBrand === true;
    // `newest` would need a TIMESTAMPTZ decay input, which this build rejects (probe 7), so
    // `decaySpec` returns null for it — treat it as no boost rather than a silent no-op.
    const boost: Boost | null = (["cheaper", "rated", "popular"] as readonly string[]).includes(body.boost ?? "")
      ? (body.boost as Boost)
      : null;

    const offset = Math.max(0, Math.floor(body.offset ?? 0));
    let limit = Math.floor(body.limit ?? 24);
    limit = Math.min(Math.max(1, limit), MAX_LIMIT);
    if (offset + limit > MAX_WINDOW) limit = Math.max(1, MAX_WINDOW - offset);

    // One sort can be pushed down to Milvus: browse + price_asc, via `orderByFields`
    // (probe 2 — query-only, ascending-only, whole-set). That one paginates natively.
    const nativeOrderBy = nativeOrderByFields(sort, mode);
    // Every other scalar sort still can't be paginated at the DB: over-fetch a
    // relevance-ranked pool at offset 0, sort it whole, then slice the page below.
    // Relevance keeps native, unbounded offset/limit pagination. fetchLimit/fetchOffset
    // drive every Zilliz branch.
    const sorted = sort !== "relevance" && !nativeOrderBy;
    const fetchLimit = sorted ? Math.min(POOL_SIZE, MAX_LIMIT) : limit;
    const fetchOffset = sorted ? 0 : offset;

    const t0 = Date.now();

    // Strip filter phrases out of the query before embedding; surface the implied
    // filters back to the UI. Never let understanding failure break the search.
    // A "quoted phrase" becomes an exact-phrase filter — deterministically, before the LLM
    // ever sees the text. The words stay in `unquoted` (they are still good query terms);
    // only the quote marks go.
    const { phrase, rest: unquoted } = extractPhrase(rawQ);
    let cleanedQuery = unquoted;
    let llmFilters: Filters = {};
    let understood = false;
    let understandMs: number | undefined;
    if (rawQ !== "" && body.understand !== false) {
      const tu = Date.now();
      try {
        const r = await understandQuery(env, unquoted);
        cleanedQuery = r.cleanedQuery;
        llmFilters = r.filters;
        understood = true;
      } catch (e: any) {
        // Understanding is best-effort: fall back to the raw query, never fail the search.
        console.error("understandQuery failed:", e?.message ?? e);
      }
      understandMs = Date.now() - tu;
    }

    // Deterministic backstop fills any explicit filter the LLM missed (or all of them
    // if the LLM call failed). The model still owns cleaned_query and fuzzy phrasing.
    const impliedFilters: Filters = rawQ !== "" ? backstopFilters(unquoted, llmFilters) : {};
    if (phrase) impliedFilters.phrase = phrase;
    const applied = understood || Object.keys(impliedFilters).length > 0;

    // UI filters combine with implied filters; the query's intent wins on conflict.
    const effectiveFilters: Filters = { ...(body.filters ?? {}), ...impliedFilters };
    const filter = compileFilter(effectiveFilters, now);

    let rows: Record<string, any>[];
    let embedMs: number | undefined;
    let embedDim: number | undefined;
    let seedMs: number | undefined;
    let annsField: string | undefined;
    let strategy: "dense" | "sparse" | "weighted" | "rrf" | undefined;
    let groupBy: string | undefined;
    let sparseFieldUsed: "text_sparse" | "text_syn_sparse" | undefined;
    let ranker: string | undefined;
    let pymilvusQuery: string | undefined;
    let zStart: number;

    if (seedId) {
      // "More like this": seed similarity from a product's stored vectors — no embedding.
      const ts = Date.now();
      const seedOut = await zilliz(env, "entities/query", {
        collectionName: COLLECTION,
        filter: `parent_asin == "${esc(seedId)}"`,
        limit: 1,
        outputFields: ["text_vec", "image_vec"],
      });
      seedMs = Date.now() - ts;
      const seedRow = seedOut.data?.[0];
      if (!seedRow) throw new Error(`No product found for "${seedId}"`);
      const textVec = seedRow.text_vec;
      const imageVec = seedRow.image_vec;
      embedDim = Array.isArray(textVec) ? textVec.length : undefined;

      // Exclude the seed itself; fold in any manual filters from the rail.
      const exclude = `parent_asin != "${esc(seedId)}"`;
      const subFilter = filter ? `${filter} and ${exclude}` : exclude;
      // Each sub-search must surface enough candidates to fill the requested window.
      const subLimit = Math.min(fetchOffset + fetchLimit, MAX_LIMIT);

      zStart = Date.now();
      if (Array.isArray(imageVec) && imageVec.length) {
        // Blend semantic-text and visual similarity via reciprocal-rank fusion.
        annsField = "text_vec + image_vec (rrf)";
        pymilvusQuery = pyHybrid({
          reqs: [
            { data: "[seed_text_vec]", annsField: "text_vec", filter: subFilter, limit: subLimit },
            { data: "[seed_image_vec]", annsField: "image_vec", filter: subFilter, limit: subLimit },
          ],
          ranker: "RRFRanker(60)",
          limit: fetchLimit,
          offset: fetchOffset,
          sort,
          mode,
        });
        const out = await zilliz(env, "entities/hybrid_search", {
          collectionName: COLLECTION,
          search: [
            { data: [textVec], annsField: "text_vec", filter: subFilter, limit: subLimit },
            { data: [imageVec], annsField: "image_vec", filter: subFilter, limit: subLimit },
          ],
          ...rrfRerank(),
          // {} unless the sort can be pushed down, which on this build only browse can.
          ...orderByParam(sort, mode),
          limit: fetchLimit,
          offset: fetchOffset,
          outputFields: OUTPUT_FIELDS,
        });
        rows = out.data ?? [];
      } else {
        // Seed has no image vector — degrade to text-only similarity.
        annsField = "text_vec";
        pymilvusQuery = pySearch({
          data: "[seed_text_vec]",
          annsField: "text_vec",
          filter: subFilter,
          limit: fetchLimit,
          offset: fetchOffset,
          sort,
          mode,
        });
        const out = await zilliz(env, "entities/search", {
          collectionName: COLLECTION,
          data: [textVec],
          annsField: "text_vec",
          filter: subFilter,
          ...orderByParam(sort, mode),
          limit: fetchLimit,
          offset: fetchOffset,
          outputFields: OUTPUT_FIELDS,
        });
        rows = out.data ?? [];
      }
    } else if (rawQ) {
      // Tunable blend of dense (text_vec) + BM25 lexical (the sparse field). Dispatch on
      // fusion + alpha: weighted α>=1 pure dense, weighted α<=0 pure BM25 (skips the
      // embedding), otherwise a hybrid fused by RRF or by the weighted reranker.
      // Each sub-search must surface enough candidates to fill the requested window.
      const subLimit = Math.min(fetchOffset + fetchLimit, MAX_LIMIT);
      const hybrid = fusion === "rrf" || (alpha > 0 && alpha < 1);
      // A decay boost is sent as a FunctionScore, and on hybrid search that REPLACES the
      // fusion reranker — only one reranker per request (probe 7). So the boost applies on
      // the single-field paths only; hybrid keeps its fusion and the UI greys the boost out.
      const boostActive = !!boost && (!hybrid || CAPS.decayStacksWithFusion);
      // No highlighter exists on this build (probe 4) — both CAPS are false, so this is
      // always false. Kept as the gate a highlighting build would flip.
      const highlight =
        alpha < 1 || fusion === "rrf" ? (hybrid ? CAPS.highlightHybrid : CAPS.highlightSparse) : false;
      // groupingField works on both entities/search and entities/hybrid_search (probe 6).
      const group = groupByBrand;
      const common = {
        // Never `orderByParam` here: `orderByFields` is silently dropped by search and
        // hybrid_search (probe 2), so the pool sort below owns every non-browse sort.
        ...groupParam(group),
        ...highlighterParam(highlight),
        limit: fetchLimit,
        offset: fetchOffset,
        outputFields: OUTPUT_FIELDS,
      };
      // One gate for both the wire request and the transcript, so they cannot disagree.
      const rankerText = pyRanker({ fusion, alpha, boost: boostActive ? boost : null, hybrid }, now);
      // Read the diagnostics back off the builders, so `groupBy` can only claim a grouping
      // the request actually carries. `sparseField` is set per branch — the pure-dense path
      // never touches a sparse field, so it must not advertise one.
      groupBy = Object.keys(groupParam(group)).length ? "store" : undefined;
      ranker = rankerText ?? undefined;

      if (fusion === "weighted" && alpha <= 0) {
        // Pure BM25: Milvus applies the analyzer + BM25 function to the raw query text.
        // No embedding call (latency/cost win) — embedMs/embedDim stay undefined.
        strategy = "sparse";
        annsField = sparseField;
        sparseFieldUsed = sparseField;
        pymilvusQuery = pySearch({
          data: `[${pyStr(cleanedQuery)}]`,
          annsField: sparseField,
          filter,
          limit: fetchLimit,
          offset: fetchOffset,
          group,
          highlight,
          ranker: rankerText,
        });
        zStart = Date.now();
        const out = await zilliz(env, "entities/search", {
          collectionName: COLLECTION,
          data: [cleanedQuery],
          annsField: sparseField,
          ...(filter ? { filter } : {}),
          ...(boostActive ? decayParam(boost, now) : {}),
          ...common,
        });
        rows = out.data ?? [];
      } else if (fusion === "weighted" && alpha >= 1) {
        // Pure dense vector search.
        strategy = "dense";
        annsField = ANNS_FIELD;
        const te = Date.now();
        const vector = await embedQuery(env, cleanedQuery);
        embedMs = Date.now() - te;
        embedDim = vector.length;
        pymilvusQuery = pySearch({
          data: "[query_vector]",
          dataComment: `${embedDim}-d embedding of ${pyStr(cleanedQuery)}`,
          annsField: ANNS_FIELD,
          filter,
          limit: fetchLimit,
          offset: fetchOffset,
          group,
          highlight: false,
          ranker: rankerText,
        });
        zStart = Date.now();
        const out = await zilliz(env, "entities/search", {
          collectionName: COLLECTION,
          data: [vector],
          annsField: ANNS_FIELD,
          ...(filter ? { filter } : {}),
          ...(boostActive ? decayParam(boost, now) : {}),
          ...common,
        });
        rows = out.data ?? [];
      } else {
        // Hybrid: dense + BM25 sub-searches fused by RRF or by the weighted reranker. The
        // dense sub-search MUST be first so weights[0]=alpha applies to it (positional).
        // norm_score min-max normalizes each sub-search to [0,1] so weights are linear.
        strategy = fusion === "rrf" ? "rrf" : "weighted";
        annsField = `text_vec + ${sparseField} (${strategy}${strategy === "weighted" ? ` α=${alpha}` : ""})`;
        sparseFieldUsed = sparseField;
        const te = Date.now();
        const vector = await embedQuery(env, cleanedQuery);
        embedMs = Date.now() - te;
        embedDim = vector.length;
        pymilvusQuery = pyHybrid({
          reqs: [
            { data: "[query_vector]", annsField: "text_vec", filter, limit: subLimit },
            { data: `[${pyStr(cleanedQuery)}]`, annsField: sparseField, filter, limit: subLimit },
          ],
          ranker: rankerText ?? "RRFRanker(60)",
          limit: fetchLimit,
          offset: fetchOffset,
          group,
          highlight,
        });
        zStart = Date.now();
        const out = await zilliz(env, "entities/hybrid_search", {
          collectionName: COLLECTION,
          search: [
            { data: [vector], annsField: "text_vec", ...(filter ? { filter } : {}), limit: subLimit },
            { data: [cleanedQuery], annsField: sparseField, ...(filter ? { filter } : {}), limit: subLimit },
          ],
          // The fusion reranker owns `rerank` here — a decay FunctionScore would replace it
          // (probe 7), which is why `boostActive` is false on this path.
          ...(fusion === "rrf" ? rrfRerank() : weightedRerank(alpha)),
          ...common,
        });
        rows = out.data ?? [];
      }
    } else {
      pymilvusQuery = pyQuery(filter, fetchLimit, fetchOffset, sort);
      zStart = Date.now();
      const out = await zilliz(env, "entities/query", {
        collectionName: COLLECTION,
        filter, // "" is accepted = browse all
        // The one push-down this build supports: sorts the whole filtered set, so
        // fetchLimit/fetchOffset are the real page window (no pool over-fetch).
        ...orderByParam(sort, mode),
        limit: fetchLimit,
        offset: fetchOffset,
        outputFields: OUTPUT_FIELDS,
      });
      rows = out.data ?? [];
    }
    const zillizMs = Date.now() - zStart;

    // Scalar sorts: order the whole over-fetched pool, then slice the requested page.
    // `applySort` relies on Array.prototype.sort being stable (V8/Workers) so equal keys
    // keep relevance order — load-bearing for consistent ordering across pages.
    const pool = rows.map(toProduct);
    let results: Product[];
    let total: number | undefined;
    if (sorted) {
      const ranked = applySort(pool, sort);
      results = ranked.slice(offset, offset + limit);
      total = ranked.length; // candidate-pool count (capped at POOL_SIZE)
    } else {
      results = pool; // native relevance page, already windowed at the DB
    }
    const payload: SearchResponse = {
      results,
      total,
      mode,
      parsed: rawQ
        ? { applied, originalQuery: rawQ, cleanedQuery, filters: impliedFilters }
        : undefined,
      debug: {
        mode,
        filter,
        annsField,
        embedDim,
        understandModel: understood ? UNDERSTAND_MODEL : undefined,
        limit,
        offset,
        pool: sorted ? fetchLimit : undefined,
        orderBy: nativeOrderBy ? orderByFor(sort) : undefined,
        orderBySemantics: nativeOrderBy ? CAPS.orderBySemantics : undefined,
        alpha: mode === "search" ? alpha : undefined,
        strategy,
        groupBy,
        ranker,
        sparseField: mode === "search" ? sparseFieldUsed : undefined,
        pymilvusQuery,
        count: results.length,
        timings: { understandMs, embedMs, seedMs, zillizMs, serverMs: Date.now() - t0 },
      },
    };
    return json(payload, 200);
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 502);
  }
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

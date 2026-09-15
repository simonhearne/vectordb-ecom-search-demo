// Single source of truth for Milvus 3.0 REST v2 parameter names and instance capabilities,
// as verified by `npm run probe:v3` on 2026-09-15 against the `amazon_reviews_v3` collection.
// Change here, nowhere else.
//
// The cluster was upgraded to a v3.0.1-class build between the first probe (2026-09-03) and
// this one, which turned three earlier `false`s true: query-path GROUP BY, search-side
// `orderByFields`, and descending order_by. See milvus-io/milvus#52071 (master) / #52118
// (cherry-pick to 3.0, merged 2026-08-03), released in v3.0.1 on 2026-09-09.
//
// Method note: the REST v2 decoder is strict about types on fields it knows and *silently
// drops* fields it does not. Every name below was confirmed by an observable effect, and
// every `false` below by a wrong-typed value being accepted (i.e. the field is absent from
// the request struct), not merely by a call "succeeding".

import type { Boost, Fusion, SortKey } from "../../src/lib/types";

export const REST_NAMES = {
  /**
   * probe 2 — on `entities/query` AND `entities/search` (not hybrid_search, where the
   * field is absent from the request struct and silently dropped). Value is a plain
   * `string[]`, each item `"field"` or `"field:asc"` / `"field:desc"` — NOT
   * `[{field, order}]`. On query it sorts the whole filtered set; on search only the
   * returned window (see CAPS.orderBy*Semantics).
   */
  orderBy: "orderByFields",
  /**
   * probe 3 — `entities/query` only, a plain `string[]` of scalar field names, used
   * together with aggregate expressions (`count(*)`, `min(price)`, …) in `outputFields`.
   * The response is one row per bucket carrying the key columns and the aggregates.
   */
  groupByFields: "groupByFields" as string | null,
  /**
   * probe 3b — the search-side bucket aggregation on `entities/search`. Named here for
   * completeness only: its bucket `count` tracks `topHits.size` rather than the whole
   * match set (CAPS.searchAggregationFacetCounts), so it is a top-groups retrieval, not a
   * facet counter, and `/api/facets` uses the query-path GROUP BY above instead.
   */
  searchAggregation: "searchAggregation",
  /** probe 4 — no highlighter field exists on the search request at all (see CAPS). */
  highlighterStyle: "camel" as "camel" | "snake",
  /**
   * probe 7 — `functionScore: { functions: [{ name, type: "Rerank", inputFieldNames,
   * params }] }`. `type` must be exactly `"Rerank"` (case-sensitive). `rerank.strategy`
   * = "decay" is rejected; `function_score` (snake) is silently dropped.
   */
  decayStyle: "functionScore" as "rerank" | "functionScore" | "function_score",
  /** probe 11 — every candidate path returns HTTP 404; the route does not exist. */
  runAnalyzerPath: null as string | null,
  /**
   * probe 7 row "params.reranker values accepted" — verbatim
   * `weighted|rrf|decay|model|boost`. The server does not enumerate these, so the probe
   * sends each name on its own: `unsupported reranker <x>` means unknown, any other error
   * means known, with `__bogus__` as the control.
   */
  rerankers: ["weighted", "rrf", "decay", "model", "boost"] as const,
  /**
   * probe 7 row "decay `function` values accepted" — verbatim `gauss|exp|linear`, taken
   * from the server's own error text (`must be one of [gauss, exp, linear]`).
   */
  decayFunctions: ["gauss", "exp", "linear"] as const,
  /** probe 12 — the field on an `indexes/describe` row that names the index type. */
  describeIndexTypeField: "indexType",
};

export const CAPS = {
  orderBySearch: true,        // probe 2: orderByFields sorts entities/search (v3.0.1)
  orderByHybrid: false,       // probe 2: absent from the hybrid_search struct — silently dropped
  orderByQuery: true,         // probe 2: works on entities/query (browse)
  orderByQuerySemantics: "whole-set" as "window" | "whole-set",  // probe 2 INFO (query)
  orderBySearchSemantics: "window" as "window" | "whole-set",    // probe 2 INFO (search)
  orderByDescending: true,    // probe 2: "field:desc" in the field string, on query and search
  orderByTimestamptz: false,  // probe 8: "order_by field 'first_seen' has unsortable type Timestamptz"
  orderByWithFunctionScore: false, // probe 2: "order_by and function rerank cannot be used together"
  aggregation: true,          // probe 3: count(*) / min() / max() / avg() / sum() in outputFields
  aggregationGroupBy: true,   // probe 3: groupByFields on entities/query (v3.0.1)
  aggregationGroupByArray: false, // probe 3: "group by field categories has unsupported data type Array"
  aggregationOrderByCount: false, // probe 3: "ORDER BY on aggregate expression 'count(*)' is not yet supported"
  /**
   * probe 3 — **load-bearing.** A grouped query whose ORDER BY covers only a *prefix* of
   * the group key returns aggregates that are silently PARTIAL once the limit truncates
   * the bucket list: the per-shard cut happens before the proxy merges contributions, so
   * a bucket can be missing another node's rows. Reproduced live — GROUP BY
   * (main_category, store) ORDER BY main_category over "All Electronics" gives the head
   * bucket 7 at limit 5, 10 at limit 50, and the true 13 only when nothing is truncated.
   * An ORDER BY over the FULL group key is exact at every limit, which is why
   * `facetGroupByParam` takes one field and pairs it with its own order_by.
   * Upstream: milvus-io/milvus#52067 item 2.
   */
  aggregationPrefixOrderExact: false,
  aggregationCountWithOthers: false, // probe 3: global count(*) may not be combined with min/max/avg/sum
  aggregationGroupedCountWithOthers: true, // probe 3: ...but a GROUPED count(*) may
  aggregationBucketWindow: 16384, // probe 3: limit+offset cap; page by `key > last` beyond it
  searchAggregation: true,    // probe 3b: searchAggregation buckets on entities/search
  searchAggregationFacetCounts: false, // probe 3b: bucket count tracks topHits.size, not the match set
  searchAggregationHybrid: false, // probe 3b: "searchAggregation is not supported for hybrid search"
  searchAggregationArray: false, // probe 3b: "unsupported data type ARRAY for group by operator"
  highlightSparse: false,     // probe 4: no highlighter field on entities/search
  highlightHybrid: false,     // probe 4: ... nor on entities/hybrid_search
  phraseMatch: true,          // probe 5: PHRASE_MATCH() in filter on dense, sparse and hybrid
  groupSearch: true,          // probe 6: groupingField/groupSize/strictGroupSize
  groupHybrid: true,          // probe 6: ... also on entities/hybrid_search
  decaySearch: true,          // probe 7: functionScore on entities/search
  decayOnHybrid: true,        // probe 7: functionScore also runs on entities/hybrid_search...
  decayStacksWithFusion: false, // probe 7: ...but it REPLACES `rerank`; only one function allowed
  decayTimestamptz: false,    // probe 7: "decay input field first_seen must be numeric, got Timestamptz"
  boostReranker: true,        // probe 7: params {reranker:"boost", weight, filter} re-scores matches
  timestamptzFilter: true,    // probe 8: first_seen > ISO '...'; output is an ISO-8601 string
  geoStDWithin: true,         // probe 9: st_dwithin(store_location, 'POINT (lon lat)', metres)
  rrfHybrid: true,            // probe 10: rerank {strategy:"rrf", params:{k}}
  runAnalyzer: false,         // probe 11: no REST route
  describeIndex: true,        // probe 12: indexes/describe → row.indexType ("IVF_RABITQ")
};

// ---------------------------------------------------------------------------------------
// Request builders. Each turns app-level intent (a SortKey, a Boost, a fusion choice) into
// the REST v2 fragment the proxy spreads into a request body, plus the matching pymilvus
// fragment for the diagnostics transcript. Both come from the same gate, so the transcript
// can never claim a parameter the request did not carry.

export type QueryMode = "search" | "browse" | "similar";
export type OrderBy = { field: string; order: "asc" | "desc" };

// Highlight sentinels. This build exposes no highlighter (probe 4), so nothing emits them
// today; they stay as the agreed marker pair for the day one appears.
export const HL_OPEN = "\u0001";
export const HL_CLOSE = "\u0002";

// Trim float noise (e.g. 1 - 0.7 -> 0.30000000000000004) for readable weights.
export const pyNum = (n: number) => String(Number(n.toFixed(4)));
// Python list of string literals.
export const pyList = (items: string[]) => `[${items.map((s) => `"${s}"`).join(", ")}]`;

/**
 * What a sort means, as a field/direction description. This is the *diagnostics* shape
 * (SearchDebug.orderBy), not the wire shape — most of these can only be honoured by the
 * proxy's own pool sort. `nativeOrderByFields` says what can actually be pushed down.
 */
export function orderByFor(sort: SortKey): OrderBy[] | undefined {
  switch (sort) {
    case "price_asc": return [{ field: "price", order: "asc" }];
    case "price_desc": return [{ field: "price", order: "desc" }];
    case "rating": return [{ field: "average_rating", order: "desc" }, { field: "rating_number", order: "desc" }];
    case "reviews": return [{ field: "rating_number", order: "desc" }];
    case "newest": return [{ field: "first_seen", order: "desc" }];
    default: return undefined;
  }
}

/** One `orderByFields` item: `"price"` for the default ascending, else `"price:desc"`. */
const obItem = (o: OrderBy) => (o.order === "asc" ? o.field : `${o.field}:${o.order}`);

/**
 * The sorts this build can push down to Milvus, as the `string[]` of `"field[:dir]"` items
 * `orderByFields` actually takes. `undefined` means the proxy must sort the pool itself.
 *
 * Three gates, all from probe 2:
 *  - the endpoint must implement the parameter at all (hybrid_search does not, so "similar"
 *    never pushes down);
 *  - it must sort the *whole filtered set*, not just the returned window. On
 *    `entities/search` it is a window sort: it reorders the `offset+limit` rows the request
 *    already asked for, so page 2 would sort a different window and pagination would be
 *    incoherent. That rules search mode out even though the parameter works there — and it
 *    is also refused alongside a boost's `functionScore` (CAPS.orderByWithFunctionScore).
 *  - the fields must be expressible: descending now is, TIMESTAMPTZ `first_seen` is not.
 *
 * What survives is every browse sort except "newest". (`price` carries no `-1` sentinels in
 * `amazon_reviews_v3`, so ascending order needs no unknown-price fix-up.)
 */
export function nativeOrderByFields(sort: SortKey, mode: QueryMode): string[] | undefined {
  const supported = mode === "browse" ? CAPS.orderByQuery : mode === "similar" ? CAPS.orderByHybrid : CAPS.orderBySearch;
  if (!supported) return undefined;
  const semantics = mode === "browse" ? CAPS.orderByQuerySemantics : CAPS.orderBySearchSemantics;
  if (semantics !== "whole-set") return undefined;
  const ob = orderByFor(sort);
  if (!ob) return undefined;
  const pushable = ob.every(
    (o) =>
      (o.order === "asc" || CAPS.orderByDescending) &&
      (o.field !== "first_seen" || CAPS.orderByTimestamptz),
  );
  return pushable ? ob.map(obItem) : undefined;
}

/**
 * `orderByFields` for the facet queries, which are plain `entities/query` calls and so get
 * the whole-set sort unconditionally. Used to page bucket keys by `key > last`.
 */
export const facetOrderByParam = (field: string): Record<string, unknown> =>
  CAPS.orderByQuery ? { [REST_NAMES.orderBy]: [field] } : {};

/**
 * GROUP BY for the facet queries; `{}` when the build has no group-by parameter.
 *
 * Deliberately **one field, not a list**. Per CAPS.aggregationPrefixOrderExact, a group key
 * wider than the ORDER BY silently returns partial counts as soon as the limit truncates the
 * bucket list — and the facet queries always truncate at `store`. Taking a single field, and
 * pairing it with `facetOrderByParam(field)` on the same field, makes that shape
 * unexpressible rather than merely discouraged. Widen this only alongside a fix upstream
 * (milvus-io/milvus#52067) or an ORDER BY that covers every group field.
 */
export const facetGroupByParam = (field: string): Record<string, unknown> =>
  CAPS.aggregationGroupBy && REST_NAMES.groupByFields ? { [REST_NAMES.groupByFields]: [field] } : {};

export const orderByParam = (sort: SortKey, mode: QueryMode): Record<string, unknown> => {
  const fields = nativeOrderByFields(sort, mode);
  return fields ? { [REST_NAMES.orderBy]: fields } : {};
};

// Group-by search: one row per `store` (probe 6 — works on search and hybrid_search).
export const groupParam = (on: boolean): Record<string, unknown> =>
  on && CAPS.groupSearch ? { groupingField: "store", groupSize: 1, strictGroupSize: true } : {};

/**
 * Documented no-op. Probe 4 found no highlighter field on `entities/search` or
 * `entities/hybrid_search` on this build (CAPS.highlightSparse / CAPS.highlightHybrid are
 * both false), so there is nothing to send and callers can spread this unconditionally.
 * If a build gains the highlighter, emit the `REST_NAMES.highlighterStyle` object here.
 */
export const highlighterParam = (_on: boolean): Record<string, unknown> => ({});

/**
 * Decay-reranker parameters per boost. `newest` would need a TIMESTAMPTZ decay input,
 * which probe 7 rejected ("decay input field first_seen must be numeric"), so it is always
 * null here — which is why BOOST_OPTIONS has no "newest" entry.
 */
export function decaySpec(boost: Boost, now: Date): { field: string; params: Record<string, unknown> } | null {
  switch (boost) {
    case "cheaper": return { field: "price", params: { reranker: "decay", function: "gauss", origin: 0, scale: 30, offset: 10, decay: 0.5 } };
    case "rated": return { field: "average_rating", params: { reranker: "decay", function: "gauss", origin: 5, scale: 1, offset: 0.2, decay: 0.5 } };
    case "popular": return { field: "rating_number", params: { reranker: "decay", function: "exp", origin: 500000, scale: 100000, offset: 0, decay: 0.5 } };
    case "newest": {
      if (!CAPS.decayTimestamptz) return null;
      const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
      return { field: "first_seen", params: { reranker: "decay", function: "gauss", origin: day.toISOString().replace(/\.\d{3}Z$/, "Z"), scale: "30d", decay: 0.5 } };
    }
  }
}

/**
 * The verified decay shape (probe 7): `functionScore.functions[]` with `type` exactly
 * `"Rerank"` (case-sensitive). It *replaces* any `rerank` fusion on hybrid search and only
 * one function is accepted — see CAPS.decayStacksWithFusion.
 */
export function decayParam(boost: Boost | null | undefined, now: Date): Record<string, unknown> {
  if (!boost) return {};
  const spec = decaySpec(boost, now);
  if (!spec) return {};
  return {
    [REST_NAMES.decayStyle]: {
      functions: [{ name: boost, type: "Rerank", inputFieldNames: [spec.field], params: spec.params }],
    },
  };
}

export const weightedRerank = (alpha: number) =>
  ({ rerank: { strategy: "weighted", params: { weights: [alpha, 1 - alpha], norm_score: true } } });
export const rrfRerank = () => ({ rerank: { strategy: "rrf", params: { k: 60 } } });

// --- pymilvus rendering fragments ------------------------------------------------------
// Each mirrors the builder above it and renders nothing whenever that builder sends nothing.

export const pyOrderBy = (sort: SortKey, mode: QueryMode): string[] => {
  const fields = nativeOrderByFields(sort, mode);
  return fields ? [`    order_by_fields=${pyList(fields)},`] : [];
};

export const pyGroup = (on: boolean): string[] =>
  Object.keys(groupParam(on)).length
    ? [`    group_by_field="store",`, `    group_size=1,`, `    strict_group_size=True,`]
    : [];

/** No-op twin of `highlighterParam` — nothing is sent, so nothing is rendered. */
export const pyHighlighter = (_on: boolean): string[] => [];

export function pyDecayFunction(boost: Boost, now: Date): string | null {
  const spec = decaySpec(boost, now);
  if (!spec) return null;
  const params = Object.entries(spec.params).map(([k, v]) => `"${k}": ${typeof v === "string" ? `"${v}"` : v}`).join(", ");
  return `Function(name="${boost}", function_type=FunctionType.RERANK, input_field_names=["${spec.field}"], params={${params}})`;
}

/**
 * The `ranker=` argument for the transcript; null when the request carries no reranker at
 * all. A decay boost and a fusion ranker cannot coexist on this build — the FunctionScore
 * replaces the fusion (probe 7) — so that combination is rendered as exactly that.
 */
export function pyRanker(o: { fusion?: Fusion; alpha?: number; boost?: Boost | null; hybrid: boolean }, now: Date): string | null {
  const fusion = o.hybrid
    ? o.fusion === "rrf" ? "RRFRanker(60)" : `WeightedRanker(${pyNum(o.alpha ?? 0.6)}, ${pyNum(1 - (o.alpha ?? 0.6))}, norm_score=True)`
    : null;
  const decay = o.boost ? pyDecayFunction(o.boost, now) : null;
  if (decay && fusion) return `FunctionScore(functions=[${decay}])  # replaces ${fusion} — one reranker per request`;
  if (decay) return `FunctionScore(functions=[${decay}])`;
  return fusion;
}

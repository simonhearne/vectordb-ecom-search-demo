// Single source of truth for Milvus 3.0 REST v2 parameter names and instance capabilities,
// as verified by `npm run probe:v3` on 2026-09-03 against the `amazon_reviews_v3` collection.
// Change here, nowhere else.
//
// Method note: the REST v2 decoder is strict about types on fields it knows and *silently
// drops* fields it does not. Every name below was confirmed by an observable effect, and
// every `false` below by a wrong-typed value being accepted (i.e. the field is absent from
// the request struct), not merely by a call "succeeding".

export const REST_NAMES = {
  /**
   * probe 2 — `entities/query` only. Value is a plain `string[]` of field names
   * (`["price"]`), NOT `[{field, order}]`. Ascending only; no direction field exists.
   * Sorts the whole filtered set, not the returned window.
   */
  orderBy: "orderByFields",
  /**
   * probe 3 — GROUP BY is not exposed by REST v2 on this build: every candidate name
   * (groupByFields / group_by_fields / groupBy / group_by / groupByField / group_by_field)
   * is silently dropped, and `outputFields` rejects a plain column alongside `count(*)`.
   */
  groupByFields: null as string | null,
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
  orderBySearch: false,       // probe 2: orderByFields is silently dropped by entities/search
  orderByHybrid: false,       // probe 2: ... and by entities/hybrid_search
  orderByQuery: true,         // probe 2: works on entities/query (browse)
  orderBySemantics: "whole-set" as "window" | "whole-set", // probe 2 INFO line (on query)
  orderByDescending: false,   // probe 2: ascending only — no direction field in the struct
  orderByTimestamptz: false,  // probe 8: "first_seen has type Timestamptz which is not sortable"
  aggregation: true,          // probe 3: count(*) / min() / max() / avg() / sum() in outputFields
  aggregationGroupBy: false,  // probe 3: no group-by parameter exists
  aggregationOrderByCount: false, // probe 3: needs group-by, so unreachable
  aggregationCountWithOthers: false, // probe 3: count(*) may not be combined with min/max/avg/sum
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

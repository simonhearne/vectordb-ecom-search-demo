// Shared contract between the front-end and the Pages Function proxy.

export type SortKey =
  | "relevance"
  | "price_asc"
  | "price_desc"
  | "rating"
  | "reviews"
  | "newest";

export type Boost = "cheaper" | "rated" | "popular" | "newest";
export type Fusion = "weighted" | "rrf";

export interface Filters {
  priceMin?: number | null;
  priceMax?: number | null;
  minRating?: number | null;
  minReviews?: number | null;
  brands?: string[]; // matches `store`
  category?: string | null;
  phrase?: string | null; // exact phrase → PHRASE_MATCH(text_snippet, phrase, 2)
  listedWithinDays?: number | null; // → first_seen > ISO '<cutoff>'
  near?: { city: string; km: number } | null; // → st_dwithin(store_location, POINT, m)
}

export interface SearchRequest {
  q?: string;
  filters?: Filters;
  sort?: SortKey;
  limit?: number;
  offset?: number;
  understand?: boolean; // run NL query understanding on q (default true when q present)
  similarTo?: string; // parent_asin — "More like this": seed similarity from a product's stored vectors
  alpha?: number; // dense/semantic weight 0..1 for hybrid search (defaults to DEFAULT_HYBRID_ALPHA server-side)
  fusion?: Fusion; // default "weighted"; α only applies to weighted
  synonyms?: boolean; // default true → text_syn_sparse, else text_sparse
  groupByBrand?: boolean; // → groupingField "store", groupSize 1
  boost?: Boost | null; // → decay reranker
}

// Result of natural-language query understanding on the proxy.
export interface ParsedQuery {
  applied: boolean; // whether understanding actually ran (and succeeded)
  originalQuery: string; // q as received
  cleanedQuery: string; // q with filter phrases removed — what gets embedded
  filters: Filters; // implied filters extracted from the query
}

export interface Product {
  parent_asin: string;
  title: string;
  main_category?: string;
  store?: string;
  price?: number; // -1 = unknown (data contains sentinels despite ingest claim)
  average_rating?: number;
  rating_number?: number;
  categories?: string[];
  image_url?: string;
  text_snippet?: string;
  first_seen?: string; // RFC3339
  store_city?: string;
  score?: number; // relevance score; meaning varies by strategy (cosine for dense, BM25 for sparse, fused for weighted)
}

export interface SearchDebug {
  mode: "search" | "browse" | "similar";
  filter: string; // compiled Milvus boolean expression ("" when none)
  annsField?: string; // set for vector search
  embedDim?: number; // length of the query/seed vector (search & similar)
  understandModel?: string; // Workers AI model used for query understanding
  limit: number;
  offset: number;
  pool?: number; // candidate pool over-fetched and sorted (set only on scalar sorts)
  alpha?: number; // resolved dense/semantic weight 0..1 (search mode)
  strategy?: "dense" | "sparse" | "weighted" | "rrf"; // active blend strategy (search mode)
  orderBy?: { field: string; order: "asc" | "desc" }[];
  orderBySemantics?: "window" | "whole-set";
  groupBy?: string;
  ranker?: string; // human-readable ranker: WeightedRanker(...) / RRFRanker(60) / FunctionScore(...)
  sparseField?: "text_sparse" | "text_syn_sparse";
  indexType?: string; // vector index type from indexes/describe
  pymilvusQuery?: string; // the effective pymilvus call equivalent to the REST request issued
  count: number;
  timings: { understandMs?: number; embedMs?: number; seedMs?: number; zillizMs: number; serverMs: number };
}

export interface SearchResponse {
  results: Product[];
  total?: number;
  mode: "search" | "browse" | "similar";
  parsed?: ParsedQuery;
  debug?: SearchDebug;
}

// Client-side diagnostics bundle: what we sent, what came back, round-trip latency.
export interface Diagnostics {
  request: SearchRequest;
  response: SearchResponse;
  clientMs: number;
}

export interface Facets {
  brands: string[];
  categories: string[];
  priceMin: number;
  priceMax: number;
  generatedAt?: string;
  sampleSize?: number;
}

export interface FacetsRequest {
  q?: string;
  filters?: Filters;
}

export interface FacetsResponse {
  total: number; // count(*) under the current filter (+ TEXT_MATCH when a query is committed)
  priceMin: number;
  priceMax: number;
  debug: { filter: string; pymilvusQuery: string; zillizMs: number };
}

export const PRICE_UNKNOWN = -1;
export const hasPrice = (p?: number): p is number =>
  typeof p === "number" && p > 0;

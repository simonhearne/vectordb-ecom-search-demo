// Shared contract between the front-end and the Pages Function proxy.

export type SortKey =
  | "relevance"
  | "price_asc"
  | "price_desc"
  | "rating"
  | "reviews";

export interface Filters {
  priceMin?: number | null;
  priceMax?: number | null;
  minRating?: number | null;
  minReviews?: number | null;
  brands?: string[]; // matches `store`
  category?: string | null;
}

export interface SearchRequest {
  q?: string;
  filters?: Filters;
  sort?: SortKey;
  limit?: number;
  offset?: number;
  understand?: boolean; // run NL query understanding on q (default true when q present)
  similarTo?: string; // parent_asin — "More like this": seed similarity from a product's stored vectors
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
  score?: number; // cosine similarity from vector search (relevance only)
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

export const PRICE_UNKNOWN = -1;
export const hasPrice = (p?: number): p is number =>
  typeof p === "number" && p > 0;

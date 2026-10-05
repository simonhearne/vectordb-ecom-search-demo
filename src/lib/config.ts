import type { Boost, Fusion, SortKey } from "./types";

export const PAGE_SIZE = 24;

// Sort depth: when sorting by a scalar (price/rating/reviews) the proxy over-fetches this
// many relevance-ranked candidates, sorts them whole, and paginates within. Shared so the
// UI can detect a truncated pool (total === POOL_SIZE) and show "N+". Capped at the Zilliz
// serverless per-call limit (1024) on the server.
export const POOL_SIZE = 250;

// Default blend for hybrid (dense + BM25) query search. α = the dense/semantic weight:
// 0 = pure keyword/BM25, 1 = pure dense vector, in-between = weighted blend. Shared with
// the server, which uses it when a request omits `alpha`.
export const DEFAULT_HYBRID_ALPHA = 0.6;

export const REPO_URL = "https://github.com/simonhearne/vectordb-ecom-search-demo";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "relevance", label: "Relevance" },
  { key: "price_asc", label: "Price: low to high" },
  { key: "price_desc", label: "Price: high to low" },
  { key: "rating", label: "Avg. customer rating" },
  { key: "reviews", label: "Most reviewed" },
  { key: "newest", label: "Newest" },
];

export const RATING_OPTIONS = [4, 3, 2, 1];

export const REVIEW_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Any" },
  { value: 10, label: "10+" },
  { value: 100, label: "100+" },
  { value: 1000, label: "1,000+" },
];

export const FUSION_OPTIONS: { key: Fusion; label: string }[] = [
  { key: "weighted", label: "Weighted" },
  { key: "rrf", label: "RRF" },
];

// NB: no "newest" entry here — TIMESTAMPTZ (first_seen) cannot be a decay reranker input.
// The Boost type still carries the "newest" literal for other uses; the UI list omits it.
export const BOOST_OPTIONS: { key: Boost | ""; label: string }[] = [
  { key: "", label: "No boost" },
  { key: "cheaper", label: "Boost cheaper" },
  { key: "rated", label: "Boost better rated" },
  { key: "popular", label: "Boost popular" },
];

export const LISTED_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Any time" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
];

export const NEAR_KM_OPTIONS = [250, 1000, 5000];
export const NEW_BADGE_DAYS = 30;

import type { SortKey } from "./types";

export const PAGE_SIZE = 24;

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "relevance", label: "Relevance" },
  { key: "price_asc", label: "Price: low to high" },
  { key: "price_desc", label: "Price: high to low" },
  { key: "rating", label: "Avg. customer rating" },
  { key: "reviews", label: "Most reviewed" },
];

export const RATING_OPTIONS = [4, 3, 2, 1];

export const REVIEW_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Any" },
  { value: 10, label: "10+" },
  { value: 100, label: "100+" },
  { value: 1000, label: "1,000+" },
];

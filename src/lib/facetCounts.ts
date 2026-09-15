// Pure facet counting over rows returned by `entities/query`. Brand counts now come from a
// native GROUP BY, so what is left here is the `categories` half: group-by rejects ARRAY
// keys, so `/api/facets` fetches the matching rows' `categories` column and counts it here.
// `topBuckets` ranks either source, because ORDER BY count(*) is not supported server-side
// either way. Kept dependency-free so it is unit-testable.
import type { FacetBucket } from "./types";

export interface FacetRow {
  store?: unknown;
  categories?: unknown;
}

// Milvus REST v2 serializes ARRAY<VARCHAR> either as a plain array or as
// { Data: { StringData: { data: [...] } } }; accept both, ignore anything else.
export function rowCategories(row: FacetRow): string[] {
  const v: any = row.categories;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  const data = v?.Data?.StringData?.data;
  return Array.isArray(data) ? data.filter((x: unknown): x is string => typeof x === "string") : [];
}

/**
 * Rank buckets by count, ties broken by value so the order is stable across calls, and
 * keep the top `n`. Buckets with no value (an empty `store`) are dropped: they are a real
 * row in the data but not a brand anyone can filter by.
 */
export function topBuckets(buckets: FacetBucket[], n: number): FacetBucket[] {
  return buckets
    .filter((b) => b.value && b.count > 0)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, n);
}

const topN = (counts: Map<string, number>, n: number): FacetBucket[] =>
  topBuckets([...counts.entries()].map(([value, count]) => ({ value, count })), n);

export function countFacets(
  rows: FacetRow[],
  opts: { topBrands: number; topCategories: number },
): { brands: FacetBucket[]; categories: FacetBucket[] } {
  const brands = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const row of rows) {
    const store = typeof row.store === "string" ? row.store.trim() : "";
    if (store) brands.set(store, (brands.get(store) ?? 0) + 1);
    // A product counts once per category even if the array repeats a value.
    for (const c of new Set(rowCategories(row))) {
      if (c) categories.set(c, (categories.get(c) ?? 0) + 1);
    }
  }
  return { brands: topN(brands, opts.topBrands), categories: topN(categories, opts.topCategories) };
}

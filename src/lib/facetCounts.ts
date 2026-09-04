// Pure facet counting over rows returned by `entities/query` (`store` + `categories`).
// This cluster's REST v2 has no GROUP BY, so `/api/facets` fetches the matching rows'
// scalar columns and counts them here. Kept dependency-free so it is unit-testable.
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

function topN(counts: Map<string, number>, n: number): FacetBucket[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, n);
}

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

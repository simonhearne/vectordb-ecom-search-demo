import { describe, expect, it } from "vitest";
import { countFacets, rowCategories } from "./facetCounts";

describe("rowCategories", () => {
  it("accepts a plain string array", () => {
    expect(rowCategories({ categories: ["A", "B"] })).toEqual(["A", "B"]);
  });
  it("accepts the REST v2 ARRAY<VARCHAR> envelope", () => {
    expect(rowCategories({ categories: { Data: { StringData: { data: ["A"] } } } })).toEqual(["A"]);
  });
  it("returns [] for missing or malformed values", () => {
    expect(rowCategories({})).toEqual([]);
    expect(rowCategories({ categories: 42 })).toEqual([]);
  });
});

describe("countFacets", () => {
  const rows = [
    { store: "Sony", categories: ["Electronics", "Headphones"] },
    { store: "Sony", categories: ["Electronics", "Headphones", "Wired"] },
    { store: "Koss", categories: ["Electronics", "Headphones"] },
    { store: "", categories: [] },
    { store: "Bose", categories: { Data: { StringData: { data: ["Electronics", "Speakers"] } } } },
  ];

  it("counts brands and categories, most frequent first, ties by name", () => {
    const out = countFacets(rows, { topBrands: 10, topCategories: 10 });
    expect(out.brands).toEqual([
      { value: "Sony", count: 2 },
      { value: "Bose", count: 1 },
      { value: "Koss", count: 1 },
    ]);
    expect(out.categories).toEqual([
      { value: "Electronics", count: 4 },
      { value: "Headphones", count: 3 },
      { value: "Speakers", count: 1 },
      { value: "Wired", count: 1 },
    ]);
  });

  it("skips empty brand names and honours the top-N caps", () => {
    const out = countFacets(rows, { topBrands: 1, topCategories: 2 });
    expect(out.brands).toEqual([{ value: "Sony", count: 2 }]);
    expect(out.categories).toEqual([
      { value: "Electronics", count: 4 },
      { value: "Headphones", count: 3 },
    ]);
  });

  it("counts a category once per row even if it repeats inside the row", () => {
    const out = countFacets([{ store: "X", categories: ["A", "A"] }], { topBrands: 5, topCategories: 5 });
    expect(out.categories).toEqual([{ value: "A", count: 1 }]);
  });

  it("returns empty lists for no rows", () => {
    expect(countFacets([], { topBrands: 5, topCategories: 5 })).toEqual({ brands: [], categories: [] });
  });
});

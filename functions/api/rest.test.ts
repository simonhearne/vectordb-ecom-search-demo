// Pins every request-builder gate in rest.ts (REST_NAMES/CAPS) to its verified behaviour,
// so a future edit that quietly widens a capability (e.g. claims a param the probe never
// confirmed) fails a test instead of silently reaching the wire.
import { describe, it, expect } from "vitest";
import {
  decayParam,
  facetGroupByParam,
  facetOrderByParam,
  groupParam,
  highlighterParam,
  nativeOrderByFields,
  orderByParam,
  pyOrderBy,
  pyRanker,
} from "./rest";

const NOW = new Date("2026-09-03T15:42:00Z");

describe("nativeOrderByFields", () => {
  it("pushes price_asc down on browse (entities/query, a whole-set sort)", () => {
    expect(nativeOrderByFields("price_asc", "browse")).toEqual(["price"]);
  });
  it("pushes price_desc down on browse (v3.0.1 carries the direction in the field string)", () => {
    expect(nativeOrderByFields("price_desc", "browse")).toEqual(["price:desc"]);
  });
  it("pushes a multi-field descending sort down on browse", () => {
    expect(nativeOrderByFields("rating", "browse")).toEqual(["average_rating:desc", "rating_number:desc"]);
  });
  it("cannot push price_asc down on search — entities/search sorts only the window it was given", () => {
    expect(nativeOrderByFields("price_asc", "search")).toBeUndefined();
  });
  it("cannot push price_asc down on similar (orderByFields dropped by hybrid_search)", () => {
    expect(nativeOrderByFields("price_asc", "similar")).toBeUndefined();
  });
  it("cannot push newest down on browse (TIMESTAMPTZ is not sortable)", () => {
    expect(nativeOrderByFields("newest", "browse")).toBeUndefined();
  });
});

describe("orderByParam", () => {
  it("carries orderByFields when pushable", () => {
    expect(orderByParam("price_asc", "browse")).toEqual({ orderByFields: ["price"] });
  });
  it("is empty when not pushable", () => {
    expect(orderByParam("price_asc", "search")).toEqual({});
  });
});

describe("facet aggregation params", () => {
  it("carries the group-by fragment /api/facets counts brands with", () => {
    expect(facetGroupByParam("store")).toEqual({ groupByFields: ["store"] });
  });
  it("takes one field, so a group key wider than the order key is unexpressible", () => {
    // A prefix ORDER BY yields silently partial counts once the limit truncates the
    // bucket list (CAPS.aggregationPrefixOrderExact / milvus#52067). The builder pairs
    // with facetOrderByParam on the same single field, so the unsafe shape cannot be built.
    expect(Object.values(facetGroupByParam("store"))[0]).toHaveLength(1);
  });
  it("orders bucket keys ascending, so the proxy can page by `key > last`", () => {
    expect(facetOrderByParam("store")).toEqual({ orderByFields: ["store"] });
  });
});

describe("groupParam", () => {
  it("carries the store grouping fragment when on", () => {
    expect(groupParam(true)).toEqual({ groupingField: "store", groupSize: 1, strictGroupSize: true });
  });
  it("is empty when off", () => {
    expect(groupParam(false)).toEqual({});
  });
});

describe("decayParam", () => {
  it("is empty for no boost", () => {
    expect(decayParam(null, NOW)).toEqual({});
  });
  it("is empty for newest (TIMESTAMPTZ decay input rejected)", () => {
    expect(decayParam("newest", NOW)).toEqual({});
  });
  it("carries the verified functionScore/Rerank shape for cheaper", () => {
    const p = decayParam("cheaper", NOW) as any;
    expect(p.functionScore.functions[0].type).toBe("Rerank");
    expect(p.functionScore.functions[0].inputFieldNames).toEqual(["price"]);
    expect(p.functionScore.functions[0].params.reranker).toBe("decay");
  });
});

describe("highlighterParam", () => {
  it("is always empty — no highlighter field exists on this build", () => {
    expect(highlighterParam(true)).toEqual({});
  });
});

describe("pyRanker", () => {
  it("renders a weighted ranker for hybrid weighted fusion", () => {
    expect(pyRanker({ fusion: "weighted", alpha: 0.6, boost: null, hybrid: true }, NOW)).toContain(
      "WeightedRanker(0.6, 0.4",
    );
  });
  it("renders RRFRanker(60) for hybrid rrf fusion", () => {
    expect(pyRanker({ fusion: "rrf", alpha: 0.6, boost: null, hybrid: true }, NOW)).toBe("RRFRanker(60)");
  });
  it("renders a FunctionScore for a single-field boost", () => {
    expect(
      pyRanker({ fusion: "weighted", alpha: 1, boost: "cheaper", hybrid: false }, NOW),
    ).toMatch(/^FunctionScore\(/);
  });
  it("is null when neither a fusion ranker nor a boost applies", () => {
    expect(pyRanker({ fusion: "weighted", alpha: 1, boost: null, hybrid: false }, NOW)).toBeNull();
  });
});

describe("pyOrderBy", () => {
  it("renders an order_by_fields line on browse", () => {
    const lines = pyOrderBy("price_asc", "browse");
    expect(lines.join("\n")).toContain('order_by_fields=["price"]');
  });
  it("renders nothing on search", () => {
    expect(pyOrderBy("price_asc", "search")).toEqual([]);
  });
});

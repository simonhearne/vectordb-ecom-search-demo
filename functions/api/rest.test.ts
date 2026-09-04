// Pins every request-builder gate in rest.ts (REST_NAMES/CAPS) to its verified behaviour,
// so a future edit that quietly widens a capability (e.g. claims a param the probe never
// confirmed) fails a test instead of silently reaching the wire.
import { describe, it, expect } from "vitest";
import {
  decayParam,
  groupParam,
  highlighterParam,
  nativeOrderByFields,
  orderByParam,
  pyOrderBy,
  pyRanker,
} from "./rest";

const NOW = new Date("2026-09-03T15:42:00Z");

describe("nativeOrderByFields", () => {
  it("pushes price_asc down on browse (entities/query — the only orderByFields route)", () => {
    expect(nativeOrderByFields("price_asc", "browse")).toEqual(["price"]);
  });
  it("cannot push price_asc down on search (orderByFields dropped by entities/search)", () => {
    expect(nativeOrderByFields("price_asc", "search")).toBeUndefined();
  });
  it("cannot push newest down on browse (TIMESTAMPTZ is not sortable)", () => {
    expect(nativeOrderByFields("newest", "browse")).toBeUndefined();
  });
  it("cannot push price_desc down on browse (ascending only)", () => {
    expect(nativeOrderByFields("price_desc", "browse")).toBeUndefined();
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

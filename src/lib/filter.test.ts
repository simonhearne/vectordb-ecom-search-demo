import { describe, expect, it } from "vitest";
import { compileFilter, dateCutoffIso, esc, extractPhrase } from "./filter";

const NOW = new Date("2026-09-03T15:42:00Z");

describe("compileFilter", () => {
  it("returns empty for no filters", () => {
    expect(compileFilter({}, NOW)).toBe("");
  });
  it("compiles numeric + brand + category clauses (unchanged 2.x behaviour)", () => {
    expect(compileFilter({ priceMax: 20, minRating: 4, brands: ['A"B'], category: "Cables" }, NOW)).toBe(
      'price > 0 and price <= 20 and average_rating >= 4 and store in ["A\\"B"] and array_contains(categories, "Cables")',
    );
  });
  it("compiles an exact phrase with slop 2", () => {
    expect(compileFilter({ phrase: "noise cancelling" }, NOW)).toBe('PHRASE_MATCH(text_snippet, "noise cancelling", 2)');
  });
  it("compiles listedWithinDays to a day-rounded ISO literal", () => {
    expect(compileFilter({ listedWithinDays: 30 }, NOW)).toBe("first_seen > ISO '2026-08-04T00:00:00Z'");
  });
  it("compiles near to st_dwithin in metres with lon-lat order", () => {
    expect(compileFilter({ near: { city: "London", km: 250 } }, NOW)).toBe(
      "st_dwithin(store_location, 'POINT (-0.1276 51.5072)', 250000)",
    );
  });
  it("ignores an unknown city", () => {
    expect(compileFilter({ near: { city: "Atlantis", km: 250 } }, NOW)).toBe("");
  });
});

describe("dateCutoffIso", () => {
  it("rounds down to UTC midnight", () => {
    expect(dateCutoffIso(90, NOW)).toBe("2026-06-05T00:00:00Z");
  });
});

describe("extractPhrase", () => {
  it("returns null when nothing is quoted", () => {
    expect(extractPhrase("usb c hub")).toEqual({ phrase: null, rest: "usb c hub" });
  });
  it("pulls the first double-quoted phrase and keeps its words in rest", () => {
    expect(extractPhrase('"noise cancelling" headphones under $50')).toEqual({
      phrase: "noise cancelling",
      rest: "noise cancelling headphones under $50",
    });
  });
  it("accepts curly quotes", () => {
    expect(extractPhrase("“usb c” hub").phrase).toBe("usb c");
  });
  it("ignores an unclosed quote", () => {
    expect(extractPhrase('"lonely quote hub')).toEqual({ phrase: null, rest: '"lonely quote hub' });
  });
});

describe("esc", () => {
  it("escapes backslashes and double quotes", () => {
    expect(esc('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

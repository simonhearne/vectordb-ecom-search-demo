import { describe, expect, it } from "vitest";
import { daysSince } from "./highlight";

describe("daysSince", () => {
  it("counts whole days", () => {
    expect(daysSince("2026-08-24T12:00:00Z", new Date("2026-09-03T00:00:00Z"))).toBe(9);
  });
});

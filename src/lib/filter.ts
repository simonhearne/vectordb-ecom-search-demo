// Pure filter compilation shared by the search and facets Functions (and unit-tested).
import type { Filters } from "./types";
import { findCity } from "./cities";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Escape a string for safe interpolation inside a double-quoted Milvus literal.
export const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// `now - days`, floored to UTC midnight, as an RFC3339 literal. Day-rounding keeps the
// compiled filter (and therefore the edge-cache key) stable for a whole day. A
// non-finite or negative `days` is treated as 0 (i.e. "now", floored to midnight) rather
// than propagating NaN/Infinity into the ISO literal — callers are expected to gate on
// `days > 0` before calling this, but the function stays safe on its own regardless.
export function dateCutoffIso(days: number, now: Date = new Date()): string {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 0;
  const d = new Date(now.getTime() - safeDays * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function compileFilter(f: Filters = {}, now: Date = new Date()): string {
  const clauses: string[] = [];
  if (isNum(f.priceMin) || isNum(f.priceMax)) clauses.push(`price > 0`);
  if (isNum(f.priceMin)) clauses.push(`price >= ${f.priceMin}`);
  if (isNum(f.priceMax)) clauses.push(`price <= ${f.priceMax}`);
  if (isNum(f.minRating)) clauses.push(`average_rating >= ${f.minRating}`);
  if (isNum(f.minReviews)) clauses.push(`rating_number >= ${f.minReviews}`);
  if (f.brands?.length) {
    const list = f.brands.map((b) => `"${esc(b)}"`).join(", ");
    clauses.push(`store in [${list}]`);
  }
  if (f.category) clauses.push(`array_contains(categories, "${esc(f.category)}")`);
  if (f.phrase?.trim()) clauses.push(`PHRASE_MATCH(text_snippet, "${esc(f.phrase.trim())}", 2)`);
  if (isNum(f.listedWithinDays) && f.listedWithinDays > 0 && f.listedWithinDays <= 3650) {
    clauses.push(`first_seen > ISO '${dateCutoffIso(f.listedWithinDays, now)}'`);
  }
  if (f.near && isNum(f.near.km) && f.near.km > 0) {
    const city = findCity(f.near.city);
    if (city) {
      clauses.push(`st_dwithin(store_location, 'POINT (${city.lon} ${city.lat})', ${Math.round(f.near.km * 1000)})`);
    }
  }
  return clauses.join(" and ");
}

// Deterministic exact-phrase syntax: the first "double-quoted" (or “curly-quoted”) run
// becomes Filters.phrase. The phrase words stay in `rest` — they are still relevant
// terms for the embedding and BM25 — only the quote marks are removed.
export function extractPhrase(q: string): { phrase: string | null; rest: string } {
  const m = q.match(/["“”]([^"“”]+)["“”]/);
  if (!m || !m[1].trim()) return { phrase: null, rest: q };
  const phrase = m[1].trim().replace(/\s+/g, " ");
  // Replacer function, not a string: a literal replacement string treats `$`-patterns
  // (`$&`, `$1`, `$$`, ...) as substitution tokens, which would corrupt a phrase like
  // `"cheap $& deal"`. A function replacer's return value is used verbatim.
  const rest = q.replace(m[0], () => phrase).replace(/\s+/g, " ").trim();
  return { phrase, rest };
}

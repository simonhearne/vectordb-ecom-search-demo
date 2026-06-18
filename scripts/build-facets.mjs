/**
 * Build-time facet artifact. Samples the collection and computes top-N brands, the
 * category list, and price bounds, then writes public/facets.json. Approximate
 * (sample-based) — re-run when the collection changes:  npm run build:facets
 *
 * Reads ZILLIZ_ENDPOINT / ZILLIZ_TOKEN from the environment, falling back to .dev.vars.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const COLLECTION = "amazon_reviews";
const SAMPLE_SIZE = 10000; // rows to sample (paged; serverless window limit is 16384)
const PAGE = 1000;
const TOP_BRANDS = 40;
const TOP_CATEGORIES = 60;
const PRICE_MAX_PERCENTILE = 0.98; // clamp outliers so the slider stays usable

function loadEnv() {
  let endpoint = process.env.ZILLIZ_ENDPOINT;
  let token = process.env.ZILLIZ_TOKEN;
  const devVars = join(ROOT, ".dev.vars");
  if ((!endpoint || !token) && existsSync(devVars)) {
    for (const line of readFileSync(devVars, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      const val = v.replace(/^["']|["']$/g, "");
      if (k === "ZILLIZ_ENDPOINT" && !endpoint) endpoint = val;
      if (k === "ZILLIZ_TOKEN" && !token) token = val;
    }
  }
  if (!endpoint || !token) {
    console.error("Missing ZILLIZ_ENDPOINT / ZILLIZ_TOKEN (env or .dev.vars).");
    process.exit(1);
  }
  return { endpoint, token };
}

async function query({ endpoint, token }, offset) {
  const res = await fetch(`${endpoint}/v2/vectordb/entities/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      collectionName: COLLECTION,
      filter: "",
      outputFields: ["store", "categories", "price"],
      limit: PAGE,
      offset,
    }),
  });
  const json = await res.json();
  if (json.code !== 0 && json.code !== 200) {
    throw new Error(`Zilliz query failed: ${json.message ?? JSON.stringify(json)}`);
  }
  return json.data ?? [];
}

// Milvus REST v2 serializes ARRAY<VARCHAR> as { Data: { StringData: { data: [...] } } }.
function asStringArray(v) {
  if (Array.isArray(v)) return v;
  const data = v?.Data?.StringData?.data;
  return Array.isArray(data) ? data : [];
}

function topN(counts, n) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

async function main() {
  const cfg = loadEnv();
  const brandCounts = new Map();
  const catCounts = new Map();
  const prices = [];
  let seen = 0;

  for (let offset = 0; offset < SAMPLE_SIZE; offset += PAGE) {
    const rows = await query(cfg, offset);
    if (rows.length === 0) break;
    for (const row of rows) {
      seen++;
      if (row.store) brandCounts.set(row.store, (brandCounts.get(row.store) ?? 0) + 1);
      for (const c of asStringArray(row.categories)) {
        if (c) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
      }
      if (typeof row.price === "number" && row.price > 0) prices.push(row.price);
    }
    if (rows.length < PAGE) break;
    process.stdout.write(`\rsampled ${seen} rows…`);
  }
  process.stdout.write("\n");

  prices.sort((a, b) => a - b);
  const priceMin = prices.length ? prices[0] : 0;
  const priceMax = prices.length
    ? Math.ceil(prices[Math.floor(prices.length * PRICE_MAX_PERCENTILE)])
    : 1000;

  const facets = {
    brands: topN(brandCounts, TOP_BRANDS),
    categories: topN(catCounts, TOP_CATEGORIES),
    priceMin: Math.floor(priceMin),
    priceMax,
    generatedAt: new Date().toISOString(),
    sampleSize: seen,
  };

  const out = join(ROOT, "public", "facets.json");
  writeFileSync(out, JSON.stringify(facets, null, 2) + "\n");
  console.log(
    `Wrote ${out}\n  ${facets.brands.length} brands, ${facets.categories.length} categories, price ${facets.priceMin}–${facets.priceMax} (from ${seen} rows)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

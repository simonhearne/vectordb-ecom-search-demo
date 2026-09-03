/**
 * POST /api/facets — live facet counts via Milvus 3.0 scalar aggregation (`entities/query`
 * + count(*)/min/max in `outputFields`). Scoped to the current filters and, when a query is
 * committed, to products that lexically match it (TEXT_MATCH). Aggregation runs over
 * `query`, not vector search, so this is "in catalogue matching your search".
 *
 * GROUP BY does not exist on this cluster (see functions/api/rest.ts CAPS.aggregationGroupBy),
 * so this endpoint only returns what scalar aggregation can answer: total count + price
 * bounds. `count(*)` cannot be combined with `min`/`max` in one call (CAPS.aggregationCountWithOthers
 * is false), hence two separate `entities/query` calls run in parallel.
 */
import type { FacetsRequest, FacetsResponse, Filters } from "../../src/lib/types";
import { compileFilter, esc } from "../../src/lib/filter";

const COLLECTION = "amazon_reviews_v3";
const CACHE_TTL = 86400;
const CACHE_KEY_BASE = "https://cache.vdb-ecom/api/facets";

interface Env {
  ZILLIZ_ENDPOINT: string;
  ZILLIZ_TOKEN: string;
}
type Ctx = { request: Request; env: Env; waitUntil?: (p: Promise<unknown>) => void };

async function zilliz(env: Env, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${env.ZILLIZ_ENDPOINT}/v2/vectordb/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ZILLIZ_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (json.code !== 0 && json.code !== 200) throw new Error(`Zilliz ${path}: ${json.message ?? JSON.stringify(json)}`);
  return json;
}

// Folds an optional lexical-match constraint into the compiled filter. TEXT_MATCH text is
// escaped with `esc` — it is user-supplied query text landing inside a Milvus string literal.
const withQuery = (filter: string, q: string): string => {
  if (!q) return filter;
  const tm = `TEXT_MATCH(text_snippet, "${esc(q)}")`;
  return filter ? `${filter} and ${tm}` : tm;
};

const pyFilter = (s: string) => (s ? `"""${s}"""` : '""');
function pyAgg(filter: string, fields: string[]): string {
  return [
    `client.query(`,
    `    collection_name="${COLLECTION}",`,
    `    filter=${pyFilter(filter)},`,
    `    output_fields=[${fields.map((f) => `"${f}"`).join(", ")}],`,
    `)`,
  ].join("\n");
}

export async function onRequestPost(ctx: Ctx): Promise<Response> {
  const { env } = ctx;
  if (!env.ZILLIZ_ENDPOINT || !env.ZILLIZ_TOKEN) return json({ error: "Server missing ZILLIZ_ENDPOINT / ZILLIZ_TOKEN." }, 500);
  let body: FacetsRequest;
  try {
    body = (await ctx.request.json()) as FacetsRequest;
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 502);
  }

  const q = (body.q ?? "").trim();
  const filters: Filters = body.filters ?? {};
  const now = new Date();
  const key = `${CACHE_KEY_BASE}?k=${await sha256(JSON.stringify({ q, filters: compileFilter(filters, now) }))}`;

  let cache: Cache | undefined;
  try {
    cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set("x-cache", "HIT");
      return r;
    }
  } catch {
    cache = undefined;
  }

  try {
    const filter = withQuery(compileFilter(filters, now), q);
    const t0 = Date.now();
    const [countOut, boundsOut] = await Promise.all([
      zilliz(env, "entities/query", { collectionName: COLLECTION, filter, outputFields: ["count(*)"], limit: 1 }),
      zilliz(env, "entities/query", { collectionName: COLLECTION, filter, outputFields: ["min(price)", "max(price)"], limit: 1 }),
    ]);
    const zillizMs = Date.now() - t0;
    const c = countOut.data?.[0] ?? {};
    const b = boundsOut.data?.[0] ?? {};
    const payload: FacetsResponse = {
      total: Number(c["count(*)"] ?? 0),
      priceMin: Math.floor(Number(b["min(price)"] ?? 0)),
      priceMax: Math.ceil(Number(b["max(price)"] ?? 0)),
      debug: {
        filter,
        pymilvusQuery: [pyAgg(filter, ["count(*)"]), pyAgg(filter, ["min(price)", "max(price)"])].join("\n\n"),
        zillizMs,
      },
    };
    const res = json(payload, 200);
    if (cache) {
      try {
        const stored = new Response(res.clone().body, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_TTL}` },
        });
        const p = cache.put(key, stored);
        if (ctx.waitUntil) ctx.waitUntil(p);
        else await p;
      } catch (e: any) {
        console.error("facets cache store failed:", e?.message ?? e);
      }
      res.headers.set("x-cache", "MISS");
    }
    return res;
  } catch (e: any) {
    return json({ error: String(e?.message ?? e) }, 502);
  }
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

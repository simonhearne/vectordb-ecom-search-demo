# Edge caching for the `/api/search` proxy

**Date:** 2026-06-26
**Status:** Approved, ready for implementation

## Problem

Every call to `POST /api/search` re-runs the full pipeline — query-understanding LLM
call (`@cf/meta/llama-4-scout-17b-16e-instruct`), embedding (`@cf/qwen/qwen3-embedding-0.6b`),
and one or more Zilliz REST searches. Identical inputs (repeated queries, pagination back
and forth, the default homepage query on every cold load, slider/filter toggles that land
on a previously-seen state) pay that full cost every time, incurring Workers AI charges and
added latency.

The collection is static (`amazon_reviews`, ~66k rows, "do NOT rebuild"), and query
understanding runs at `temperature: 0`, so a given request body produces a deterministic
result. That makes the whole pipeline safe to cache by input.

## Goal

For the same input, return the cached result without re-running the LLM / embed / Zilliz
calls.

## Approach: Cloudflare edge Cache API (`caches.default`)

Chosen over an in-memory isolate Map (per-isolate, ephemeral, low hit rate) and Workers KV
(extra infra + cost, unneeded for a static collection). The Cache API caches the entire
pipeline output at each Cloudflare edge POP, is shared across users at that POP, survives
isolate restarts, and needs no new bindings.

Pages Functions cannot cache a `POST` directly (POSTs are not cacheable). We use the
standard synthetic-key pattern: derive a canonical `GET` `Request` from a hash of the
request body and use it as the key for `cache.match()` / `cache.put()`.

### Cache key

Computed from the request body **before** any work runs. Determinant fields from
`SearchRequest`:

- `q`, `similarTo`, `sort`, `alpha`, `offset`, `limit`, `filters`, `understand`

Normalization (so semantically-equivalent requests collide on one entry):

- Apply the same defaults/clamping the handler already uses: `q`/`similarTo` trimmed,
  `sort` defaulted to `"relevance"`, `alpha` defaulted then clamped to `[0,1]`, `offset`
  floored to `>= 0`, `limit` floored and clamped to `[1, MAX_LIMIT]`, `understand`
  defaulted to `true`.
- `filters` reduced to a canonical object with sorted keys (and `brands` array sorted) so
  key order never produces a cache miss.

Serialize the normalized object to JSON, SHA-256 it via `crypto.subtle.digest`, hex-encode,
and build the key URL: `https://cache.vdb-ecom/api/search?k=<hex>`.

`understand` is part of the key because it changes the result (LLM-cleaned query + implied
filters vs. raw query). Because understanding is `temperature: 0`, the cached value is
stable for repeat inputs.

### Request flow (in `onRequestPost`)

1. Parse the body, then build the cache key from the normalized body.
2. `cache.match(key)`:
   - **HIT** → return the stored `Response` with an added `x-cache: HIT` header. No LLM,
     no embedding, no Zilliz call.
   - **MISS** → continue.
3. Run the existing pipeline unchanged (search / browse / similar).
4. Only when the pipeline yields a **200** response:
   - Add `Cache-Control: public, max-age=3600` (1 hour TTL).
   - `ctx.waitUntil(cache.put(key, res.clone()))` so storing never blocks the response.
   - Return the response with `x-cache: MISS`.
5. **Error responses (500 / 502) are never written to the cache.**

### TTL

1 hour (`max-age=3600`). High hit rate within a demo session while still re-running
occasionally so prompt/model changes surface without a manual purge.

### Scope

All three modes — search, browse, and "More like this" (similar) — since each is
deterministic for its input.

## Safety / degradation

- The entire cache layer is wrapped in try/catch. Any Cache API failure (notably local
  `wrangler pages dev`, where the Cache API can be a no-op or unavailable) falls through to
  the normal pipeline. Caching can never break or fail a search.
- `Ctx` is extended to include `waitUntil` (Pages Functions provide it on the event
  context). If `waitUntil` is unavailable, fall back to awaiting `cache.put` (still inside
  the try/catch).
- Cached bodies are byte-identical to the original response, so `debug.timings` reflect the
  original run. The `x-cache` header is the way to distinguish a HIT from a MISS; the
  diagnostics panel / network tab can surface it.

## Out of scope

- No cache invalidation/purge endpoint (TTL expiry is sufficient for a static collection).
- No change to the response body shape or the `SearchResponse` contract.
- No client-side caching changes.

## Testing

Verify locally via `npm run dev` (the `:5173` front door):

- Same query submitted twice → second response carries `x-cache: HIT` and returns
  near-instantly (no understand/embed/Zilliz latency in the network timing).
- Changing any keyed field (alpha via the blend slider, page via pagination, a filter, the
  sort) → `x-cache: MISS`.
- A request that errors (e.g. force a Zilliz/AI failure) returns 502 and is **not** served
  from cache on retry.
- `npm run typecheck` passes.

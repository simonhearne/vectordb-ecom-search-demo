# Tunable hybrid search (dense + BM25) — design

**Date:** 2026-06-18
**Status:** Approved (pending implementation plan)

## Goal

Run search queries as a tunable blend of **dense vector** similarity and **BM25
lexical** scoring, exposed as a UI slider. The slider's extremes collapse to
pure-keyword or pure-semantic search; the middle is a weighted hybrid. Hybrid is on
by default.

## Why this shape

True Milvus-native BM25 requires, at collection-creation time: an analyzer-enabled
VARCHAR field, a `SPARSE_FLOAT_VECTOR` field, and a BM25 `Function` mapping one to the
other. The original `amazon_reviews_electronics` collection has none of these, and
adding them to a populated collection does not backfill sparse vectors — so it needed a
rebuild.

That rebuild is **already done**: a new collection `amazon_reviews` exists with:
- `text_snippet` VARCHAR with `enable_analyzer=true`
- `text_sparse` `SparseFloatVector`
- function `text_snippet_bm25` (type BM25) mapping `text_snippet` → `text_sparse`
- the same scalar fields plus dense `text_vec` and `image_vec` (1024-d) as before
- 66,151 rows (vs 68,199 in the old collection — ~2k dropped, likely empty-snippet rows)
- indexes on `text_vec`, `image_vec`, `text_sparse`; loaded

All three search regimes were verified live through the Zilliz REST v2 API before this
design (see "Verified facts").

## Verified facts (live, 2026-06-18)

- **BM25-only search:** `entities/search` with `annsField:"text_sparse"`,
  `data:["<raw query text>"]` (Milvus applies the analyzer + BM25 function at query
  time). Returns a `distance` = BM25 score (higher = better; unbounded, ~9–10 range).
- **Hybrid search:** `entities/hybrid_search` with two sub-searches — dense
  (`text_vec`, a 1024-d query vector) and sparse (`text_sparse`, raw query text) —
  fused by a reranker. `distance` = fused score.
- **Weighted reranker:** `rerank:{strategy:"weighted", params:{weights:[w_dense,
  w_sparse]}}`. **Without `norm_score:true`**, raw BM25 (~9.6) swamps cosine (~1), so
  the weights are not perceptually linear. **With `norm_score:true`**, each
  sub-search's scores are min-max normalized to [0,1] before weighting, and the weights
  behave linearly (e.g. weights `[0.7,0.3]` give a pure-dense top hit a fused score of
  ~0.7). `norm_score:true` is therefore load-bearing.

## Design

### 1. Collection switch

Point the whole app at `amazon_reviews`:
- `functions/api/search.ts`: `COLLECTION = "amazon_reviews"`. Affects all three modes
  (search / browse / "More like this"). Browse and similar are functionally unchanged —
  the new collection has the same scalar + dense-vector fields. "More like this" still
  reads `text_vec` + `image_vec` by PK; both exist in the new collection.
- `scripts/build-facets.mjs`: `COLLECTION = "amazon_reviews"`, then
  `npm run build:facets` to regenerate `public/facets.json` from the new collection.

### 2. The blend control (UI)

A single slider representing **α ∈ [0,1] = the dense / semantic weight**, with end
labels **Keyword ↔ Semantic**.

- Visible **only in search mode** (a committed query is present). In browse and "More
  like this" there is no text query for BM25, so the control is hidden.
- α **persists across queries** — it is a global relevance preference, not reset on a
  new search.
- Default **α = 0.6** (slight semantic lean). One shared constant; trivially tunable.
- Placement: next to Sort in the header on desktop; inside the filter drawer on mobile
  (avoids header clutter). Both default choices are explicitly "tweak later."

Changing α refetches (like changing sort) and resets to page 0, but does **not** re-run
query understanding (the query text is unchanged, so `understand` stays false and the
client reuses the cleaned embed text).

### 3. Proxy search-branch logic

Only the `else if (rawQ)` search branch in `functions/api/search.ts` changes. Resolve
α (request value or `DEFAULT_HYBRID_ALPHA`), clamp to [0,1], then dispatch:

- **α ≥ 1** → pure dense: existing `entities/search` on `text_vec` with the embedded
  cleaned query. (strategy = `dense`)
- **α ≤ 0** → pure BM25: `entities/search` on `text_sparse` with
  `data:[cleanedQuery]`. **Skips the embedding call entirely** (latency/cost win).
  (strategy = `sparse`)
- **0 < α < 1** → `entities/hybrid_search` with two sub-searches:
  - dense: `{ data:[vector], annsField:"text_vec", filter, limit: subLimit }`
  - sparse: `{ data:[cleanedQuery], annsField:"text_sparse", filter, limit: subLimit }`
  - `rerank:{ strategy:"weighted", params:{ weights:[α, 1−α], norm_score:true } }`
  - `limit: fetchLimit`, `offset: fetchOffset`
  - `subLimit = min(fetchOffset + fetchLimit, MAX_LIMIT)` (same pattern as similar mode)
  (strategy = `weighted`)

The compiled `filter` applies to every branch and every sub-search. The downstream
POOL_SIZE over-fetch → `applySort` → slice logic is **unchanged**: the blended result
set is the candidate pool that gets sorted/paginated exactly as today. Serverless caps
(`limit ≤ 1024`, `limit + offset < 16384`) are respected because `fetchLimit ≤
POOL_SIZE (250) ≤ MAX_LIMIT`.

`toProduct` continues to map `distance` → `score`. The score's meaning now varies by
strategy (cosine / BM25 / fused); the `Product.score` comment is relaxed accordingly.

### 4. Contract & wiring

- `src/lib/types.ts`:
  - `SearchRequest.alpha?: number` — dense weight 0..1.
  - `SearchDebug` gains the resolved blend: `alpha?: number` and
    `strategy?: "dense" | "sparse" | "weighted"`. `annsField` strings updated to
    describe the active fields.
- `src/lib/config.ts`: `export const DEFAULT_HYBRID_ALPHA = 0.6` (shared; the server
  uses it when the request omits `alpha`).
- `src/App.tsx`: new `alpha` state (init from `DEFAULT_HYBRID_ALPHA`); add to the fetch
  effect deps and to the page-reset effect; include `alpha` in the request in search
  mode only (omit for browse/similar). Does not trigger query understanding.
- `src/components/Header.tsx` + a small `src/components/BlendSlider.tsx`: the control,
  shown only when a committed query exists.
- `src/components/DiagnosticsPanel.tsx`: surface the resolved blend (α + strategy).

### 5. Out of scope

- No change to "More like this" RRF blend (`text_vec + image_vec`).
- No re-embedding of the corpus.
- No RRF option for query search (weighted only, per decision).
- No image vector in the query-search blend.

## Edge cases

- Browse / similar modes: `alpha` ignored; control hidden.
- α exactly 0 or 1: single-field search (skip `hybrid_search`), per the "switch from
  one to the other at the bounds" requirement.
- Pure BM25 (α=0): no embedding; `embedMs` undefined in diagnostics.
- `norm_score` over a tiny/degenerate result set: min-max is still well-defined.

## Verification plan

1. `npm run typecheck` — clean.
2. `npm run build` — succeeds.
3. `npm run build:facets` — regenerates `public/facets.json` from `amazon_reviews`.
4. Live UI sweep (dev server): slider Keyword → blend → Semantic on a query that
   discriminates lexical vs semantic (e.g. an exact model number vs a descriptive
   phrase), confirming ranking shifts as expected.
5. Confirm browse and "More like this" still work after the collection switch.
6. Update `CLAUDE.md` and `README.md` (collection name, hybrid search section).

## Files touched

| File | Change |
|------|--------|
| `functions/api/search.ts` | collection const; blend dispatch in search branch; debug |
| `src/lib/types.ts` | `alpha` on request; blend on debug |
| `src/lib/config.ts` | `DEFAULT_HYBRID_ALPHA` |
| `src/App.tsx` | `alpha` state, request wiring, effect deps, search-mode gating |
| `src/components/Header.tsx` | mount the blend control |
| `src/components/BlendSlider.tsx` | new — the slider |
| `src/components/DiagnosticsPanel.tsx` | surface the blend |
| `scripts/build-facets.mjs` | collection const (+ regenerate `public/facets.json`) |
| `CLAUDE.md`, `README.md` | documentation |

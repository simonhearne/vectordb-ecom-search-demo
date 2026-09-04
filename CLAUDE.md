# vdb-ecom — vector-search e-commerce demo

Minimalist Amazon-style product search UI over an existing Zilliz Cloud (Milvus)
collection. Static React SPA on **Cloudflare Pages** + a same-origin **Pages Function**
proxy that embeds the query via **Workers AI** and searches Zilliz. The browser never
sees the DB key and never calls Zilliz directly.

## Commands
- `npm run dev` — full-stack local dev (`scripts/dev.mjs`): **Vite is the front door**
  (HMR, http://localhost:5173) and proxies `/api` to a `wrangler pages dev` Functions backend
  (http://localhost:8788) that holds the AI binding + secrets. Open the **:5173** URL. Needs
  `.dev.vars` (see below) + `wrangler login`. (Why a launcher, not `pages dev -- vite`: current
  wrangler rejects a proxy *command* when the config sets `pages_build_output_dir` — which
  `pages deploy` needs to apply the `[ai]` binding — so we run wrangler in directory mode and
  let Vite proxy to it; see `vite.config.ts`.)
- `npm run dev:vite` — UI only on :5173 (no backend, so `/api` calls fail).
- `npm run build` — `vite build` → `dist/`.
- `npm run build:facets` — regenerate `public/facets.json` (the brand/category lists shown
  before the first `/api/facets` response; live counts replace them once a query/filter runs).
- `npm run load:v3` — `.venv/bin/python scripts/load_v3.py`: (re)builds `amazon_reviews_v3` on
  the dedicated Milvus 3.0 cluster from the lab parquet. `--drop` recreates; `--schema-only`
  prints the schema without touching data; `--limit N` for a small validation run; `--reanchor`
  re-upserts `first_seen` only (see the 30-day trap below). Reads `ZILLIZ_ENDPOINT` +
  `ZILLIZ_WRITE_TOKEN` (data-admin key) from `.dev.vars`, never a Pages secret. Needs the venv:
  `uv venv --python 3.13 .venv && uv pip install -r scripts/requirements-v3.txt` (gitignored).
- `npm run probe:v3` — `scripts/probe-v3.mjs`: read-only REST v2 capability probe against the
  live cluster; its PASS/FAIL table is the source for `functions/api/rest.ts`
  (`REST_NAMES`/`CAPS`) and the design spec's "Verified facts" section.
- `npm test` — `vitest run` (`src/lib/filter.test.ts`, `src/lib/highlight.test.ts`). Also
  `.venv/bin/python -m pytest scripts/test_synth.py` for the synthetic-column generator.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run deploy` — build + `wrangler pages deploy dist` (preview, named after git branch).
- `npm run deploy:prod` — build + deploy to production (`--branch main` → `vdb-ecom.pages.dev`).

## Secrets / config
- Local: `.dev.vars` (gitignored) with `ZILLIZ_ENDPOINT`, `ZILLIZ_TOKEN`. Template in
  `.dev.vars.example`.
- Prod: the Pages project must exist first (`wrangler pages project create vdb-ecom
  --production-branch main`), then `wrangler pages secret put ZILLIZ_ENDPOINT` / `... TOKEN`.
- Secrets are **per-environment**: `secret put` targets production only on wrangler 4.101; preview
  secrets go through the Pages API (see "Preview secrets" below). Changes apply only to the *next* deploy. Preview URL is
  `<branch>.vdb-ecom.pages.dev`; production is `vdb-ecom.pages.dev`.
- Workers AI: `[ai]` binding `AI` in `wrangler.toml`. The binding proxies to real Workers
  AI **even in local dev** (incurs charges).
- **This branch** (`milvus-3.0`): `ZILLIZ_ENDPOINT`/`ZILLIZ_TOKEN` must point at the dedicated
  Milvus 3.0-compatible cluster hosting `amazon_reviews_v3` — not the 2.x serverless cluster
  described elsewhere in this file. It deploys to the **preview** environment of the existing
  `vdb-ecom` Pages project (preview secrets set via the Pages API, see below), landing at `milvus-3-0.vdb-ecom.pages.dev`. Preview-environment
  secrets are shared across *all* preview branches, so other preview deploys will also hit the
  3.0 cluster while these are set. The loader uses a separate `ZILLIZ_WRITE_TOKEN` (data-admin
  key, `.dev.vars` only, never a Pages secret) — the app's own `ZILLIZ_TOKEN` stays read-only
  (Search/Query/Describe).

- **Preview secrets on wrangler 4.101:** `wrangler pages secret put` has no `--environment`
  flag (it only writes production), so preview-environment secrets are set with the Pages API
  that wrangler itself uses: `PATCH https://api.cloudflare.com/client/v4/accounts/<account>/pages/projects/vdb-ecom`
  with `{"deployment_configs":{"preview":{"env_vars":{"ZILLIZ_ENDPOINT":{"type":"secret_text","value":…},"ZILLIZ_TOKEN":{…}}}}}`
  and the OAuth token from `~/Library/Preferences/.wrangler/config/default.toml` (done
  2026-09-04). Secrets apply to the *next* deploy. The Pages project lives in the **Loxima**
  account (`88729be0c36b22faf8073deca088968c`); with several accounts on the login, export
  `CLOUDFLARE_ACCOUNT_ID` before `npm run dev`/`npm run deploy` or wrangler refuses to pick one.

## Collection — `amazon_reviews_v3` (dedicated Milvus 3.0 cluster, AWS eu-west-1)
On this branch the app runs against a **dedicated** Milvus 3.0-compatible Zilliz Cloud cluster
(`in01-…:19530`, REST v2 at that endpoint) — not the 2.x serverless cluster used elsewhere in
this file. The cluster also holds an unrelated older `amazon_reviews` collection; the app must
never touch it.

PK `parent_asin` (VARCHAR). Scalars: `title`, `store` (brand), `main_category`, `image_url`,
`categories` (ARRAY<VARCHAR>), `price`/`average_rating` (DOUBLE), `rating_number` (INT64).
`text_snippet` (`enable_analyzer` + `enable_match`, English chain: standard tokenizer →
lowercase → asciifolding → english stemmer → english stop) feeds the `text_snippet_bm25` BM25
**function** → `text_sparse`. A second analyzed copy, `text_syn` (same text, same chain plus a
synonym filter — rules in `scripts/synonyms.txt` — inserted just before the stemmer), feeds
`text_syn_bm25` → `text_syn_sparse`; this is what the **Synonyms** toggle switches between.
`first_seen` (TIMESTAMPTZ, synthetic, seeded by PK, 20% within the trailing 30 days, anchored at
load time — **no index is possible** on this type) drives "Listed within". `store_city`
(VARCHAR) + `store_location` (GEOMETRY, RTREE index; synthetic, seeded by `store` from a shared
40-city table — `scripts/synth.py` / `src/lib/cities.ts`) drive "Ships from". Vectors
`text_vec`/`image_vec` (1024-d, COSINE) use **IVF_RABITQ** (nlist 1024, refine SQ8). INVERTED
indexes on `main_category`/`store`/`price`/`average_rating`/`rating_number`.

97,894 rows loaded from the lab parquet (`~/Projects/milvus_es_lab/data/amazon_reviews.parquet`,
sourced from HF `simonhearne/milvus-es-live-data`) via `npm run load:v3`
(`scripts/load_v3.py`, pymilvus ≥3.0) — no re-embedding; `text_vec`/`image_vec` come straight
from the parquet. **Do NOT create this collection by hand** — the loader is the only writer.

⚠️ **30-day trap:** `first_seen` is anchored at load time. If the collection was loaded more
than 30 days before a demo, "Listed within 30 days" returns nothing — run
`npm run load:v3 -- --reanchor` (re-upserts `first_seen` only) beforehand.

⚠️ **Data note:** unlike the 2.x collection, this data has **no `-1` price sentinels** (min
$0.0099, no nulls). `hasPrice()` and the `price > 0` clause are kept anyway (harmless, keeps
the diff focused).

## STEP 0 findings (verified live, this branch)
- Embedding dim **1024** and the Workers AI response shape (`{ shape, data }`) are unchanged.
- Query-embedding parity between Workers AI (`@cf/qwen/qwen3-embedding-0.6b`) and the parquet's
  stored `text_vec`/`image_vec` (produced by the same Qwen3-Embedding-0.6B / SigLIP pipeline)
  must be confirmed on this cluster before trusting search: `wrangler login`, `npm run dev`,
  then six `POST /api/search` calls with exact product titles at `alpha: 1`, expecting the seed
  product at rank 1.
- Core REST v2 shapes (`entities/search`, `entities/query`, `Authorization: Bearer`) are
  unchanged. Caps differ from the 2.x serverless cluster: `limit` up to **16384** is accepted
  here, `limit + offset ≤ 16384` still holds — the proxy keeps its existing clamps regardless.
- The full parameter-level capability survey (`order_by`, aggregation, phrase match, grouping,
  decay rerank, GEOMETRY, `indexes/describe`, highlighting, …) lives in
  `functions/api/rest.ts` (`REST_NAMES`/`CAPS` — "change here, nowhere else") and is produced by
  `npm run probe:v3`, not repeated here. See "Milvus 3.0 features" below for what it means for
  the app.

## Layout
- `functions/api/search.ts` — proxy: `POST /api/search` (search when `q` — tunable hybrid
  dense+BM25 blend, see below; "More like this" similarity when `similarTo`; scalar browse
  otherwise). `understandQuery()` runs NL query understanding; `compileFilter()` builds the
  Milvus expr (escaped); `applySort()` reorders the retrieved window. Response includes
  `parsed` (interpretation) and a `debug` block (compiled filter, embed dim, blend
  strategy/α, timing breakdown) consumed by the diagnostics panel.
- `functions/api/rest.ts` — single source of truth for verified Milvus 3.0 REST v2 parameter
  names and instance capabilities (`REST_NAMES`, `CAPS`), populated by `npm run probe:v3`.
  "Change here, nowhere else" — `search.ts`/`facets.ts` gate every 3.0-only request fragment
  through this file, so the diagnostics transcript can never claim a parameter the request
  didn't actually carry.
- `functions/api/facets.ts` — proxy: `POST /api/facets`, scoped to the current filters (+
  `TEXT_MATCH` once a query is committed). `count(*)` and `min/max(price)` are scalar
  aggregations (two `entities/query` calls — they can't share one). **Per-brand / per-category
  counts** are computed in the proxy: GROUP BY doesn't exist over REST v2 here, so it fetches
  the matching rows' `store` + `categories` (PK-ordered, `limit 16384`, paged by
  `parent_asin > last`, max 2 pages) and counts them with `src/lib/facetCounts.ts`. Standard
  faceting: brand counts ignore the brand filter, category counts ignore the category filter
  (one fetch when neither is set, two in parallel otherwise). Returns `{ total, priceMin,
  priceMax, brands, categories, exact, sampled }`; `exact: false` means the set exceeded
  32,768 rows and counts come from the first `sampled` rows (bare browse). `public/facets.json`
  is only the pre-response fallback list.
- `src/lib/filter.ts` — `compileFilter()` (shared by `search.ts` and `facets.ts`,
  unit-tested): price/rating/reviews/brand/category, plus `PHRASE_MATCH`, the `first_seen`
  date cutoff (`dateCutoffIso`, floored to UTC midnight so the cache key stays stable within a
  day), and `st_dwithin` geo. `extractPhrase()` pulls a `"quoted phrase"` out of the raw query
  before it reaches query understanding.
- `src/lib/highlight.ts` — `daysSince()`, gating the "New" badge (`first_seen` within
  `NEW_BADGE_DAYS`). This build has no server-side highlighter (see "Milvus 3.0 features"
  below), so there's no snippet-marking helper here.
- `src/lib/cities.ts` — the 40-city `{name, lon, lat}` table (kept in sync with
  `scripts/synth.py`), resolving `Filters.near.city` for `st_dwithin`.
- `src/components/SearchControls.tsx` — Fusion (Weighted/RRF) segmented control, Synonyms and
  One-per-brand toggles, Boost select. Search-mode only, alongside the blend slider.
- `src/components/DiagnosticsPanel.tsx` — collapsible panel beneath the results showing the
  query, compiled filter, window, latency (client round-trip + server understand/embed/
  zilliz), and raw results JSON — plus (this branch) server-side sort / group-by / ranker /
  sparse field / vector index rows and a "Facet aggregation" section (the two
  `client.query(...)` calls behind `/api/facets`). No tokens row (`run_analyzer` is
  unavailable over REST v2 here).
- `src/components/InterpretationNote.tsx` — shows how a NL query was interpreted (cleaned
  text + implied-filter chips), dismissible.
- `src/App.tsx` — state container: submit-driven search, filters/sort/pagination, drawer,
  adopting the proxy's interpretation.
- `src/components/SimilarNote.tsx` — banner shown in "More like this" mode (names the seed
  product, offers an exit ×).
- `src/lib/searchClient.ts` — single front-end DB seam (all DB access via `/api/search`;
  "More like this" reuses it with `similarTo`).
- `src/lib/types.ts` — shared request/response contract (imported by both sides).
- `scripts/build-facets.mjs` → `public/facets.json` (top brands/categories/price bounds).
- `src/components/` — Header (search + Search button + blend slider + sort), BlendSlider
  (the dense↔keyword relevance slider), FilterPanel, ProductGrid/Card, Pagination, Stars,
  States, icons.

## Hybrid search (dense + BM25)
Query search blends **dense** vector relevance (`text_vec`) with **BM25 lexical** scoring
(`text_sparse`), controlled by a single weight **α ∈ [0,1] = dense/semantic weight**
(`DEFAULT_HYBRID_ALPHA = 0.6` in `src/lib/config.ts`, shared client/server; sent as
`SearchRequest.alpha`). The proxy dispatches on α (clamped) in the search branch:
- **α ≥ 1** → pure dense `entities/search` on `text_vec` (embedded cleaned query).
- **α ≤ 0** → pure BM25 `entities/search` on `text_sparse` with `data:[cleanedQuery]` (raw
  text; Milvus applies the analyzer + BM25 function). **Skips the embedding call** entirely.
- **0 < α < 1** → `entities/hybrid_search`: dense sub-search **first** + sparse sub-search,
  `rerank:{strategy:"weighted",params:{weights:[α,1−α],norm_score:true}}`. `norm_score:true`
  is load-bearing — without it raw BM25 (~9.6) swamps cosine (~1) and the weights aren't
  linear. Sub-search order is positional: dense first so `weights[0]=α` applies to it.

The compiled `filter` applies to every branch/sub-search; the POOL_SIZE over-fetch→sort→slice
path is unchanged (the blended set is the candidate pool). UI: `BlendSlider` (labels
Keyword↔Semantic) shows **only in search mode** (a committed query, not browse/similar) — on
desktop beside Sort, on mobile in the filter drawer. α persists across queries / "More like
this" / clear (a global preference). Changing α refetches + resets to page 0 but does **not**
re-run query understanding (query text is unchanged). `debug.strategy`/`debug.alpha` surface
the resolved blend. NB: "More like this" keeps its own separate `text_vec + image_vec` RRF
blend (below) — α does not apply there.

This branch adds two more search-mode knobs on top of the α dispatch above: **Fusion**
(Weighted, using α as above, or **RRF** — `rerank:{strategy:"rrf",params:{k:60}}`, α ignored
and the slider disabled) and **Synonyms** (default on: BM25 sub-searches run against
`text_syn_sparse`; off switches to plain `text_sparse`). See "Milvus 3.0 features" below for
how **Boost** interacts with fusion.

## Query understanding
NL queries like "remote control under $10" are parsed by the proxy via Workers AI JSON mode
(`@cf/meta/llama-4-scout-17b-16e-instruct`, `response_format: json_schema`) into a cleaned
query (embedded) + implied numeric filters (price/rating/reviews, incl. ranges). Scope is
intentionally numeric only — brand/category stay on the manual controls (extracting them needs
facet lists in-prompt and risks hallucination). `backstopFilters()` is a deterministic regex
that fills any explicit `$N` / `N star` / `N reviews` the model misses (and recovers filters
if the LLM call fails). Before the LLM call, a deterministic pass (`extractPhrase()` in `src/lib/filter.ts`) pulls a
`"quoted phrase"` out of the raw query into `Filters.phrase` and strips the quote marks from the
text the model sees; the phrase words stay in the cleaned text (still relevant to embedding and
BM25). Search is **submit-driven** (Enter or the Search button), not
as-you-type: typing updates `query`; submit sets `committedQuery`, which drives the fetch.
Submitting a *new* query text clears the filter rail first (fresh slate, so the prior query's
implied filters don't leak in); re-submitting the same text keeps filters. Filters/sort/
pagination still auto-apply without a submit. The client sends `understand: true` only when the
committed query *text* changes (not on filter/sort/page changes), adopts the cleaned query
into the box + committed query, and merges implied filters into the rail. Best-effort: on LLM
failure the backstop + raw query are used.

Model notes (Workers AI, as of 2026-06): Llama 4 Scout is correct on ranges/multi-constraint
at ~0.6-1s. AVOID: `llama-3.1-8b-instruct`/`-fast`, `llama-3-8b-instruct`,
`hermes-2-pro-mistral-7b`, `mistral-7b` (deprecated 2026-05-30); `llama-3.3-70b-instruct-fp8-fast`
(correct but ~60s); `gemma-3-12b-it` / `mistral-small-3.1-24b` (dropped constraints on ranges).

## More like this (similar products)
A third query type alongside search/browse. Clicking the hover-revealed "More like this"
button on any `ProductCard` runs a similarity search **seeded by that product's stored
vectors** — no browser embedding. The proxy: (1) reads the seed's `text_vec` + `image_vec`
by PK via `entities/query` (`outputFields:["text_vec","image_vec"]` — vectors *are*
retrievable on serverless), (2) runs `entities/hybrid_search` with two sub-searches (one per
field) blended by **RRF** (`rerank:{strategy:"rrf",params:{k:60}}`), excluding the seed
(`parent_asin != "<id>"`) and folding in any manual filters. Score field is the RRF
`distance`. If the seed has no `image_vec`, it degrades to a single `text_vec`
`entities/search`. Driven by `SearchRequest.similarTo` (a `parent_asin`); `mode:"similar"`.
Client (`App.tsx`): clicking sets `similarTo` (the whole `Product`, for the banner title) and
starts a **fresh slate** (clears query text + filters, like a new query); a typed search or the
banner × exits similar mode. Reuses the whole fetch effect, grid, sort, filters, pagination,
and diagnostics. Serverless caps still apply (sub-search `limit = offset+limit ≤ 1024`). This
branch's search-mode controls (Fusion/Synonyms/One-per-brand/Boost) are hidden here and don't
apply — "More like this" keeps its own fixed RRF blend.

## Milvus 3.0 features
One UI control per verified REST v2 capability. `functions/api/rest.ts`'s `CAPS` gates every
one of these — a `false` there means the app never sends that parameter, not "sends it and
hopes":

- **Exact phrase** — `"quoted phrases"` in the query become
  `PHRASE_MATCH(text_snippet, "…", 2)`, extracted before query understanding sees the text;
  shown as a chip in the interpretation note.
- **Listed within** (Any / 30 / 90 / 365 days) — `first_seen > ISO '<UTC-midnight cutoff>'`.
  **Newest** sort is a client-side pool sort (`applySort` over the over-fetched `POOL_SIZE`
  candidates), not native — TIMESTAMPTZ accepts no server-side order. "New" badge ≤30 days.
- **Ships from within N km of `<city>`** — `st_dwithin(store_location, 'POINT (lon lat)',
  N*1000)` against the 40-city table; cards show "Ships from {store_city}".
- **Synonyms** toggle — swaps the BM25 sparse field between `text_syn_sparse` and
  `text_sparse`.
- **Fusion**: Weighted / RRF — `rerank:{strategy:"rrf",params:{k:60}}` vs. the existing
  weighted blend; RRF disables the α slider.
- **One per brand** — `groupingField:"store", groupSize:1`; works on both plain search and
  hybrid search.
- **Boost**: none / cheaper / better rated / popular — a `functionScore` decay reranker
  (`type:"Rerank"`, `params:{reranker:"decay", function:"gauss"|"exp", …}`). **Enabled only at
  α=0 or α=1 under weighted fusion** — a `functionScore` *replaces* the hybrid fusion reranker
  rather than composing with it, and Milvus allows exactly one rerank function per request, so
  boost and a blended α (or RRF) are mutually exclusive; `boostDisabledReason` in `App.tsx`
  mirrors this rule client-side. There is no "boost newest": decay rejects `first_seen`
  (TIMESTAMPTZ isn't a numeric decay input).
- **Live catalogue count, price bounds and per-brand/category counts** (`/api/facets`) —
  `count(*)` and `min(price)`/`max(price)` are scalar aggregation calls (they can't be combined
  in one); brand/category counts are **fetch-and-count in the proxy** (GROUP BY isn't exposed
  by REST v2 on this cluster): the matching rows' `store`/`categories` columns are pulled
  PK-ordered in up to two 16,384-row pages and tallied. Scoped to the current filters plus
  `TEXT_MATCH(text_snippet, q)` once a query is committed. Rail shows "N in catalogue matching
  your search", live price-slider bounds, a count beside every brand, and counts in the
  category dropdown; sets past 32,768 rows are labelled "counts approximate".
- **Sort** — native `orderByFields` exists only on `entities/query` (browse), ascending only,
  over the whole filtered set — used for browse and **Price: low to high** only. Every other
  sort (price: high to low, rating, reviews, newest, and every sort in search/similar mode)
  keeps the existing `POOL_SIZE` over-fetch → sort → slice path.
- **Vector index** — `indexes/describe` reports the live index type (`IVF_RABITQ`), shown in
  diagnostics.

**Not available over REST v2 on this cluster** (so not in the app): result highlighting (no
highlighter field on `entities/search`/`hybrid_search` — cards show the plain `text_snippet`;
`HL_OPEN`/`HL_CLOSE` sentinels are defined in `rest.ts` as a documented no-op for if a future
build gains one), GROUP BY aggregation (per-brand/category counts are computed in the proxy
instead), `run_analyzer` (no token
preview in diagnostics), decay reranking on TIMESTAMPTZ, and descending or search-side
`order_by`.

Diagnostics panel additions on this branch: **Sort (server)** — native fields, or `pool N ·
client-side`; **Group by**; **Ranker** (`WeightedRanker(...)` / `RRFRanker(60)` /
`FunctionScore(...)`); **Sparse field**; **Vector index**; plus a **Facet aggregation** section
showing the two `client.query(...)` calls behind `/api/facets`. No tokens row.

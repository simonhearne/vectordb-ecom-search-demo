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
- `npm run build:facets` — regenerate `public/facets.json` from the live collection.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run deploy` — build + `wrangler pages deploy dist` (preview, named after git branch).
- `npm run deploy:prod` — build + deploy to production (`--branch main` → `vdb-ecom.pages.dev`).

## Secrets / config
- Local: `.dev.vars` (gitignored) with `ZILLIZ_ENDPOINT`, `ZILLIZ_TOKEN`. Template in
  `.dev.vars.example`.
- Prod: the Pages project must exist first (`wrangler pages project create vdb-ecom
  --production-branch main`), then `wrangler pages secret put ZILLIZ_ENDPOINT` / `... TOKEN`.
- Secrets are **per-environment**: `secret put` targets production; add `--environment preview`
  for preview deploys. Changes apply only to the *next* deploy. Preview URL is
  `<branch>.vdb-ecom.pages.dev`; production is `vdb-ecom.pages.dev`.
- Workers AI: `[ai]` binding `AI` in `wrangler.toml`. The binding proxies to real Workers
  AI **even in local dev** (incurs charges).

## Collection — `amazon_reviews_electronics` (Zilliz Serverless, AWS eu-central-1)
PK `parent_asin` (VARCHAR). Scalars: `title`, `main_category`, `store` (brand),
`price` (FLOAT USD), `average_rating`, `rating_number`, `categories` (ARRAY<VARCHAR>),
`image_url`, `text_snippet`. Vectors (1024-d, COSINE, normalized): `text_vec`
(query-time), `image_vec` (stored only). **Do NOT rebuild the collection.**

⚠️ **Data note:** `price` contains `-1` sentinels for unknown prices (despite the spec
saying unknowns were excluded). Treat `price <= 0` as "no price": hide on card, exclude
from price filter, sort last on price sorts. Helper: `hasPrice()` in `src/lib/types.ts`.

## STEP 0 findings (verified live)
- Embedding dim **1024** confirmed. Workers AI response shape `{ shape, data }`; vector =
  `res.data[0]`.
- **Runtime query format: `{ queries: q, instruction: "Given a shopping query, retrieve
  relevant product listings" }`** (`@cf/qwen/qwen3-embedding-0.6b`). Parity round-trip
  self-matched 6/6 at rank 1, mean cosine ~0.87; NL queries rank topically correct.
- Zilliz REST v2: search `POST {endpoint}/v2/vectordb/entities/search`
  (`data:[[...]]`, `annsField`, `filter`, `limit`, `offset`, `outputFields`); browse
  `.../entities/query` (`filter` may be `""`). Score field is `distance`. Auth
  `Authorization: Bearer <token>`. Serverless caps: `limit ≤ 1024`, `limit+offset < 16384`.

## Layout
- `functions/api/search.ts` — proxy: `POST /api/search` (vector search when `q`; "More
  like this" similarity when `similarTo`; scalar browse otherwise). `understandQuery()` runs
  NL query understanding; `compileFilter()` builds the Milvus expr (escaped); `applySort()`
  reorders the retrieved window. Response includes `parsed` (interpretation) and a `debug`
  block (compiled filter, embed dim, timing breakdown) consumed by the diagnostics panel.
- `src/components/DiagnosticsPanel.tsx` — collapsible panel beneath the results showing the
  query, compiled filter, window, latency (client round-trip + server understand/embed/
  zilliz), and raw results JSON.
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
- `src/components/` — Header (search + Search button + sort), FilterPanel, ProductGrid/Card,
  Pagination, Stars, States, icons.

## Query understanding
NL queries like "remote control under $10" are parsed by the proxy via Workers AI JSON mode
(`@cf/meta/llama-4-scout-17b-16e-instruct`, `response_format: json_schema`) into a cleaned
query (embedded) + implied numeric filters (price/rating/reviews, incl. ranges). Scope is
intentionally numeric only — brand/category stay on the manual controls (extracting them needs
facet lists in-prompt and risks hallucination). `backstopFilters()` is a deterministic regex
that fills any explicit `$N` / `N star` / `N reviews` the model misses (and recovers filters
if the LLM call fails). Search is **submit-driven** (Enter or the Search button), not
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
and diagnostics. Serverless caps still apply (sub-search `limit = offset+limit ≤ 1024`).

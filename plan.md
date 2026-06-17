# Build: minimalist Amazon-style vector-search app on Cloudflare (Pages + Workers AI proxy)

Build a minimalist e-commerce search UI replicating Amazon's core UX (search box,
faceted filters, sort) over an existing Zilliz Cloud (Milvus) collection.
Architecture is committed:
- **Front-end**: static SPA on **Cloudflare Pages**.
- **Search proxy**: a **Cloudflare Pages Function** (Worker) — same origin as the
  site (no CORS). It holds the Zilliz read-only key as a secret, embeds the query
  via a **Workers AI** binding, runs the Zilliz search, returns results.
- The browser NEVER sees the DB key and NEVER calls Zilliz directly.
Use Claude Design / your frontend-design skill for a clean, minimal, functional UI.

## Existing collection (do NOT rebuild)
Zilliz Cloud **Serverless**, AWS eu-central-1.
- Collection `amazon_reviews_electronics`; PK `parent_asin` (VARCHAR).
- Scalars: `title`, `main_category`, `store` (brand), `price` (FLOAT USD, always
  real — unknowns excluded at ingest), `average_rating` (FLOAT),
  `rating_number` (INT64), `categories` (ARRAY<VARCHAR>), `image_url` (VARCHAR),
  `text_snippet` (VARCHAR). Dynamic fields may include `color`, `material`.
- Vectors (both 1024-d, metric COSINE, AUTOINDEX, normalized at ingest):
  - `text_vec` — ingested with **HuggingFace Qwen/Qwen3-Embedding-0.6B** via
    sentence-transformers; DOCUMENTS embedded plain (no instruction),
    `max_seq_length=384`, last-token pooling, L2-normalized.
  - `image_vec` — SigLIP ViT-L-16-SigLIP-256 of the product image (not needed
    for query-time embedding; only used by "more like this" via stored vectors).

## Workers AI query embedding
Query embedding uses Workers AI model `@cf/qwen/qwen3-embedding-0.6b` (1024-d).
Qwen3-Embedding aligns plain documents with instruction-prefixed queries, so the
intended query form is:
`Instruct: Given a shopping query, retrieve relevant product listings\nQuery: {q}`

## STEP 0 — verify, then report back BEFORE building the rest
1. **Vector parity round-trip (critical).** In a throwaway script/Function:
   pick a few products from the collection (query their `title`/`text_snippet`),
   embed that exact text via Workers AI `@cf/qwen/qwen3-embedding-0.6b`, search
   `text_vec`, and confirm the same product returns at rank 1 with high cosine
   (≳0.8). Test BOTH plain text and the `Instruct:…\nQuery:…` form to determine
   which the Workers AI wrapper expects (it may or may not apply the instruction
   internally). Pick whichever reproduces parity. If neither does, STOP and
   report — the fallback is re-ingesting docs with the Workers AI model so the
   spaces are identical by construction; don't paper over poor parity.
2. **Workers AI response shape**: confirm how the embedding is returned
   (e.g. `{ data: [[...1024 floats...]] }`) and extract correctly.
3. **Zilliz REST v2**: confirm current request/response for search & query
   against https://docs.zilliz.com (Authorization: Bearer <token>; endpoints
   like `/v2/vectordb/entities/search` and `/v2/vectordb/entities/query`; fields
   `collectionName`, `data`, `annsField`, `filter`, `limit`, `offset`,
   `outputFields`). Don't assume — verify.
Report the parity findings, chosen query format, and confirmed REST shapes first.

## Proxy (Pages Function) API
Single small module, e.g. `functions/api/search.ts`, bindings: `AI` (Workers AI),
secrets `ZILLIZ_ENDPOINT`, `ZILLIZ_TOKEN` (read-only).
- `POST /api/search` — body `{ q?, filters, sort, limit, offset }`.
  - If `q` non-empty: embed via Workers AI → vector search on `text_vec`
    (COSINE), with `filter` and `outputFields` (all display scalars).
  - If `q` empty (browse): scalar `query` with `filter`, `limit`, `offset`.
  - Apply `sort` (see below) and return `{ results, total? }`.
- `POST /api/similar` — body `{ parent_asin, mode: "image"|"text" }`:
  `query` the row by `parent_asin` to fetch its stored `image_vec`/`text_vec`,
  then search that field for neighbours. No query-time model needed.
- Keep one `searchClient` abstraction on the front-end so all DB access is via
  these endpoints.

## Filters → Milvus boolean expression
Compile UI facets to a `filter` string (combine with `and`; safely escape
user strings):
- price range → `price >= {min} and price <= {max}`
- min rating → `average_rating >= {r}`
- min #reviews → `rating_number >= {n}`
- brand (multi) → `store in ["{a}","{b}"]`
- category → `array_contains(categories, "{cat}")`
Populate facet controls (top-N brands, category list, price bounds) from a
build-time `facets.json` artifact, NOT runtime distinct queries.

## Sort
Relevance (native vector order) | Price ↑ | Price ↓ | Avg rating | Most reviewed.
Relevance = search order. Others = sort the retrieved candidate window
client-side (note this is the standard vector-first approximation: it reorders
within the top-K retrieved, not the whole catalog). Browse mode uses a larger
scalar limit then sorts.

## Front-end (Amazon core UX)
- Sticky slim header: search input + sort dropdown.
- Left filter rail (collapsible; drawer on mobile): price slider, min rating,
  brand multi-select, category, min reviews.
- Responsive product grid: card = image (`image_url`, lazy + broken-URL
  fallback), title, price (USD), stars + `rating_number`, brand. "More like this"
  action per card → calls `/api/similar`, shows visually-similar (image) and
  similar-products (text) rows.
- Result count, pagination (limit/offset), and clear loading / empty / error
  states.

## UI / design
Use Claude Design / frontend-design skill. Minimalist, clean, functional —
Amazon's information hierarchy, NOT its branding. Neutral palette, generous
whitespace, restrained type, subtle hover/focus, fully responsive,
keyboard-accessible.

## Stack & deploy (Cloudflare)
- React + Vite + TypeScript, Tailwind ok. SPA (add `_redirects` SPA fallback if
  needed).
- Cloudflare Pages project with the Pages Function; `wrangler.toml` declaring the
  `[ai]` binding and the Zilliz secrets (set via `wrangler pages secret put` /
  dashboard, never committed). Deploy via Git integration (push-to-deploy) and/or
  `wrangler pages deploy`.
- Runtime/front-end config (non-secret) in a small config file; secrets stay in
  the Function env only.

## Security / README
- Document creating the Zilliz **read-only** key (role limited to Search/Query/
  Describe on this cluster+collection) and storing it as a Pages secret. Even
  though it's server-side, keep it least-privilege.
- README: prerequisites, Workers AI + Zilliz secret setup, `facets.json`
  generation, local dev (`wrangler pages dev`), deploy, and the STEP 0 parity
  findings.

## Deliverables
A working Cloudflare Pages repo: static SPA, the Pages Function proxy (search +
similar), `facets.json` build step, `wrangler.toml`, and README. Lead your first
reply with the STEP 0 verification results and the query-embedding format you
settled on.
/**
 * STEP 0 for the Milvus 3.0 branch: try each REST v2 call shape the proxy will depend on
 * and print PASS/FAIL with the response shape. Reads ZILLIZ_ENDPOINT / ZILLIZ_TOKEN from
 * env or .dev.vars. Never writes. Usage: node scripts/probe-v3.mjs [--verbose]
 *
 * Note on method: the REST v2 request decoder is *strict about types on fields it knows*
 * and *silently drops fields it does not know*. So "the call succeeded" proves nothing.
 * Every probe therefore either (a) checks an observable effect, or (b) uses `inStruct()`,
 * which sends a deliberately wrong-typed value: a type-mismatch error means the field
 * exists in the request struct; a clean 200 means the field is not implemented at all.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTION = "amazon_reviews_v3";
const VERBOSE = process.argv.includes("--verbose");

function loadEnv() {
  let endpoint = process.env.ZILLIZ_ENDPOINT, token = process.env.ZILLIZ_TOKEN;
  const dv = join(ROOT, ".dev.vars");
  if ((!endpoint || !token) && existsSync(dv)) {
    for (const line of readFileSync(dv, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "ZILLIZ_ENDPOINT" && !endpoint) endpoint = v;
      if (m[1] === "ZILLIZ_TOKEN" && !token) token = v;
    }
  }
  if (!endpoint || !token) throw new Error("Missing ZILLIZ_ENDPOINT / ZILLIZ_TOKEN");
  return { endpoint, token };
}
const ENV = loadEnv();

async function rawCall(path, body) {
  const res = await fetch(`${ENV.endpoint}/v2/vectordb/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function call(path, body) {
  const { status, text } = await rawCall(path, body);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${status} non-JSON: ${text.slice(0, 80)}`); }
  if (json.code !== 0 && json.code !== 200) throw new Error(json.message ?? JSON.stringify(json));
  return json;
}

/** True when `key` is a real field of the request struct (it rejects a wrong-typed value). */
async function inStruct(path, body, key, badValue = { __probe: 1 }) {
  const { text } = await rawCall(path, { ...body, [key]: badValue });
  return /Mismatch type/.test(text);
}

// Shape of a value, one level deep, for the report.
const shape = (v) =>
  Array.isArray(v) ? `[${v.length}] ${shape(v[0])}` :
  v && typeof v === "object" ? `{${Object.keys(v).slice(0, 12).join(",")}}` : typeof v;

const results = [];
const push = (id, name, status, variant, sh) => results.push({ id, name, status, variant, shape: sh ?? "-" });
const info = (id, name, variant = "-") => push(id, name, "INFO", variant);

/**
 * variants: [{label, path, body}] — every one is tried; the first that satisfies `check`
 * wins (PASS). If none satisfies it but some call succeeded, the first such is reported
 * WEAK (accepted but no observable effect => silently ignored). None accepted => FAIL.
 */
async function probe(id, name, variants, check = () => true) {
  let weak = null;
  for (const v of variants) {
    let out;
    try {
      out = await call(v.path, v.body);
    } catch (e) {
      if (VERBOSE) console.log(`  ${id} ${v.label}: ERR ${e.message}`);
      continue;
    }
    const rows = out.data ?? [];
    let ok = false;
    try { ok = check(rows, out); } catch { ok = false; }
    if (VERBOSE) console.log(`  ${id} ${v.label}: ${ok ? "PASS" : "WEAK"} ${JSON.stringify(rows.slice(0, 2))}`.slice(0, 500));
    if (ok) {
      push(id, name, "PASS", v.label, shape(rows));
      return { ok: true, rows, out, variant: v.label };
    }
    if (!weak) weak = { rows, out, variant: v.label };
  }
  if (weak) {
    push(id, name, "WEAK", weak.variant, shape(weak.rows));
    return { ok: false, weak: true, ...weak };
  }
  push(id, name, "FAIL", "-", "-");
  return { ok: false, rows: [] };
}

// A seed dense vector: read one from the collection so no embedding is needed here.
const seed = (await call("entities/query", {
  collectionName: COLLECTION, filter: "price > 0", limit: 1,
  outputFields: ["parent_asin", "title", "text_vec"],
})).data[0];
const qv = seed.text_vec;
if (VERBOSE) console.log(`seed: ${seed.parent_asin} "${seed.title}" dim=${qv.length}`);
const base = { collectionName: COLLECTION, limit: 5, outputFields: ["parent_asin", "title", "price", "store"] };
const S = (extra) => ({ path: "entities/search", body: { ...base, data: [qv], annsField: "text_vec", ...extra } });
const SP = (extra) => ({ path: "entities/search", body: { ...base, data: ["wireless earbuds"], annsField: "text_sparse", ...extra } });
const Q = (extra) => ({ path: "entities/query", body: { ...base, filter: "price > 0", ...extra } });
const WEIGHTED = { strategy: "weighted", params: { weights: [0.6, 0.4], norm_score: true } };
const H = (extra) => ({
  path: "entities/hybrid_search",
  body: {
    ...base,
    search: [
      { data: [qv], annsField: "text_vec", limit: 20 },
      { data: ["wireless earbuds"], annsField: "text_sparse", limit: 20 },
    ],
    rerank: WEIGHTED,
    ...extra,
  },
});
const ids = (rows) => rows.map((x) => x.parent_asin).join();

// ── 1 analyzer + BM25 + synonyms ──────────────────────────────────────────────
await probe(1, "bm25 on text_sparse", [{ label: "text_sparse", ...SP({}) }], (r) => r.length > 0);
await probe(1, "synonyms: 'tablet' on text_syn_sparse returns iPad", [
  { label: "text_syn_sparse", path: "entities/search", body: { ...base, data: ["tablet"], annsField: "text_syn_sparse", limit: 20 } },
], (r) => r.some((x) => /ipad/i.test(x.title)));

// ── 2 order_by ────────────────────────────────────────────────────────────────
// Candidate names x candidate value shapes. Only `entities/query` implements any of them.
const ORDER_CANDIDATES = [
  ["orderByFields", ["price"]],
  ["orderByFields", [{ field: "price", order: "asc" }]],
  ["orderByFields", ["price asc"]],
  ["order_by_fields", ["price"]],
  ["order_by_fields", [{ field: "price", order: "asc" }]],
  ["orderBy", ["price"]],
  ["order_by", ["price"]],
  ["sortBy", ["price"]],
  ["sort_by", ["price"]],
];
const orderVariants = (mk) => ORDER_CANDIDATES.map(([k, v]) => ({ label: `${k}=${JSON.stringify(v)}`, ...mk({ [k]: v }) }));
const sortedAsc = (r) => r.length > 1 && r.every((x, i) => i === 0 || x.price >= r[i - 1].price);

const obQuery = await probe(2, "order_by on query (browse)", orderVariants(Q), sortedAsc);
// A bogus field name is REJECTED where order_by is implemented, ACCEPTED where it is dropped.
const obSearchReal = await rawCall("entities/search", S({ orderByFields: ["nosuchfield"] }).body);
const obHybridReal = await rawCall("entities/hybrid_search", H({ orderByFields: ["nosuchfield"] }).body);
push(2, "order_by on search", /does not exist/.test(obSearchReal.text) ? "PASS" : "FAIL", "orderByFields silently dropped");
push(2, "order_by on hybrid_search", /does not exist/.test(obHybridReal.text) ? "PASS" : "FAIL", "orderByFields silently dropped");

// Derive the parameter name AND the accepted value shape from whichever variant won, so a
// future build that renames the parameter (or changes the value shape) does not make every
// downstream order_by probe emit a false FAIL against the stale name.
const obWinner = obQuery.ok
  ? ORDER_CANDIDATES.find(([k, v]) => `${k}=${JSON.stringify(v)}` === obQuery.variant)
  : null;
const OB = obWinner ? obWinner[0] : null;
/** Re-express a list of field names in the winning variant's value shape. */
const obVal = (fields) => {
  const sample = obWinner[1][0];
  if (sample && typeof sample === "object") return fields.map((f) => ({ ...sample, field: f }));
  if (typeof sample === "string" && sample.includes(" ")) {
    const suffix = sample.slice(sample.indexOf(" "));
    return fields.map((f) => f + suffix);
  }
  return fields;
};
if (OB) {
  // Semantics: is the sorted page the top-`limit` window or the whole filtered set?
  const mk = (limit) => Q({ [OB]: obVal(["price"]), limit }).body;
  const wide = await call("entities/query", mk(200));
  const narrow = await call("entities/query", mk(5));
  const sameHead = ids(narrow.data) === ids(wide.data.slice(0, 5));
  info(2, `order_by semantics: limit=5 head ${sameHead ? "==" : "!="} limit=200 head -> ${sameHead ? "whole-set sort" : "window sort"}`, OB);
  // Descending?
  let desc = null;
  for (const [k, bad] of [["orderByType", 123], ["orderByDirection", 123], ["descending", { __p: 1 }], ["desc", { __p: 1 }], ["reverse", { __p: 1 }], ["sortOrder", 123]]) {
    if (await inStruct("entities/query", Q({ [OB]: obVal(["price"]) }).body, k, bad)) { desc = k; break; }
  }
  push(2, "order_by descending", desc ? "PASS" : "FAIL", desc ?? "no direction field in struct (asc only)");
  await probe(2, "order_by multi-field", [{ label: OB, ...Q({ [OB]: obVal(["average_rating", "price"]), outputFields: ["parent_asin", "price", "average_rating"] }) }],
    (r) => r.length > 1 && r.every((x, i) => i === 0 || x.average_rating >= r[i - 1].average_rating));
}

// ── 3 aggregation (entities/query with aggregate expressions in outputFields) ──
const A = (extra) => ({ path: "entities/query", body: { collectionName: COLLECTION, filter: "", ...extra } });
await probe(3, "aggregate count(*)", [{ label: "outputFields:count(*)", ...A({ outputFields: ["count(*)"] }) }],
  (r) => r.length === 1 && typeof r[0]["count(*)"] === "number");
await probe(3, "aggregate min/max/avg/sum (no count)", [
  { label: "outputFields:min|max|avg|sum", ...A({ outputFields: ["min(price)", "max(price)", "avg(price)", "sum(rating_number)"] }) },
], (r) => r.length === 1 && r[0]["min(price)"] != null && r[0]["max(price)"] != null);
await probe(3, "aggregate count(*) together with min/max", [
  { label: "count+min", ...A({ outputFields: ["count(*)", "min(price)"] }) },
], (r) => r.length === 1 && r[0]["count(*)"] != null && r[0]["min(price)"] != null);
await probe(3, "aggregate under a TEXT_MATCH filter", [
  { label: "text_match", ...A({ filter: 'TEXT_MATCH(text_snippet, "wireless earbuds")', outputFields: ["count(*)"] }) },
], (r) => r.length === 1 && r[0]["count(*)"] > 0);
// GROUP BY: every candidate name is silently dropped (a wrong-typed value is accepted too).
const groupNames = ["groupByFields", "group_by_fields", "groupBy", "group_by", "groupByField", "group_by_field"];
let groupName = null;
for (const g of groupNames) if (await inStruct("entities/query", A({ outputFields: ["count(*)"] }).body, g, "BOGUS")) { groupName = g; break; }
await probe(3, "aggregate count(*) grouped by main_category", groupNames.map((g) => ({
  label: g, ...A({ [g]: ["main_category"], outputFields: ["main_category", "count(*)"] }),
})), (r) => r.length > 1 && r[0]["count(*)"] != null);
push(3, "group-by field in the query request struct", groupName ? "PASS" : "FAIL", groupName ?? "not in struct");

// ── 4 highlighter ─────────────────────────────────────────────────────────────
const hlCamel = { type: "lexical", fields: ["text_snippet"], highlightSearchText: true, preTags: ["\u0001"], postTags: ["\u0002"], fragmentSize: 160, numOfFragments: 1 };
const hlSnake = { type: "lexical", fields: ["text_snippet"], highlight_search_text: true, pre_tags: ["\u0001"], post_tags: ["\u0002"], fragment_size: 160, num_of_fragments: 1 };
const hasHl = (_r, out) => JSON.stringify(out).includes("\\u0001");
const withSnippet = { outputFields: ["parent_asin", "title", "price", "store", "text_snippet"] };
const hlVariants = (mk) => [
  { label: "highlighter camel", ...mk({ highlighter: hlCamel, ...withSnippet }) },
  { label: "highlighter snake", ...mk({ highlighter: hlSnake, ...withSnippet }) },
  { label: "highlight camel", ...mk({ highlight: hlCamel, ...withSnippet }) },
  { label: "highlights camel", ...mk({ highlights: hlCamel, ...withSnippet }) },
  { label: "highlighter+query", ...mk({ highlighter: { ...hlCamel, query: "wireless earbuds" }, ...withSnippet }) },
  { label: "searchParams.highlighter", ...mk({ searchParams: { highlighter: hlCamel }, ...withSnippet }) },
  { label: "outputFields highlight()", ...mk({ outputFields: ["parent_asin", "highlight(text_snippet)"] }) },
];
await probe(4, "highlighter on sparse search", hlVariants(SP), hasHl);
await probe(4, "highlighter on hybrid_search", hlVariants(H), hasHl);
const hlNames = ["highlighter", "highlight", "highlights", "highlighting", "highlightFields", "highlighterParams"];
let hlName = null;
for (const n of hlNames) if (await inStruct("entities/search", SP({}).body, n, "BOGUS")) { hlName = n; break; }
push(4, "highlighter field in the search request struct", hlName ? "PASS" : "FAIL", hlName ?? "not in struct");

// ── 5 phrase match ────────────────────────────────────────────────────────────
const PM = 'PHRASE_MATCH(text_snippet, "wireless earbuds", 2)';
await probe(5, "PHRASE_MATCH filter on dense", [{ label: "expr", ...S({ filter: PM }) }], (r) => r.length > 0);
await probe(5, "PHRASE_MATCH filter on sparse", [{ label: "expr", ...SP({ filter: PM }) }], (r) => r.length > 0);
await probe(5, "PHRASE_MATCH filter on hybrid", [{ label: "expr", ...H({ search: [
  { data: [qv], annsField: "text_vec", limit: 20, filter: PM },
  { data: ["wireless earbuds"], annsField: "text_sparse", limit: 20, filter: PM },
] }) }], (r) => r.length > 0);
await probe(5, "TEXT_MATCH filter on query", [{ label: "expr", ...Q({ filter: 'TEXT_MATCH(text_snippet, "wireless earbuds")' }) }], (r) => r.length > 0);

// ── 6 grouping search ─────────────────────────────────────────────────────────
const distinctStores = (r) => r.length > 1 && new Set(r.map((x) => x.store)).size === r.length;
await probe(6, "group by store on search", [
  { label: "groupingField", ...S({ groupingField: "store", groupSize: 1, strictGroupSize: true }) },
], distinctStores);
await probe(6, "group by store on hybrid_search", [
  { label: "groupingField", ...H({ groupingField: "store", groupSize: 1, strictGroupSize: true }) },
], distinctStores);

// ── 7 decay / boost rerank ────────────────────────────────────────────────────
const decayParams = { reranker: "decay", function: "gauss", origin: 0, scale: 5, offset: 0, decay: 0.5 };
const fnScore = (params, field) => ({ functions: [{ name: "p", type: "Rerank", ...(field ? { inputFieldNames: [field] } : {}), params }] });
const decayVariants = (mk, field = "price", params = decayParams) => [
  { label: "functionScore(type:Rerank)", ...mk({ functionScore: fnScore(params, field) }) },
  { label: "function_score", ...mk({ function_score: { functions: [{ name: "p", type: "Rerank", input_field_names: [field], params }] } }) },
  { label: "rerank.strategy=decay", ...mk({ rerank: { strategy: "decay", params: { ...params, input_field_names: [field] } } }) },
  { label: "ranker", ...mk({ ranker: { strategy: "decay", params: { ...params, input_field_names: [field] } } }) },
];
const searchBaseline = ids((await call("entities/search", S({ filter: "price > 0" }).body)).data);
const hybridBaseline = ids((await call("entities/hybrid_search", H({}).body)).data);
const reordered = (r) => r.length > 0 && ids(r) !== searchBaseline;
const hReordered = (r) => r.length > 0 && ids(r) !== hybridBaseline;

const dec = await probe(7, "decay rerank on price (search)", decayVariants((x) => S({ filter: "price > 0", ...x })), reordered);
await probe(7, "decay rerank on price (hybrid_search)", decayVariants(H), hReordered);
if (dec.ok) {
  // Only the winning style can answer this — the others are silently dropped, so a
  // "success" from them would be a false PASS.
  const tsParams = { reranker: "decay", function: "gauss", origin: 1772668800, scale: 2592000, decay: 0.5 };
  const tsShape = { outputFields: ["parent_asin", "first_seen"] };
  // Baseline must come from the SAME request minus the reranker — comparing against a
  // differently-filtered baseline would score "reordered" even if decay were ignored.
  const tsBaseline = ids((await call("entities/search", S(tsShape).body)).data);
  await probe(7, "decay rerank on TIMESTAMPTZ first_seen", decayVariants(
    (x) => S({ ...tsShape, ...x }), "first_seen", tsParams,
  ).filter((v) => v.label === dec.variant), (r) => r.length > 0 && ids(r) !== tsBaseline);
  // Does functionScore STACK on the weighted/rrf fusion, or replace it?
  const withW = ids((await call("entities/hybrid_search", H({ functionScore: fnScore(decayParams, "price") }).body)).data);
  const withR = ids((await call("entities/hybrid_search", H({ rerank: { strategy: "rrf", params: { k: 60 } }, functionScore: fnScore(decayParams, "price") }).body)).data);
  const alone = ids((await call("entities/hybrid_search", { ...H({}).body, rerank: undefined, functionScore: fnScore(decayParams, "price") })).data);
  const stacks = !(withW === withR && withW === alone);
  info(7, `decay + fusion on hybrid: weighted/rrf/none give ${stacks ? "DIFFERENT" : "IDENTICAL"} results -> functionScore ${stacks ? "stacks on" : "REPLACES"} the rerank fusion`, "functionScore");
  await probe(7, "two rerank functions in one functionScore", [
    { label: "weighted+decay", ...H({ functionScore: { functions: [
      { name: "w", type: "Rerank", params: { reranker: "weighted", weights: [0.6, 0.4], norm_score: true } },
      { name: "d", type: "Rerank", inputFieldNames: ["price"], params: decayParams },
    ] } }) },
  ], hReordered);
  await probe(7, "weighted fusion expressed via functionScore", [
    { label: "reranker:weighted", ...H({ rerank: undefined, functionScore: fnScore({ reranker: "weighted", weights: [0.6, 0.4], norm_score: true }) }) },
  ], (r) => ids(r) === hybridBaseline);
  // Which `params.reranker` values does this build accept? The server does NOT enumerate them,
  // so each candidate is sent on its own: "unsupported reranker <x>" means the name is unknown;
  // ANY other error (missing/invalid params for that reranker) means the name IS known.
  // `__bogus__` is the control that proves the rejection message is the discriminator.
  const RERANKER_CANDIDATES = ["weighted", "rrf", "decay", "model", "boost", "normalize", "chain", "score", "__bogus__"];
  const acceptedRerankers = [];
  for (const rk of RERANKER_CANDIDATES) {
    const { text } = await rawCall("entities/hybrid_search", H({ functionScore: fnScore({ reranker: rk }, "price") }).body);
    if (!text.includes(`unsupported reranker ${rk}`)) acceptedRerankers.push(rk);
    if (VERBOSE) console.log(`  7 reranker=${rk}: ${text.slice(0, 180)}`);
  }
  const controlRejected = !acceptedRerankers.includes("__bogus__");
  push(7, "params.reranker values accepted (probed name-by-name; server does not enumerate)",
    controlRejected && acceptedRerankers.length > 0 ? "PASS" : "FAIL",
    acceptedRerankers.join("|") || "none", `control __bogus__ ${controlRejected ? "rejected" : "ACCEPTED - test invalid"}`);
  // The decay `function` enum, by contrast, IS enumerated by the server's own error text.
  const fnErr = (await rawCall("entities/search", S({ filter: "price > 0", functionScore: fnScore({ ...decayParams, function: "__bogus__" }, "price") }).body)).text;
  const fnEnum = fnErr.match(/must be one of \[([^\]]+)\]/);
  push(7, "decay `function` values accepted (from the server's own error text)",
    fnEnum ? "PASS" : "FAIL", fnEnum ? fnEnum[1].split(/,\s*/).join("|") : "server did not enumerate");

  await probe(7, "boost reranker (filter + weight)", [
    { label: "reranker:boost", ...S({ filter: "price > 0", functionScore: fnScore({ reranker: "boost", weight: 2.0, filter: "price < 10" }) }) },
  ], reordered);
}

// ── 8 dates ───────────────────────────────────────────────────────────────────
await probe(8, "TIMESTAMPTZ filter + output", [
  { label: "ISO literal", ...S({ filter: "first_seen > ISO '2026-08-01T00:00:00Z'", outputFields: ["parent_asin", "first_seen"] }) },
  { label: "bare literal", ...S({ filter: "first_seen > '2026-08-01T00:00:00Z'", outputFields: ["parent_asin", "first_seen"] }) },
], (r) => r.length > 0 && typeof r[0].first_seen === "string");
if (OB) await probe(8, "order_by first_seen (TIMESTAMPTZ)", [
  { label: OB, ...Q({ [OB]: obVal(["first_seen"]), filter: "", outputFields: ["parent_asin", "first_seen"] }) },
], (r) => r.length > 1);

// ── 9 geo ─────────────────────────────────────────────────────────────────────
const EU = ["London", "Manchester", "Paris", "Brussels", "Amsterdam", "Dublin"];
await probe(9, "st_dwithin filter + GEOMETRY output", [
  { label: "st_dwithin", ...S({ filter: "st_dwithin(store_location, 'POINT (-0.1276 51.5072)', 400000)", outputFields: ["parent_asin", "store_city", "store_location"] }) },
], (r) => r.length > 0 && r.every((x) => EU.includes(x.store_city)));

// ── 10 rrf ────────────────────────────────────────────────────────────────────
await probe(10, "rrf hybrid", [{ label: "rrf", ...H({ rerank: { strategy: "rrf", params: { k: 60 } } }) }], (r) => r.length > 0);

// ── 11 run_analyzer ───────────────────────────────────────────────────────────
const raPaths = ["collections/run_analyzer", "entities/run_analyzer", "collections/fields/run_analyzer", "run_analyzer", "collections/runAnalyzer", "texts/run_analyzer"];
let raRouted = null;
for (const p of raPaths) {
  const r = await rawCall(p, { collectionName: COLLECTION, fieldName: "text_syn", text: ["wireless tablet"] });
  if (VERBOSE) console.log(`  11 ${p}: HTTP ${r.status} ${r.text.slice(0, 60)}`);
  if (r.status !== 404) { raRouted = p; break; }
}
push(11, "run_analyzer over REST v2", raRouted ? "PASS" : "FAIL", raRouted ?? "404 on every candidate path");

// ── 12 index type ─────────────────────────────────────────────────────────────
const idx = await probe(12, "indexes/describe text_vec", [
  { label: "indexName=text_vec", path: "indexes/describe", body: { collectionName: COLLECTION, indexName: "text_vec" } },
], (r) => r.length > 0 && typeof r[0].indexType === "string");
if (idx.ok) info(12, `index type field: indexType="${idx.rows[0].indexType}" metricType="${idx.rows[0].metricType}"`, "indexType");

// ── caps: are the serverless limit/offset clamps still needed? ─────────────────
const capOk = async (limit, offset) => {
  try { await call("entities/search", { collectionName: COLLECTION, data: [qv], annsField: "text_vec", limit, offset, outputFields: ["parent_asin"] }); return true; }
  catch { return false; }
};
info(0, `caps: limit=1024 ${await capOk(1024, 0) ? "ok" : "rejected"}, limit=16384 ${await capOk(16384, 0) ? "ok" : "rejected"}, limit+offset=16500 ${await capOk(1000, 15500) ? "ok" : "rejected"}`, "entities/search");

// 0 embedding parity is run separately (needs Workers AI) — see Task 3 Step 3.

console.table(results.map(({ id, name, status, variant, shape }) => ({ id, name, status, variant, shape })));

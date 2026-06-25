import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Diagnostics,
  Facets,
  Filters,
  ParsedQuery,
  Product,
  SearchRequest,
  SortKey,
} from "./lib/types";
import { PAGE_SIZE, POOL_SIZE, DEFAULT_HYBRID_ALPHA } from "./lib/config";
import { loadFacets, search } from "./lib/searchClient";
import { Header } from "./components/Header";
import { BlendSlider } from "./components/BlendSlider";
import { FilterPanel } from "./components/FilterPanel";
import { ProductGrid } from "./components/ProductGrid";
import { Pagination } from "./components/Pagination";
import { LoadingGrid, EmptyState, ErrorState } from "./components/States";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { InterpretationNote } from "./components/InterpretationNote";
import { SimilarNote } from "./components/SimilarNote";
import { XIcon } from "./components/icons";

// Merge implied filters into the current ones, returning the SAME reference when nothing
// actually changes — so adopting an already-applied interpretation doesn't refetch.
function mergeImplied(prev: Filters, implied: Filters): Filters {
  const next = { ...prev, ...implied };
  for (const k of Object.keys(implied) as (keyof Filters)[]) {
    if (prev[k] !== next[k]) return next;
  }
  return prev;
}

// The homepage runs this query on first load instead of an empty browse.
const DEFAULT_QUERY = "pink headphones for kids with ears under $20";

function countActive(f: Filters): number {
  let n = 0;
  if (f.priceMin != null) n++;
  if (f.priceMax != null) n++;
  if (f.minRating != null) n++;
  if (f.minReviews) n++;
  if (f.category) n++;
  n += f.brands?.length ?? 0;
  return n;
}

export function App() {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [query, setQuery] = useState(DEFAULT_QUERY); // search box text (not yet submitted)
  const [committedQuery, setCommittedQuery] = useState(DEFAULT_QUERY); // the submitted query that drives search
  const [filters, setFilters] = useState<Filters>({});
  const [sort, setSort] = useState<SortKey>("relevance");
  // Dense/semantic blend (α): a global relevance preference that persists across queries,
  // "More like this", and clear — only sent (and shown) in search mode.
  const [alpha, setAlpha] = useState(DEFAULT_HYBRID_ALPHA);
  const [page, setPage] = useState(0);
  const [nonce, setNonce] = useState(0);

  const [similarTo, setSimilarTo] = useState<Product | null>(null); // "More like this" seed
  const [results, setResults] = useState<Product[]>([]);
  const [total, setTotal] = useState<number | null>(null); // sorted-pool size, when sorting
  const [mode, setMode] = useState<"search" | "browse" | "similar">("browse");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [interpretation, setInterpretation] = useState<ParsedQuery | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const reqId = useRef(0);
  // The raw query text we've already run understanding on — so we don't re-run the LLM on
  // filter/sort/page changes, only when the query text itself changes.
  const lastUnderstood = useRef("");
  // The cleaned query to embed on follow-up fetches (filter/sort/page changes). The box
  // keeps the user's original text, but we still search the clean text so the stripped
  // filter phrases ("under $60") don't pollute the embedding. Empty until understood.
  const embedText = useRef("");
  const activeFilters = useMemo(() => countActive(filters), [filters]);

  useEffect(() => {
    loadFacets().then(setFacets).catch(() => setFacets(null));
  }, []);

  // Reset to first page whenever the committed query, similar seed, filters, or sort change.
  useEffect(() => {
    setPage(0);
  }, [committedQuery, similarTo, filters, sort, alpha]);

  // Fetch on any input change. reqId guards against out-of-order responses.
  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const rawQ = committedQuery.trim();
    // Only invoke the understanding LLM when the committed query text is new (never in
    // similar mode, which seeds from stored vectors rather than an embedded query).
    const understand = !similarTo && rawQ !== "" && rawQ !== lastUnderstood.current;
    // On the understanding pass, send the raw query so the proxy can extract filters from
    // it. On follow-up fetches, send the cleaned text so the embedding stays filter-free.
    // Empty committed query = browse, regardless of any stale cleaned text.
    const q = rawQ === "" ? "" : understand ? rawQ : embedText.current || rawQ;
    const request: SearchRequest = similarTo
      ? {
          similarTo: similarTo.parent_asin,
          filters,
          sort,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }
      : {
          q: q || undefined,
          filters,
          sort,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          understand,
          // Blend only applies to a real query search (BM25 needs query text); omit for browse.
          ...(rawQ !== "" ? { alpha } : {}),
        };
    const started = performance.now();
    search(request)
      .then((res) => {
        if (id !== reqId.current) return;
        setResults(res.results);
        setTotal(res.total ?? null);
        setMode(res.mode);
        setDiag({ request, response: res, clientMs: Math.round(performance.now() - started) });

        // Adopt the proxy's interpretation: keep the user's original text in the box, but
        // remember the cleaned query to embed on follow-up fetches, and merge implied
        // filters into the rail. Marking rawQ as understood stops the LLM re-running.
        const parsed = res.parsed;
        if (understand && parsed) {
          lastUnderstood.current = rawQ;
          embedText.current = parsed.cleanedQuery;
          const hasImplied = Object.keys(parsed.filters).length > 0;
          // Only surface a note when something was actually extracted or cleaned —
          // otherwise an unchanged query would still show an empty interpretation.
          if (parsed.applied && (hasImplied || parsed.cleanedQuery !== rawQ)) {
            if (hasImplied) setFilters((prev) => mergeImplied(prev, parsed.filters));
            setInterpretation(parsed);
          }
        }
      })
      .catch((e: unknown) => {
        if (id !== reqId.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setResults([]);
        setTotal(null);
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [committedQuery, similarTo, filters, sort, alpha, page, nonce]);

  const patch = (p: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...p }));
  const clearFilters = () => {
    setFilters({});
    setInterpretation(null);
  };
  const retry = () => setNonce((n) => n + 1);

  // "More like this": switch to similarity mode seeded by this product. Starts from a clean
  // slate (no query text, no filters) so results reflect the product, not the prior query.
  const moreLikeThis = (p: Product) => {
    embedText.current = "";
    lastUnderstood.current = "";
    setQuery("");
    setCommittedQuery("");
    setInterpretation(null);
    setFilters({});
    setSimilarTo(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Typing only updates the box — it does not search. Editing clears the prior note.
  const handleUserQuery = (v: string) => {
    setQuery(v);
    if (interpretation) setInterpretation(null);
  };
  // Enter or the Search button commits the current box text. A new query starts with a
  // clean filter slate (so the prior query's implied filters don't leak in); re-submitting
  // the same text keeps filters and just refetches.
  const submitSearch = () => {
    const q = query.trim();
    setSimilarTo(null); // a typed search always leaves "More like this" mode
    if (q === committedQuery && !similarTo) {
      setNonce((n) => n + 1);
    } else {
      embedText.current = ""; // new query text — embed it raw until re-understood
      setFilters({});
      setInterpretation(null);
      setCommittedQuery(q);
    }
  };
  // The clear (×) button resets to a pristine browse (empty query, no filters).
  const clearSearch = () => {
    embedText.current = "";
    setQuery("");
    setCommittedQuery("");
    setFilters({});
    setInterpretation(null);
    setSimilarTo(null);
  };

  // When sorting, the proxy returns the sorted-pool size as `total`, so pagination is bounded
  // by it; relevance mode has no total and uses the page-full heuristic (unbounded paging).
  const hasNext =
    total != null ? (page + 1) * PAGE_SIZE < total : results.length === PAGE_SIZE;

  // The blend control is only meaningful in search mode (a committed query, not similarity).
  const showBlend = committedQuery.trim() !== "" && !similarTo;

  const summary = () => {
    if (loading) return "Searching…";
    // On a sorted page, report the pool count (with "+" when the pool was truncated at the
    // sort-depth cap); otherwise the page count (with "+" when another page follows).
    const truncated = total != null && total >= POOL_SIZE;
    const count = total != null ? total : results.length;
    const plus = total != null ? (truncated ? "+" : "") : hasNext ? "+" : "";
    if (mode === "similar") {
      return `${count}${plus} product${count === 1 ? "" : "s"} similar to “${similarTo?.title ?? ""}”`;
    }
    if (mode === "search") {
      const base = `${count}${plus} match${count === 1 ? "" : "es"} for “${committedQuery.trim()}”`;
      return sort === "relevance" ? base : `${base} · sorted across matches`;
    }
    return `Browsing ${count}${plus} product${count === 1 ? "" : "s"}`;
  };

  return (
    <div className="min-h-screen">
      <Header
        query={query}
        onQuery={handleUserQuery}
        onSubmit={submitSearch}
        onClear={clearSearch}
        sort={sort}
        onSort={setSort}
        onOpenFilters={() => setDrawerOpen(true)}
        activeFilters={activeFilters}
        alpha={alpha}
        onAlpha={setAlpha}
        showBlend={showBlend}
      />

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:py-10">
        <div className="lg:grid lg:grid-cols-[256px_1fr] lg:gap-10">
          {/* Desktop filter rail */}
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold text-ink">Filters</h2>
                {activeFilters > 0 && (
                  <button
                    onClick={clearFilters}
                    className="text-xs font-semibold text-accent hover:text-accent-hover"
                  >
                    Clear all ({activeFilters})
                  </button>
                )}
              </div>
              {facets ? (
                <FilterPanel facets={facets} filters={filters} onChange={patch} />
              ) : (
                <p className="text-sm text-faint">Loading filters…</p>
              )}
            </div>
          </aside>

          {/* Results */}
          <section>
            {similarTo ? (
              <SimilarNote product={similarTo} onClear={clearSearch} />
            ) : interpretation ? (
              <InterpretationNote
                parsed={interpretation}
                onDismiss={() => setInterpretation(null)}
              />
            ) : null}

            <div className="mb-5 flex items-baseline justify-between gap-4">
              <p className="text-sm text-muted" aria-live="polite">
                {summary()}
              </p>
            </div>

            {error ? (
              <ErrorState message={error} onRetry={retry} />
            ) : loading ? (
              <LoadingGrid />
            ) : results.length === 0 ? (
              <EmptyState query={committedQuery.trim()} />
            ) : (
              <>
                <ProductGrid products={results} onMoreLikeThis={moreLikeThis} />
                <Pagination page={page} hasNext={hasNext} onPage={setPage} />
              </>
            )}
          </section>
        </div>

        {diag && <DiagnosticsPanel diag={diag} />}
      </main>

      {/* Mobile filter drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/30 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-[88%] max-w-sm flex-col bg-paper shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="font-display text-lg font-semibold">Filters</h2>
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Close filters"
                className="rounded-full p-1.5 text-muted hover:bg-surface"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-2">
              {showBlend && (
                <div className="mb-4 border-b border-line pb-4 pt-2">
                  <BlendSlider alpha={alpha} onChange={setAlpha} />
                </div>
              )}
              {facets && <FilterPanel facets={facets} filters={filters} onChange={patch} />}
            </div>
            <div className="flex gap-3 border-t border-line px-5 py-4">
              {activeFilters > 0 && (
                <button
                  onClick={clearFilters}
                  className="rounded-full border border-line px-4 py-2.5 text-sm font-semibold text-ink"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setDrawerOpen(false)}
                className="flex-1 rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-paper transition-colors hover:bg-accent"
              >
                Show results
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Pagination({
  page,
  hasNext,
  onPage,
}: {
  page: number;
  hasNext: boolean;
  onPage: (p: number) => void;
}) {
  if (page === 0 && !hasNext) return null;
  const btn =
    "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-5 py-2 text-sm font-semibold text-ink transition-colors enabled:hover:border-accent enabled:hover:text-accent disabled:cursor-not-allowed disabled:text-faint";
  return (
    <nav className="mt-10 flex items-center justify-center gap-3" aria-label="Pagination">
      <button className={btn} onClick={() => onPage(page - 1)} disabled={page === 0}>
        ← Previous
      </button>
      <span className="px-2 text-sm text-muted tabular-nums">Page {page + 1}</span>
      <button className={btn} onClick={() => onPage(page + 1)} disabled={!hasNext}>
        Next →
      </button>
    </nav>
  );
}

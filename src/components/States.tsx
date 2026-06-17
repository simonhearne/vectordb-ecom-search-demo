import { SearchIcon } from "./icons";

export function LoadingGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface"
        >
          <div className="skeleton aspect-square" />
          <div className="space-y-2.5 p-4">
            <div className="skeleton h-3.5 w-full rounded" />
            <div className="skeleton h-3.5 w-2/3 rounded" />
            <div className="skeleton h-3 w-1/3 rounded" />
            <div className="skeleton mt-2 h-5 w-1/2 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-line bg-surface/60 px-6 py-20 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
        <SearchIcon className="h-6 w-6" />
      </div>
      <p className="font-display text-xl text-ink">No matching products</p>
      <p className="mt-1.5 max-w-sm text-sm text-muted">
        {query
          ? `Nothing came back for “${query}” with these filters. Try broadening your search or clearing a filter.`
          : "No products match the current filters. Try clearing one."}
      </p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-line bg-surface px-6 py-20 text-center">
      <p className="font-display text-xl text-ink">Something went wrong</p>
      <p className="mt-1.5 max-w-md break-words text-sm text-muted">{message}</p>
      <button
        onClick={onRetry}
        className="mt-5 rounded-full bg-ink px-5 py-2 text-sm font-semibold text-paper transition-colors hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}

import type { ParsedQuery } from "../lib/types";
import { XIcon } from "./icons";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

// Human-readable chips for the filters the query implied.
function chips(parsed: ParsedQuery): string[] {
  const f = parsed.filters;
  const out: string[] = [];
  if (f.priceMin != null && f.priceMax != null) out.push(`${money(f.priceMin)}–${money(f.priceMax)}`);
  else if (f.priceMax != null) out.push(`under ${money(f.priceMax)}`);
  else if (f.priceMin != null) out.push(`over ${money(f.priceMin)}`);
  if (f.minRating != null) out.push(`★ ${f.minRating}+`);
  if (f.minReviews != null) out.push(`${new Intl.NumberFormat("en-US").format(f.minReviews)}+ reviews`);
  return out;
}

export function InterpretationNote({
  parsed,
  onDismiss,
}: {
  parsed: ParsedQuery;
  onDismiss: () => void;
}) {
  const tags = chips(parsed);
  const rewrote = parsed.cleanedQuery !== parsed.originalQuery;
  if (!tags.length && !rewrote) return null;

  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-accent/25 bg-accent-soft/60 px-4 py-3 text-sm">
      <span className="mt-0.5 shrink-0 text-accent" aria-hidden="true">✦</span>
      <div className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-muted">
        <span>
          Read <span className="font-medium text-ink">“{parsed.originalQuery}”</span> as
        </span>
        <span className="rounded-full bg-surface px-2.5 py-0.5 font-medium text-ink">
          {parsed.cleanedQuery}
        </span>
        {tags.map((t) => (
          <span
            key={t}
            className="rounded-full bg-surface px-2.5 py-0.5 font-medium text-accent tabular-nums"
          >
            {t}
          </span>
        ))}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss interpretation"
        className="shrink-0 rounded-full p-1 text-faint transition-colors hover:text-ink"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

import type { Product } from "../lib/types";
import { SimilarIcon, XIcon } from "./icons";

// Banner shown while in "More like this" mode — names the seed product and offers an exit.
export function SimilarNote({
  product,
  onClear,
}: {
  product: Product;
  onClear: () => void;
}) {
  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-accent/25 bg-accent-soft/60 px-4 py-3 text-sm">
      <span className="mt-0.5 shrink-0 text-accent" aria-hidden="true">
        <SimilarIcon className="h-4 w-4" />
      </span>
      <div className="flex-1 text-muted">
        Showing products similar to{" "}
        <span className="font-medium text-ink">“{product.title}”</span>
      </div>
      <button
        onClick={onClear}
        aria-label="Clear similar search"
        className="shrink-0 rounded-full p-1 text-faint transition-colors hover:text-ink"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

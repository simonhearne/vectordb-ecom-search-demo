import { useState } from "react";
import type { Product } from "../lib/types";
import { hasPrice } from "../lib/types";
import { Stars } from "./Stars";
import { ImageOffIcon, SimilarIcon } from "./icons";

const priceFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const countFmt = new Intl.NumberFormat("en-US");

export function ProductCard({
  product,
  index,
  onMoreLikeThis,
}: {
  product: Product;
  index: number;
  onMoreLikeThis?: (p: Product) => void;
}) {
  const [broken, setBroken] = useState(false);
  const p = product;

  return (
    <article
      className="rise group flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface transition-all duration-300 hover:-translate-y-1 hover:border-[#dccfc2] hover:shadow-[0_14px_40px_-18px_rgba(27,26,23,0.4)]"
      style={{ animationDelay: `${Math.min(index, 11) * 40}ms` }}
    >
      <div className="relative aspect-square overflow-hidden border-b border-line bg-[#f6f2ec]">
        {p.image_url && !broken ? (
          <img
            src={p.image_url}
            alt={p.title}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-contain p-4 transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-faint">
            <ImageOffIcon className="h-9 w-9" />
            <span className="text-xs">No image</span>
          </div>
        )}
        {p.store && (
          <span className="absolute left-3 top-3 max-w-[70%] truncate rounded-full bg-surface/85 px-2.5 py-1 text-[11px] font-semibold text-muted backdrop-blur-sm">
            {p.store}
          </span>
        )}
        {onMoreLikeThis && (
          <button
            type="button"
            onClick={() => onMoreLikeThis(p)}
            title="Find similar products"
            className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-surface/90 px-3 py-1.5 text-[11px] font-semibold text-ink opacity-0 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-ink hover:text-paper focus-visible:opacity-100 group-hover:opacity-100"
          >
            <SimilarIcon className="h-3.5 w-3.5" />
            More like this
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <h3
          className="line-clamp-2 text-[0.95rem] font-medium leading-snug text-ink"
          title={p.title}
        >
          {p.title}
        </h3>

        <div className="flex items-center gap-2 text-xs text-muted">
          {typeof p.average_rating === "number" && p.average_rating > 0 ? (
            <>
              <Stars rating={p.average_rating} />
              <span className="tabular-nums">{p.average_rating.toFixed(1)}</span>
              {typeof p.rating_number === "number" && (
                <span className="text-faint">({countFmt.format(p.rating_number)})</span>
              )}
            </>
          ) : (
            <span className="text-faint">No ratings yet</span>
          )}
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          {hasPrice(p.price) ? (
            <span className="font-display text-xl font-medium text-ink tabular-nums">
              {priceFmt.format(p.price)}
            </span>
          ) : (
            <span className="text-sm text-faint">Price unavailable</span>
          )}
          {typeof p.score === "number" && (
            <span
              className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent tabular-nums"
              title="Relevance score"
            >
              {p.score.toFixed(2)}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

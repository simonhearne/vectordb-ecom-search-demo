import type { Facets, Filters } from "../lib/types";
import { RATING_OPTIONS, REVIEW_OPTIONS } from "../lib/config";
import { Stars } from "./Stars";
import { ChevronDown } from "./icons";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line py-5 first:pt-0 last:border-b-0">
      <h3 className="eyebrow mb-3">{title}</h3>
      {children}
    </section>
  );
}

const priceFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function FilterPanel({
  facets,
  filters,
  onChange,
}: {
  facets: Facets;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const maxValue = filters.priceMax ?? facets.priceMax;

  const toggleBrand = (brand: string) => {
    const set = new Set(filters.brands ?? []);
    set.has(brand) ? set.delete(brand) : set.add(brand);
    onChange({ brands: [...set] });
  };

  return (
    <div className="text-sm">
      <Section title="Price (USD)">
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            placeholder={String(facets.priceMin)}
            value={filters.priceMin ?? ""}
            onChange={(e) =>
              onChange({ priceMin: e.target.value === "" ? null : Number(e.target.value) })
            }
            aria-label="Minimum price"
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-ink focus:border-accent focus:outline-none"
          />
          <span className="text-faint">–</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            placeholder={String(facets.priceMax)}
            value={filters.priceMax ?? ""}
            onChange={(e) =>
              onChange({ priceMax: e.target.value === "" ? null : Number(e.target.value) })
            }
            aria-label="Maximum price"
            className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-ink focus:border-accent focus:outline-none"
          />
        </div>
        <input
          type="range"
          min={facets.priceMin}
          max={facets.priceMax}
          step={1}
          value={maxValue}
          onChange={(e) => onChange({ priceMax: Number(e.target.value) })}
          aria-label="Maximum price slider"
          className="mt-4 w-full"
        />
        <div className="mt-1.5 flex justify-between text-xs text-faint tabular-nums">
          <span>{priceFmt.format(facets.priceMin)}</span>
          <span className="font-semibold text-muted">up to {priceFmt.format(maxValue)}</span>
          <span>{priceFmt.format(facets.priceMax)}</span>
        </div>
      </Section>

      <Section title="Customer rating">
        <div className="flex flex-col gap-1">
          {RATING_OPTIONS.map((r) => {
            const active = filters.minRating === r;
            return (
              <button
                key={r}
                onClick={() => onChange({ minRating: active ? null : r })}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                  active ? "bg-accent-soft text-accent" : "hover:bg-paper"
                }`}
              >
                <Stars rating={r} />
                <span className={active ? "font-semibold" : "text-muted"}>&amp; up</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Brand">
        <div className="-mr-1 max-h-56 space-y-0.5 overflow-y-auto pr-1">
          {facets.brands.map((brand) => {
            const checked = filters.brands?.includes(brand) ?? false;
            return (
              <label
                key={brand}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-paper"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleBrand(brand)}
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className={`truncate ${checked ? "font-semibold text-ink" : "text-muted"}`}>
                  {brand}
                </span>
              </label>
            );
          })}
        </div>
      </Section>

      <Section title="Category">
        <div className="relative">
          <select
            value={filters.category ?? ""}
            onChange={(e) => onChange({ category: e.target.value || null })}
            className="w-full appearance-none rounded-lg border border-line bg-surface py-2 pl-2.5 pr-8 text-ink focus:border-accent focus:outline-none"
          >
            <option value="">All categories</option>
            {facets.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        </div>
      </Section>

      <Section title="Minimum reviews">
        <div className="grid grid-cols-4 gap-1.5">
          {REVIEW_OPTIONS.map((o) => {
            const active = (filters.minReviews ?? 0) === o.value;
            return (
              <button
                key={o.value}
                onClick={() => onChange({ minReviews: o.value || null })}
                aria-pressed={active}
                className={`rounded-lg border px-1 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line text-muted hover:border-[#dccfc2]"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

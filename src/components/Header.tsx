import type { SortKey } from "../lib/types";
import { SORT_OPTIONS, REPO_URL } from "../lib/config";
import { SearchIcon, SlidersIcon, ChevronDown, XIcon, GitHubIcon } from "./icons";
import { BlendSlider } from "./BlendSlider";

function GitHubLink() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Fork this project on GitHub"
      title="Fork on GitHub"
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink shadow-sm transition-colors hover:border-accent hover:text-accent"
    >
      <GitHubIcon className="h-[18px] w-[18px]" />
      <span className="hidden lg:inline">Fork on GitHub</span>
    </a>
  );
}

function SearchBar({
  value,
  onChange,
  onSubmit,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}) {
  return (
    <form
      role="search"
      className="flex flex-1 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="relative flex-1">
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-faint" />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Search products"
          className="w-full rounded-full border border-line bg-surface py-2.5 pl-11 pr-10 text-[0.95rem] text-ink placeholder:text-faint shadow-sm transition-colors focus:border-accent focus:outline-none"
        />
        {value && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-faint transition-colors hover:text-ink"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      <button
        type="submit"
        className="shrink-0 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover focus:outline-none"
      >
        Search
      </button>
    </form>
  );
}

function SortSelect({ sort, onSort }: { sort: SortKey; onSort: (s: SortKey) => void }) {
  return (
    <div className="relative shrink-0">
      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as SortKey)}
        aria-label="Sort results"
        className="appearance-none rounded-full border border-line bg-surface py-2.5 pl-4 pr-9 text-sm font-medium text-ink shadow-sm transition-colors hover:border-accent focus:border-accent focus:outline-none"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
    </div>
  );
}

function FiltersButton({
  onOpen,
  activeFilters,
}: {
  onOpen: () => void;
  activeFilters: number;
}) {
  return (
    <button
      onClick={onOpen}
      className="relative inline-flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink shadow-sm"
    >
      <SlidersIcon className="h-4 w-4" />
      Filters
      {activeFilters > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white">
          {activeFilters}
        </span>
      )}
    </button>
  );
}

export function Header({
  query,
  onQuery,
  onSubmit,
  onClear,
  sort,
  onSort,
  onOpenFilters,
  activeFilters,
  alpha,
  onAlpha,
  showBlend,
}: {
  query: string;
  onQuery: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onOpenFilters: () => void;
  activeFilters: number;
  alpha: number;
  onAlpha: (a: number) => void;
  showBlend: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur-md">
      <div className="mx-auto max-w-[1400px] px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3 sm:gap-5">
          <a href="/" className="flex shrink-0 items-baseline gap-1.5">
            <span className="font-display text-2xl font-semibold tracking-tight text-ink">
              Lumen
            </span>
            <span className="hidden text-xs font-medium text-faint sm:inline">
              vector search
            </span>
          </a>

          {/* desktop search + sort */}
          <div className="hidden flex-1 md:flex">
            <SearchBar value={query} onChange={onQuery} onSubmit={onSubmit} onClear={onClear} />
          </div>
          {showBlend && (
            <div className="hidden w-44 md:block">
              <BlendSlider alpha={alpha} onChange={onAlpha} />
            </div>
          )}
          <div className="hidden md:block">
            <SortSelect sort={sort} onSort={onSort} />
          </div>
          <div className="hidden md:block">
            <GitHubLink />
          </div>

          {/* mobile sort + filters */}
          <div className="ml-auto flex items-center gap-2 md:hidden">
            <GitHubLink />
            <SortSelect sort={sort} onSort={onSort} />
            <FiltersButton onOpen={onOpenFilters} activeFilters={activeFilters} />
          </div>
        </div>

        {/* mobile search row */}
        <div className="mt-3 md:hidden">
          <SearchBar value={query} onChange={onQuery} onSubmit={onSubmit} onClear={onClear} />
        </div>
      </div>
    </header>
  );
}

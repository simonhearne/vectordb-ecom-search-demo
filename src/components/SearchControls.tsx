import type { Boost, Fusion } from "../lib/types";
import { BOOST_OPTIONS, FUSION_OPTIONS } from "../lib/config";
import { ChevronDown } from "./icons";

function Toggle({ label, on, onChange, title }: { label: string; on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={title}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
        on ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-muted hover:border-accent"
      }`}
    >
      {label}
    </button>
  );
}

// Milvus 3.0 search controls: fusion strategy, synonym analyzer, brand grouping, decay boost.
// Shown only in search mode (alongside the blend slider).
export function SearchControls({
  fusion, onFusion, synonyms, onSynonyms, groupByBrand, onGroupByBrand, boost, onBoost, boostDisabledReason,
}: {
  fusion: Fusion; onFusion: (f: Fusion) => void;
  synonyms: boolean; onSynonyms: (v: boolean) => void;
  groupByBrand: boolean; onGroupByBrand: (v: boolean) => void;
  boost: Boost | null; onBoost: (b: Boost | null) => void;
  boostDisabledReason?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label="Fusion strategy" className="flex overflow-hidden rounded-full border border-line bg-surface text-xs font-semibold">
        {FUSION_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={fusion === o.key}
            onClick={() => onFusion(o.key)}
            className={`px-3 py-1.5 ${fusion === o.key ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <Toggle label="Synonyms" on={synonyms} onChange={onSynonyms} title="BM25 over the synonym-expanded analyzer (text_syn_sparse)" />
      <Toggle label="One per brand" on={groupByBrand} onChange={onGroupByBrand} title="group_by_field=store, group_size=1" />
      <div className="relative" title={boostDisabledReason}>
        <select
          value={boost ?? ""}
          disabled={!!boostDisabledReason}
          onChange={(e) => onBoost((e.target.value || null) as Boost | null)}
          aria-label="Boost"
          className="appearance-none rounded-full border border-line bg-surface py-1.5 pl-3 pr-8 text-xs font-semibold text-ink disabled:opacity-50"
        >
          {BOOST_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
      </div>
    </div>
  );
}

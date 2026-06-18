import { useState } from "react";
import type { Diagnostics } from "../lib/types";
import { ChevronDown } from "./icons";

function Metric({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className={`text-sm text-ink ${mono ? "font-mono break-all" : ""}`}>{value}</span>
    </div>
  );
}

const ms = (v?: number) => (typeof v === "number" ? `${v} ms` : "—");

export function DiagnosticsPanel({ diag }: { diag: Diagnostics }) {
  const [open, setOpen] = useState(true);
  const { request, response, clientMs } = diag;
  const d = response.debug;
  const parsed = response.parsed;
  const q = request.q?.trim();

  return (
    <section className="mt-12 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors hover:bg-paper"
      >
        <span className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
          <span className="font-display text-base font-semibold text-ink">Diagnostics</span>
        </span>
        <span className="flex items-center gap-3 text-xs text-muted">
          <span className="hidden tabular-nums sm:inline">
            {d?.mode ?? "—"} · {response.results.length} results · {clientMs} ms round-trip
          </span>
          <ChevronDown
            className={`h-4 w-4 text-faint transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-line px-5 py-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
            <Metric label="Query" value={q ? `“${q}”` : "(browse — no query)"} />
            <Metric label="Embedded text" value={parsed ? `“${parsed.cleanedQuery}”` : "—"} />
            <Metric label="Mode" value={d?.mode ?? "—"} />
            <Metric label="Sort" value={request.sort ?? "relevance"} />
            <Metric
              label="Window"
              value={`limit ${d?.limit ?? "—"} · offset ${d?.offset ?? "—"}`}
            />
            <Metric label="Results returned" value={d?.count ?? response.results.length} />
            <Metric label="ANNS field" value={d?.annsField ?? "—"} />
            <Metric
              label="Blend"
              value={
                d?.strategy
                  ? d.strategy === "weighted"
                    ? `weighted (α=${(d.alpha ?? 0).toFixed(2)})`
                    : d.strategy
                  : "—"
              }
            />
            <Metric label="Embedding dim" value={d?.embedDim ?? "—"} />
            <Metric label="Understanding" value={d?.understandModel ?? "off / not run"} mono />
            <Metric
              label="Latency"
              value={
                <span className="tabular-nums">
                  {clientMs} ms round-trip · understand {ms(d?.timings.understandMs)} · embed{" "}
                  {ms(d?.timings.embedMs)} · zilliz {ms(d?.timings.zillizMs)} · server{" "}
                  {ms(d?.timings.serverMs)}
                </span>
              }
            />
          </div>

          <div className="mt-5">
            <span className="eyebrow">Compiled Milvus filter</span>
            <pre className="mt-1.5 overflow-x-auto rounded-lg bg-paper px-3 py-2.5 font-mono text-xs text-ink">
              {d?.filter ? d.filter : "(none)"}
            </pre>
          </div>

          <details className="mt-5 group">
            <summary className="eyebrow cursor-pointer select-none list-none">
              <span className="inline-flex items-center gap-1.5">
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                Raw results JSON ({response.results.length})
              </span>
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-paper px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted">
              {JSON.stringify(response.results, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}

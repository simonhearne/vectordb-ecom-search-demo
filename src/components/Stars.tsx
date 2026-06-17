// Five-star rating with fractional fill via a clipped amber overlay.
export function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  const row = (color: string) =>
    "★★★★★".split("").map((s, i) => (
      <span key={i} style={{ color, fontSize: size, lineHeight: 1 }}>
        {s}
      </span>
    ));
  return (
    <span
      className="relative inline-flex select-none"
      role="img"
      aria-label={`${rating.toFixed(1)} out of 5 stars`}
    >
      <span className="inline-flex tracking-[1px]">{row("#e3ddd2")}</span>
      <span
        className="absolute inset-0 inline-flex overflow-hidden tracking-[1px]"
        style={{ width: `${pct}%` }}
        aria-hidden="true"
      >
        {row("var(--color-star)")}
      </span>
    </span>
  );
}

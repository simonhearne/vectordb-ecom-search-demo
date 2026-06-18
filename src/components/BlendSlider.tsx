import { useEffect, useState } from "react";

// A compact controlled slider for the dense/semantic blend (α ∈ [0,1]). 0 = pure keyword
// (BM25), 1 = pure semantic (dense vector), in-between = weighted hybrid.
//
// A native <input type=range>'s React onChange fires on every step during a drag, which
// would refetch on each intermediate value. So we hold a *local* visual value while the
// user drags and only commit (call onChange) on release — pointer-up, key-up, or the
// input's change/blur — and keep the thumb in sync with the committed `alpha` prop.
export function BlendSlider({
  alpha,
  onChange,
  className = "",
}: {
  alpha: number;
  onChange: (a: number) => void;
  className?: string;
}) {
  const [local, setLocal] = useState(alpha);
  const [dragging, setDragging] = useState(false);

  // Adopt external changes (e.g. a reset elsewhere) only while not mid-drag.
  useEffect(() => {
    if (!dragging) setLocal(alpha);
  }, [alpha, dragging]);

  const commit = () => {
    setDragging(false);
    if (local !== alpha) onChange(local);
  };

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex items-center justify-between">
        <span className="eyebrow">Relevance blend</span>
        <span className="text-xs font-medium tabular-nums text-muted">
          {Math.round(local * 100)}% semantic
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerDown={() => setDragging(true)}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Relevance blend: keyword to semantic"
        aria-valuetext={`${Math.round(local * 100)} percent semantic`}
        className="w-full cursor-pointer"
      />
      <div className="flex items-center justify-between text-[11px] font-medium text-faint">
        <span>Keyword</span>
        <span>Semantic</span>
      </div>
    </div>
  );
}

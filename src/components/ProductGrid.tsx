import type { Product } from "../lib/types";
import { ProductCard } from "./ProductCard";

export function ProductGrid({
  products,
  onMoreLikeThis,
}: {
  products: Product[];
  onMoreLikeThis?: (p: Product) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {products.map((p, i) => (
        <ProductCard key={p.parent_asin} product={p} index={i} onMoreLikeThis={onMoreLikeThis} />
      ))}
    </div>
  );
}

// Single front-end seam for all DB access. Everything goes through the same-origin
// Pages Function proxy — the browser never talks to Zilliz directly.
import type { Facets, SearchRequest, SearchResponse } from "./types";

export async function search(req: SearchRequest): Promise<SearchResponse> {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Search failed (${res.status})`);
  }
  return (await res.json()) as SearchResponse;
}

export async function loadFacets(): Promise<Facets> {
  const res = await fetch("/facets.json");
  if (!res.ok) throw new Error("Could not load facets.json");
  return (await res.json()) as Facets;
}

// Deferred: "More like this" via /api/similar (search-by-stored-PK on image_vec/text_vec).
// export async function similar(parentAsin: string, mode: "image" | "text") { ... }

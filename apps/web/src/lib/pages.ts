import { useSearchParams } from "react-router";

/** Rows per page the lists offer. */
export const PAGE_SIZES = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * The page buttons to show: always the first and last page, the current one and its
 * neighbours, and a gap where pages are skipped. 1 … 4 5 6 … 20.
 */
export function pageNumbers(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  // Fill a gap of one page with that page: "1 2 3" reads better than "1 … 3".
  for (const p of [...keep]) {
    if (keep.has(p + 2) && !keep.has(p + 1)) keep.add(p + 1);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  for (const [i, p] of sorted.entries()) {
    if (i > 0 && p - sorted[i - 1]! > 1) out.push("gap");
    out.push(p);
  }
  return out;
}

/** One page of a list the page already holds, numbered the same way as the API's pages. */
export function paginate<T>(items: readonly T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(page, 1), pages);
  return { items: items.slice((p - 1) * size, p * size), page: p, pages, total: items.length };
}

/**
 * A list's page, page size and filters, kept in the address so a view can be shared and
 * survives a reload. Values equal to their default are left out of the URL. Changing a
 * filter goes back to page 1. Other parameters on the URL are kept.
 */
export function useListParams<K extends string>(defaults: Record<K, string>) {
  const [params, setParams] = useSearchParams();
  const keys = Object.keys(defaults) as K[];
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? defaults[k]])) as Record<
    K,
    string
  >;
  const page = Math.max(1, Math.trunc(Number(params.get("page"))) || 1);
  const askedSize = Number(params.get("size"));
  const size = (PAGE_SIZES as readonly number[]).includes(askedSize)
    ? askedSize
    : DEFAULT_PAGE_SIZE;
  const set = (patch: Partial<Record<K | "page" | "size", string | number>>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch) as [string, string | number][]) {
          const isDefault =
            v === "" ||
            (k === "page" && Number(v) === 1) ||
            (k === "size" && Number(v) === DEFAULT_PAGE_SIZE) ||
            (k in defaults && String(v) === defaults[k as K]);
          if (isDefault) next.delete(k);
          else next.set(k, String(v));
        }
        // A new filter or page size starts again from the first page.
        if (!("page" in patch)) next.delete("page");
        return next;
      },
      { replace: true },
    );
  return { values, page, size, set };
}

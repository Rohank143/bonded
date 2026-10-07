import { useEffect, useState } from "react";

/**
 * Show a long list a page at a time. For lists the page already holds in full (the ones read
 * from chain logs), this keeps the page from rendering every row at once. `resetKey` starts
 * over at the first page when the list's filter changes.
 */
export function usePaged<T>(items: readonly T[], pageSize = 25, resetKey?: unknown) {
  const [pages, setPages] = useState(1);
  useEffect(() => setPages(1), [resetKey]);
  const shown = items.slice(0, pages * pageSize);
  return {
    shown,
    hasMore: shown.length < items.length,
    more: () => setPages((p) => p + 1),
    total: items.length,
  };
}

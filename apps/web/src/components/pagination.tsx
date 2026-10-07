import { PAGE_SIZES, pageNumbers } from "../lib/pages";
import { Select } from "./select";

const Arrow = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    className="size-4"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

/**
 * Numbered pages under a list: where you are ("26–50 of 287 agents"), page buttons with gaps
 * for skipped pages, previous and next, and the page size.
 */
export function Pagination({
  page,
  pages,
  total,
  size,
  onPage,
  onSize,
  noun = "rows",
}: {
  page: number;
  pages: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  /** What the rows are, plural: "agents", "episodes". */
  noun?: string;
}) {
  if (total === 0) return null;
  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  const cell =
    "flex h-9 min-w-9 items-center justify-center rounded-full px-2.5 font-mono text-[13px] tabular-nums transition";
  return (
    <nav
      aria-label="Pages"
      className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-4"
    >
      <p className="text-[13px] text-muted">
        <span className="text-soft tabular-nums">
          {from.toLocaleString()}–{to.toLocaleString()}
        </span>{" "}
        of <span className="text-soft tabular-nums">{total.toLocaleString()}</span> {noun}
      </p>
      {pages > 1 && (
        <ul className="flex items-center gap-1">
          <li>
            <button
              type="button"
              onClick={() => onPage(page - 1)}
              disabled={page <= 1}
              aria-label="Previous page"
              className={`${cell} text-soft hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-35`}
            >
              <Arrow d="M15 6l-6 6 6 6" />
            </button>
          </li>
          {pageNumbers(page, pages).map((p, i) =>
            p === "gap" ? (
              <li key={`gap-${i}`} className="px-1 text-muted" aria-hidden>
                …
              </li>
            ) : (
              <li key={p}>
                <button
                  type="button"
                  onClick={() => onPage(p)}
                  aria-current={p === page ? "page" : undefined}
                  aria-label={`Page ${p}`}
                  className={`${cell} ${p === page ? "bg-ink font-semibold text-paper" : "text-soft hover:bg-white/[0.06]"}`}
                >
                  {p}
                </button>
              </li>
            ),
          )}
          <li>
            <button
              type="button"
              onClick={() => onPage(page + 1)}
              disabled={page >= pages}
              aria-label="Next page"
              className={`${cell} text-soft hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-35`}
            >
              <Arrow d="M9 6l6 6-6 6" />
            </button>
          </li>
        </ul>
      )}
      <Select
        label="Per page"
        value={String(size)}
        onChange={(v) => onSize(Number(v))}
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
      />
    </nav>
  );
}

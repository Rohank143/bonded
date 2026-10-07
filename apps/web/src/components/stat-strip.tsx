import type { ReactNode } from "react";
import { Spinner } from "./ui";

/** A stat that's still loading: a small spinner where the number will be. */
export function StatLoading() {
  return (
    <span className="inline-flex h-10 items-center text-muted" role="status">
      <Spinner />
      <span className="sr-only">Loading…</span>
    </span>
  );
}

/** A row of key numbers in one panel, split by hairlines: no card per number. */
export function StatStrip({
  stats,
}: {
  stats: { label: ReactNode; value: ReactNode; hint?: ReactNode }[];
}) {
  return (
    <section className="panel grid grid-cols-2 overflow-hidden p-0 lg:grid-cols-4">
      {stats.map((t, i) => (
        <div
          key={i}
          className="min-w-0 border-line p-5 [&:nth-child(-n+2)]:border-b max-lg:[&:nth-child(odd)]:border-r lg:border-b-0 lg:[&:not(:last-child)]:border-r"
        >
          <p className="text-[13px] text-muted">{t.label}</p>
          <p className="mt-2 font-serif text-[40px] leading-none tabular-nums">{t.value}</p>
          {t.hint && <p className="mt-1.5 text-xs text-muted">{t.hint}</p>}
        </div>
      ))}
    </section>
  );
}

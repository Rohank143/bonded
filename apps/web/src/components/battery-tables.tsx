import type { Report } from "../lib/api";

/**
 * The security grade's extra batteries, from a rating report: the S1 market-data battery per
 * seed (false prices, news and numbers) and the cross-session memory battery. Induced action
 * counts toward the grade; a freeze (the agent held or skipped a trade) is shown apart and isn't
 * graded. Renders nothing for a report without either (older reports, operator-run agents).
 */
export function BatteryTables({ report }: { report: Report }) {
  const s1 = report.s1 ?? [];
  const memory = report.memory;
  if (s1.length === 0 && !memory) return null;
  return (
    <div className="flex flex-col gap-5">
      {s1.length > 0 && (
        <section aria-label="Market-data battery">
          <p className="eyebrow">Market data (S1)</p>
          <p className="mt-1 text-xs text-muted">
            The same task twice, clean and with false prices, news or numbers planted. Acted: the
            lie moved it to trade (counts toward the grade). Froze: it held or skipped a trade
            instead (shown, not graded).
          </p>
          <table className="mt-3 w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1.5 font-normal">Seed</th>
                <th className="py-1.5 font-normal">Class</th>
                <th className="py-1.5 text-right font-normal">Acted</th>
                <th className="py-1.5 text-right font-normal">Froze</th>
                <th className="py-1.5 text-right font-normal">Breached</th>
              </tr>
            </thead>
            <tbody>
              {s1.map((r) => (
                <tr key={r.seed} className="border-t border-white/[0.06]">
                  <td className="truncate py-1.5 font-mono">{r.seed}</td>
                  <td className="py-1.5 font-mono text-muted">{r.class}</td>
                  <td
                    className={`py-1.5 text-right font-mono ${r.manipulated ? "text-breach" : "text-muted"}`}
                  >
                    {r.manipulated} of {r.countedPairs}
                  </td>
                  <td className="py-1.5 text-right font-mono text-muted">
                    {r.inducedInaction ?? 0}
                  </td>
                  <td className="py-1.5 text-right font-mono text-muted">{r.breached}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {memory && (
        <section aria-label="Memory battery">
          <p className="eyebrow">Memory</p>
          {memory.skipped ? (
            <p className="mt-1 text-xs text-muted">Not run: {memory.skipped}.</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted">
                A false standing instruction planted on day 1; did the agent act on it on a clean
                day 2, against a control with nothing planted?
              </p>
              <table className="mt-3 w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1.5 font-normal">Seed</th>
                    <th className="py-1.5 font-normal">Class</th>
                    <th className="py-1.5 text-right font-normal">Acted on the note</th>
                  </tr>
                </thead>
                <tbody>
                  {memory.seeds.map((r) => (
                    <tr key={r.seed} className="border-t border-white/[0.06]">
                      <td className="truncate py-1.5 font-mono">{r.seed}</td>
                      <td className="py-1.5 font-mono text-muted">{r.class}</td>
                      <td
                        className={`py-1.5 text-right font-mono ${r.manipulated ? "text-breach" : "text-muted"}`}
                      >
                        {r.manipulated} of {r.countedAttempts}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  );
}

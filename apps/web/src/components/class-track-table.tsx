import { TRACK_LABEL, trackText, type ClassResult, type TrackResult } from "../lib/class-tracks";

const TRACKS: TrackResult["track"][] = ["main", "market", "memory", "world"];

/**
 * Each attack class that ran, with one column per track (main library, market data, memory,
 * world state):
 * how often the agent was manipulated there. For ratings whose full report the API doesn't hold
 * (the leaderboard's), built from the published per-class summary.
 */
export function ClassTrackTable({ results }: { results: ClassResult[] }) {
  const ran = results.filter((r) => r.tracks.length);
  const tracks = TRACKS.filter((t) => ran.some((r) => r.tracks.some((x) => x.track === t)));
  const weak = ran.filter((r) => r.rate);
  const ungraded = ran.some((r) => r.tracks.some((t) => !t.graded));
  return (
    <div className="flex flex-col gap-5">
      {weak.length > 0 ? (
        <div className="flex gap-3.5 rounded-2xl border border-breach/35 bg-breach-soft p-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-breach/20 font-bold text-breach">
            !
          </span>
          <span>
            <strong className="block">
              {weak.length === 1 ? "One weak class" : `${weak.length} weak classes`}:{" "}
              {weak.map((r) => r.cls).join(", ")}
            </strong>
            <span className="mt-1 block text-sm text-soft">
              {tracks
                .map((track) => {
                  const hit = weak.flatMap((r) =>
                    r.tracks
                      .filter((t) => t.track === track && t.graded && t.hits)
                      .map((t) => `${r.cls} ${t.hits} of ${t.of}`),
                  );
                  return hit.length ? `${TRACK_LABEL[track]}: ${hit.join(", ")}` : null;
                })
                .filter(Boolean)
                .join(". ")}
              . Every other graded class and track held.
            </span>
          </span>
        </div>
      ) : (
        <p className="text-sm text-soft">Never manipulated on any graded class or track.</p>
      )}
      <table className="w-full text-left text-xs">
        <thead className="text-muted">
          <tr>
            <th className="py-1.5 font-normal">Class</th>
            {tracks.map((t) => (
              <th key={t} className="py-1.5 text-right font-normal">
                {TRACK_LABEL[t]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ran.map((r) => (
            <tr key={r.cls} className="border-t border-white/[0.06]">
              <td className="py-2">
                <span className="mr-2 font-mono text-muted">{r.cls}</span>
                <span className="text-sm">{r.name}</span>
              </td>
              {tracks.map((track) => {
                const t = r.tracks.find((x) => x.track === track);
                return (
                  <td
                    key={track}
                    title={t ? trackText(t) : undefined}
                    className={`py-2 text-right font-mono ${t?.hits && t.graded ? "text-breach" : "text-muted"}`}
                  >
                    {!t ? "—" : t.hits ? `${t.hits} of ${t.of}` : `held ${t.of}`}
                    {t && !t.graded ? "*" : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        Main library: episodes where it acted on the attack, whether or not the vault stopped it.
        Market data: pairs where false data moved it to trade. Memory: attempts where it acted on a
        planted note.{ungraded && " * Too few results to enter the grade."}
      </p>
    </div>
  );
}

import { useNavigate } from "react-router";
import type { RunRecord } from "../lib/api";
import type { PreviewRecord } from "../lib/byoa-api";
import {
  classCells,
  coverageRows,
  livenessLine,
  ratingFailure,
  untestedClasses,
  untestedLine,
} from "../lib/byoa";
import { codeSourceLabel, duration } from "../lib/connect";
import { Badge, Button, Callout, ScoreRing, TierBadge } from "./ui";
import { BreachEvidenceList, RatingCompareView, TopFixes } from "./report-actions";

const TONE = { breach: "text-breach", warn: "text-warn", muted: "text-muted" } as const;

/** The label every preview carries, wherever its score shows. */
export const PREVIEW_LABEL = "Preview: not on chain, not insurable";

/** What "Make it official" carries into onboarding. */
export interface OfficialPrefill {
  previewId: string;
  mode: PreviewRecord["mode"];
  connection: PreviewRecord["connection"];
  agentUrl: string | null;
  /** Onboarding fills a declared hash in; an automatic one is only shown, it is reported again. */
  codeHash: PreviewRecord["codeHash"];
  /** Its score, for the recommended bond. */
  score?: number | null;
}

export function prefillFrom(preview: PreviewRecord): OfficialPrefill {
  return {
    previewId: preview.id,
    mode: preview.mode,
    connection: preview.connection,
    agentUrl: preview.agentUrl?.url ?? null,
    codeHash: preview.codeHash,
    score: preview.rating?.score ?? null,
  };
}

/**
 * A preview's report: the same score and report an official rating computes, never attested or
 * posted, and labelled so. "Make it official" opens onboarding with the preview's choices.
 */
export function PreviewReport({
  preview,
  run,
  previous,
  session,
  onRateAgain,
  rateAgainBusy = false,
}: {
  preview: PreviewRecord;
  run: RunRecord;
  /** The wallet's preview before this one that finished with a score: the "before". */
  previous?: PreviewRecord | undefined;
  session?: string | undefined;
  /** Start a new preview with the same choices, after a fix. */
  onRateAgain?: () => void;
  rateAgainBusy?: boolean;
}) {
  const navigate = useNavigate();
  const report = run.report;
  const official = () => {
    window.scrollTo?.({ top: 0 });
    void navigate(`/agents/new?preview=${encodeURIComponent(preview.id)}`, {
      state: { prefill: prefillFrom(preview) },
    });
  };
  const untested = new Set(untestedClasses(report));
  return (
    <div className="flex flex-col gap-5 text-sm">
      <Callout tone="warn" title={PREVIEW_LABEL}>
        This score is computed exactly as an official rating's, but it isn't signed or posted, and
        no cover can be quoted from it. To get an official score, onboard the agent: it gets a vault
        and a bond, and is rated again from scratch.
      </Callout>
      {run.status === "failed" || !report ? (
        <div role="alert" className="rounded-2xl border border-breach/35 bg-breach-soft p-4">
          <p className="font-semibold">The preview didn't finish with a score.</p>
          <p className="mt-1 text-soft">{ratingFailure(run)}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-6">
            <ScoreRing score={report.scoring.score} size={120} />
            <div className="flex flex-col gap-1.5">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone="warn">Preview</Badge>
                <TierBadge score={report.scoring.score} />
              </p>
              <p className="text-muted">
                {report.episodes.total} episodes ({report.episodes.attacks} attacks,{" "}
                {report.episodes.controls} with no attack) in {duration(report.durationMs / 1000)}.
              </p>
              {preview.codeHash && (
                <p className="text-xs text-muted">
                  Code hash{" "}
                  <span className="font-mono">{preview.codeHash.value.slice(0, 18)}…</span> from{" "}
                  {codeSourceLabel(preview.codeHash)}.
                </p>
              )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-xs">
              <caption className="sr-only">Results by attack class</caption>
              <thead className="text-left text-muted">
                <tr>
                  <th className="pb-2 font-medium">Attack class</th>
                  <th className="pb-2 text-right font-medium">Exercised</th>
                  <th className="pb-2 text-right font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {report.classes.map((c) => {
                  const cells = classCells(c);
                  const notReached = untested.has(c.class) || cells.result === "not reached";
                  return (
                    <tr key={c.class} className="border-t border-white/[0.06]">
                      <td className="py-2">{c.name}</td>
                      <td
                        className={`py-2 text-right font-mono ${notReached ? "text-warn" : "text-muted"}`}
                        title={
                          notReached
                            ? "No episode tested the agent: priced as untested within its group"
                            : undefined
                        }
                      >
                        {cells.exercised}
                      </td>
                      <td className={`py-2 text-right font-mono ${TONE[cells.tone]}`}>
                        {cells.result}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {previous?.ratingId && (
            <div className="rounded-2xl border border-line-strong p-4">
              <RatingCompareView from={previous.ratingId} to={run.id} session={session} />
            </div>
          )}
          <TopFixes report={report} />
          <BreachEvidenceList report={report} />
          {untestedLine(report) && <p className="text-xs text-muted">{untestedLine(report)}</p>}
          <CoverageLine coverage={run.coverage ?? report.coverage ?? null} />
          {livenessLine(report.liveness) && (
            <p className="text-xs text-muted">{livenessLine(report.liveness)}</p>
          )}
        </>
      )}
      {onRateAgain && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <p className="font-semibold">Fixed something?</p>
          <p className="text-muted">
            Rate it again with the same choices, then see the two side by side. A new preview
            connects and checks again first.
          </p>
          <div>
            <Button kind="secondary" loading={rateAgainBusy} onClick={onRateAgain}>
              Rate again
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <p className="font-semibold">Ready for the real thing?</p>
        <p className="text-muted">
          Making it official registers the agent, creates its vault and stakes a bond, with your
          choices from this preview filled in. The official rating runs again, attested on chain,
          and this preview stays linked to it.
        </p>
        <div>
          <Button onClick={official}>Make it official</Button>
        </div>
      </div>
    </div>
  );
}

function CoverageLine({ coverage }: { coverage: Parameters<typeof coverageRows>[0] }) {
  const rows = coverageRows(coverage);
  if (!rows.length) return null;
  const unread = rows.filter((r) => r.read === 0);
  return (
    <p className="text-xs text-muted">
      {unread.length
        ? `Your agent never read ${unread.map((r) => r.label).join(", ")}, so attacks there couldn't reach it.`
        : "Your agent read every source that was attacked."}
    </p>
  );
}

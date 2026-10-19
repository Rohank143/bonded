import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type LeaderboardRecord } from "../lib/api";
import { DOCS_DISCLOSURES } from "../lib/routes";
import { manipulatedOf, weakestText } from "../lib/security";
import {
  Badge,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  ScoreRing,
  TierBadge,
  Tooltip,
  TxLink,
  linkClass,
} from "../components/ui";

const CLASSES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];

/**
 * One attack class as a small square, coloured by the share of its episodes where the agent was
 * manipulated (acted on the attack, whether or not the vault then stopped it): what the security
 * grade measures. Older entries only have breaches.
 */
function Square({ cls, c }: { cls: string; c?: LeaderboardRecord["classes"][number] }) {
  if (!c || c.episodes === 0)
    return (
      <Tooltip content={`${cls}: not run`}>
        <span className="block size-5 rounded-[5px] border border-dashed border-line-strong" />
      </Tooltip>
    );
  const manipulated = manipulatedOf(c);
  const rate = manipulated / c.episodes;
  const tone =
    rate === 0
      ? "bg-brand-bright/45 ring-1 ring-inset ring-brand-bright/70"
      : rate < 0.5
        ? "bg-breach/45 ring-1 ring-inset ring-breach/60"
        : "bg-breach-solid";
  return (
    <Tooltip
      content={
        c.manipulated === undefined
          ? `${cls} ${c.name}: ${c.breaches} of ${c.episodes} episodes breached`
          : `${cls} ${c.name}: manipulated in ${manipulated} of ${c.episodes} episodes, ${c.breaches} breached`
      }
    >
      <span className={`block size-5 rounded-[5px] ${tone}`} />
    </Tooltip>
  );
}

/** Totals across every attack class, for the one-line summary under the strip. */
function totals(e: LeaderboardRecord) {
  return e.classes.reduce(
    (t, c) => ({
      manipulated: t.manipulated + manipulatedOf(c),
      breaches: t.breaches + c.breaches,
      episodes: t.episodes + c.episodes,
    }),
    { manipulated: 0, breaches: 0, episodes: 0 },
  );
}

/** Older entries measured breaches only, so their summary mustn't claim anything about manipulation. */
const measuresManipulation = (e: LeaderboardRecord) =>
  e.classes.some((c) => c.manipulated !== undefined);

/** One line per extra battery: the market-data (S1) pairs and the memory attempts, when they ran. */
function batteryLines(e: LeaderboardRecord): string[] {
  const lines: string[] = [];
  if (e.s1Classes?.length) {
    const counted = e.s1Classes.reduce((n, c) => n + c.counted, 0);
    const acted = e.s1Classes.reduce((n, c) => n + c.manipulated, 0);
    const froze = e.s1Classes.reduce((n, c) => n + c.inducedInaction, 0);
    lines.push(
      `Market data: false data moved it to act in ${acted} of ${counted} pairs` +
        (froze ? `, froze it in ${froze}` : ""),
    );
  }
  if (e.memoryClasses?.length) {
    const counted = e.memoryClasses.reduce((n, c) => n + c.counted, 0);
    const acted = e.memoryClasses.reduce((n, c) => n + c.manipulated, 0);
    lines.push(`Memory: acted on a planted note in ${acted} of ${counted} attempts`);
  }
  return lines;
}

const DISCLOSURE: Record<LeaderboardRecord["disclosure"]["status"], string> = {
  "not-needed": "Bonded's own",
  pending: "maintainer notice pending",
  notified: "maintainers notified",
  published: "no findings withheld",
};

export function Leaderboard() {
  const board = useQuery({ queryKey: ["leaderboard"], queryFn: api.leaderboard });
  const h = board.data?.headline;
  // Legacy insurance results cannot be compared with security grades.
  const entries = board.data
    ? [...board.data.entries].sort((a, b) => (b.securityGrade ?? -1) - (a.securityGrade ?? -1))
    : [];
  const graded = entries.filter(
    (e): e is LeaderboardRecord & { securityGrade: number } => e.securityGrade !== undefined,
  );
  return (
    <Page
      eyebrow="Arena results"
      title="Leaderboard"
      intro="Popular open-source agents and Bonded's own, ranked by their security score. Legacy results without a security score are unranked; their insurance score only measures loss after containment."
    >
      {h && h.evaluations > 0 && (
        <section className="panel border-accent/25 bg-[radial-gradient(ellipse_at_0%_0%,rgb(29_78_216/.25),transparent_60%)] p-7 sm:p-9">
          <p className="eyebrow !text-accent">Headline</p>
          <p className="mt-3 max-w-4xl font-serif text-4xl leading-tight sm:text-5xl">
            {h.failingTemplates === 0
              ? `None of the ${h.templates} popular agent templates fell for basic prompt injection.`
              : `${h.failingTemplates} of ${h.templates} popular agent templates fall for basic prompt injection.`}
          </p>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted">
            Across {h.evaluations} template and model pairs ({h.failingEvaluations} breached), on
            the injection classes A1, A2 and A7, with five runs of every attack, including held-out
            attacks that are never published. Results can differ with other models or settings. The
            security score measures manipulation, including attempts blocked by the mandate, across
            the attack library, false market data and, where an agent keeps memory, planted notes.
          </p>
        </section>
      )}

      {graded.length >= 3 && (
        <section className="grid gap-4 md:grid-cols-3">
          {graded.slice(0, 3).map((e, i) => (
            <div key={e.slug} className="panel flex items-center gap-5 p-5">
              <ScoreRing score={e.securityGrade} size={84} />
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-muted">#{i + 1}</p>
                <p className="truncate font-semibold">{e.name}</p>
                <p className="truncate text-xs text-muted">
                  {e.framework}
                  {e.model ? ` · ${e.model}` : ""}
                </p>
                {weakestText(e) && (
                  <p className="mt-1 truncate text-[11px] text-muted">{weakestText(e)}</p>
                )}
                <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                  Insurance <TierBadge score={e.score} />
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      <Card
        title="Rankings"
        description="The security score is set by the agent's weakest row. One square per attack class of the main library, A1 to A10, coloured by how often the agent was manipulated; hover for breaches. Market-data and memory results are summed up under each strip."
        actions={
          <div className="flex flex-wrap items-center gap-3.5 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-brand-bright/45 ring-1 ring-brand-bright/70" />{" "}
              held
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-breach/45 ring-1 ring-breach/60" /> sometimes
              manipulated
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-breach-solid" /> half or more
            </span>
          </div>
        }
      >
        {board.isPending && !board.error && <Loading what="the leaderboard" height="lg" />}
        <ErrorText error={board.error} />
        {board.data?.entries.length === 0 && <EmptyState title="No ratings published yet" />}
        {entries.length > 0 && (
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <div className="min-w-[860px]">
              <div className="grid grid-cols-[40px_minmax(0,1fr)_120px_268px_150px] items-end gap-6 px-5 pb-3 text-[10.5px] font-medium tracking-[0.14em] text-muted uppercase sm:px-6">
                <span>#</span>
                <span>Agent</span>
                <span>Security</span>
                <span className="flex gap-1.5 tracking-normal normal-case">
                  {CLASSES.map((c) => (
                    <span key={c} className="w-5 text-center font-mono text-[9px] tracking-tighter">
                      {c}
                    </span>
                  ))}
                </span>
                <span>On chain</span>
              </div>
              <ol aria-label="Security rankings">
                {entries.map((e, i) => {
                  const t = totals(e);
                  return (
                    <li
                      key={e.slug}
                      className="grid grid-cols-[40px_minmax(0,1fr)_120px_268px_150px] items-center gap-6 border-t border-line px-5 py-5 transition hover:bg-white/[0.025] sm:px-6"
                    >
                      <span className="font-mono text-xs text-muted">
                        {e.securityGrade === undefined ? "—" : String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">
                          {e.template ? (
                            <a
                              href={e.template}
                              className="hover:text-accent"
                              target="_blank"
                              rel="noreferrer"
                            >
                              {e.name}
                            </a>
                          ) : (
                            e.name
                          )}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted">
                          {e.framework}
                          {e.model ? ` · ${e.model}` : " · scripted"}
                        </span>
                        <span className="mt-1 block text-[11px] text-muted/80">
                          {DISCLOSURE[e.disclosure.status]}
                        </span>
                      </span>
                      <span className="flex flex-col items-start gap-2">
                        {e.securityGrade === undefined ? (
                          <span className="text-xs text-muted">Security not measured</span>
                        ) : (
                          <>
                            <span className="font-serif text-3xl leading-none">
                              {e.securityGrade}
                            </span>
                            {weakestText(e) && (
                              <span className="text-[11px] leading-snug text-muted">
                                {weakestText(e)}
                              </span>
                            )}
                          </>
                        )}
                        <span className="text-xs text-muted">Insurance score {e.score}</span>
                        <TierBadge score={e.score} />
                      </span>
                      <span>
                        <span className="flex gap-1.5">
                          {CLASSES.map((c) => (
                            <Square key={c} cls={c} c={e.classes.find((x) => x.class === c)} />
                          ))}
                        </span>
                        <span className="mt-2 block text-[11px] text-muted">
                          {!measuresManipulation(e) ? (
                            t.breaches === 0 ? (
                              <>No breaches in {t.episodes} episodes</>
                            ) : (
                              <span className="text-breach">
                                {t.breaches} {t.breaches === 1 ? "breach" : "breaches"} in{" "}
                                {t.episodes} episodes
                              </span>
                            )
                          ) : t.manipulated === 0 ? (
                            <>Not manipulated in {t.episodes} episodes</>
                          ) : (
                            <span className="text-breach">
                              Manipulated in {t.manipulated} of {t.episodes} episodes
                              {t.breaches ? `, ${t.breaches} breached` : ""}
                            </span>
                          )}
                        </span>
                        {batteryLines(e).map((line) => (
                          <span key={line} className="mt-1 block text-[11px] text-muted">
                            {line}
                          </span>
                        ))}
                      </span>
                      <span className="flex flex-col items-start gap-1.5 text-xs">
                        {e.onchain ? (
                          <>
                            <Link to={`/agents/${e.onchain.agentId}`} className={linkClass}>
                              Agent {e.onchain.agentId} →
                            </Link>
                            {e.verified === true ? (
                              <Badge tone="safe" dot>
                                Verified
                              </Badge>
                            ) : e.verified === false ? (
                              <Badge>Re-rated since</Badge>
                            ) : !e.onchain.tx ? (
                              <Badge>Score pending</Badge>
                            ) : null}
                            {e.onchain.tx && (
                              <span className="text-muted">
                                tx <TxLink hash={e.onchain.tx} />
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">Not posted</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        )}
      </Card>

      <details className="panel p-5 sm:p-6">
        <summary className="cursor-pointer font-semibold">How we test</summary>
        <ul className="mt-3 flex max-w-3xl list-disc flex-col gap-2 pl-5 text-sm text-muted">
          <li>
            Each open-source template runs unchanged, with its published prompt. Only its tools
            point at the Arena's sandbox instead of a live chain.
          </li>
          <li>
            Every agent faces the same attack library, five runs of each attack, including held-out
            attacks that are never published, so no one can tune for them.
          </li>
          <li>
            Results are shown per attack class. Which attack broke a third-party agent stays private
            until its maintainers have been told (
            <a className={linkClass} href={DOCS_DISCLOSURES}>
              disclosure policy
            </a>
            ).
          </li>
        </ul>
      </details>
    </Page>
  );
}

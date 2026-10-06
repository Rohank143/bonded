import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type LeaderboardRecord } from "../lib/api";
import {
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  ScoreRing,
  Table,
  TierBadge,
  Tooltip,
  TxLink,
  linkClass,
} from "../components/ui";

const CLASSES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];
const REPO = "https://github.com/ddboy19912/bonded/blob/main";

/** Share of a class's episodes that breached, as a cell colour. */
function Cell({ c }: { c?: LeaderboardRecord["classes"][number] }) {
  if (!c || c.episodes === 0) return <td className="px-1 text-center text-muted">·</td>;
  const rate = c.breaches / c.episodes;
  const tone =
    rate === 0
      ? "bg-accent-soft text-accent"
      : rate < 0.5
        ? "bg-breach-soft text-breach"
        : "bg-breach-solid text-paper";
  return (
    <td className="px-1 text-center">
      <Tooltip content={`${c.name}: ${c.breaches} of ${c.episodes} episodes breached`}>
        <span
          className={`inline-block min-w-11 rounded-lg px-1.5 py-1 font-mono text-[11px] font-medium tabular-nums ${tone}`}
        >
          {c.breaches}/{c.episodes}
        </span>
      </Tooltip>
    </td>
  );
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
  const entries = board.data ? [...board.data.entries].sort((a, b) => b.score - a.score) : [];
  return (
    <Page
      eyebrow="Arena results"
      title="Leaderboard"
      intro="Popular open-source agents and Bonded's own, attacked with the same library and scored on the same scale."
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
            attacks that are never published. Results can differ with other models or settings.
            Agents that resist every attack tie: the score separates agents by what breaches them.
          </p>
        </section>
      )}

      {entries.length >= 3 && (
        <section className="grid gap-4 md:grid-cols-3">
          {entries.slice(0, 3).map((e, i) => (
            <div key={e.slug} className="panel flex items-center gap-5 p-5">
              <ScoreRing score={e.score} size={84} />
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-muted">#{i + 1}</p>
                <p className="truncate font-semibold">{e.name}</p>
                <p className="truncate text-xs text-muted">
                  {e.framework}
                  {e.model ? ` · ${e.model}` : ""}
                </p>
                <div className="mt-1.5">
                  <TierBadge score={e.score} />
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      <Card
        title="Rankings"
        description="Each cell is breaches out of episodes for one attack class. Hover a cell for the class."
        actions={
          <div className="flex flex-wrap items-center gap-3.5 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-accent-soft ring-1 ring-accent/40" /> held
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-breach-soft ring-1 ring-breach/40" /> some
              breached
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-breach-solid" /> half or more
            </span>
          </div>
        }
      >
        {board.isPending && !board.error && <Loading what="the leaderboard" lines={6} />}
        <ErrorText error={board.error} />
        {board.data?.entries.length === 0 && <EmptyState title="No ratings published yet" />}
        {entries.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th>Score</th>
                {CLASSES.map((c) => (
                  <th key={c} className="!text-center">
                    {c}
                  </th>
                ))}
                <th>On chain</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={e.slug}>
                  <td className="font-mono text-xs text-muted">{i + 1}</td>
                  <td className="min-w-60 pr-4">
                    <div className="font-semibold">
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
                    </div>
                    <div className="text-xs text-muted">
                      {e.framework}
                      {e.model ? ` · ${e.model}` : " · scripted"} ·{" "}
                      {DISCLOSURE[e.disclosure.status]}
                    </div>
                  </td>
                  <td className="pr-3">
                    <span className="flex items-center gap-2">
                      <span className="font-serif text-2xl leading-none">{e.score}</span>
                      <TierBadge score={e.score} />
                    </span>
                  </td>
                  {CLASSES.map((c) => (
                    <Cell key={c} c={e.classes.find((x) => x.class === c)} />
                  ))}
                  <td className="pl-3 text-xs">
                    {e.onchain ? (
                      <span className="flex flex-col gap-0.5">
                        <Link to={`/agents/${e.onchain.agentId}`} className={linkClass}>
                          Agent {e.onchain.agentId}
                        </Link>
                        {e.onchain.tx ? (
                          <TxLink hash={e.onchain.tx} />
                        ) : (
                          <span className="text-muted">score pending</span>
                        )}
                        {e.verified === true && <span className="text-safe">score verified</span>}
                        {e.verified === false && <span className="text-muted">re-rated since</span>}
                      </span>
                    ) : (
                      <span className="text-muted">not posted</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
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
            <a
              className={linkClass}
              href={`${REPO}/docs/disclosures/README.md`}
              target="_blank"
              rel="noreferrer"
            >
              disclosure policy
            </a>
            ).
          </li>
        </ul>
      </details>
    </Page>
  );
}

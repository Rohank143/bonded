import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type LeaderboardRecord } from "../lib/api";
import {
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Table,
  TierBadge,
  Tooltip,
  TxLink,
  linkClass,
} from "../components/ui";

const CLASSES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];

/** Share of a class's episodes that breached, as a cell colour. */
function Cell({ c }: { c?: LeaderboardRecord["classes"][number] }) {
  if (!c || c.episodes === 0) return <td className="px-1 text-center text-muted">·</td>;
  const rate = c.breaches / c.episodes;
  const tone =
    rate === 0
      ? "bg-safe-soft text-safe"
      : rate < 0.5
        ? "bg-breach-soft text-breach"
        : "bg-breach text-white";
  return (
    <td className="px-1 text-center">
      <Tooltip content={`${c.name}: ${c.breaches} of ${c.episodes} episodes breached`}>
        <span
          className={`inline-block min-w-10 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${tone}`}
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
  return (
    <Page
      title="Agent Safety Leaderboard"
      intro="Popular open-source agent templates and Bonded's own agents, rated in the Arena against the same attack library. Each template runs unchanged with its published prompt; only its tools point at the Arena's sandbox. Results are shown per attack class; which attacks broke an agent stays private until its maintainers have been told (see the disclosure policy)."
    >
      {h && h.evaluations > 0 && (
        <Card className="border-accent/25 bg-accent-soft/40">
          <p className="mb-2 text-xs font-semibold tracking-[0.12em] text-accent uppercase">
            Headline
          </p>
          <p className="max-w-4xl text-2xl leading-snug font-semibold tracking-tight sm:text-3xl">
            {h.failingTemplates === 0
              ? `None of the ${h.templates} popular agent templates rated (${h.evaluations} template/model evaluations) fell for basic prompt injection.`
              : `${h.failingTemplates} of ${h.templates} popular agent templates (${h.failingEvaluations} of ${h.evaluations} template/model evaluations) fall for basic prompt injection.`}
          </p>
          <p className="mt-3 max-w-4xl text-sm leading-relaxed text-muted">
            Judged on the injection attacks (classes A1, A2 and A7) in the Arena, with each
            template's published prompt and the models listed, with five runs of every attack,
            including held-out attacks that are never published. The templates are chatbots that
            sometimes stop to ask the user, and results can differ with other models or settings.
            Every agent with no breaches scores the same, 81 in Monitor mode with an operator-held
            key: the score separates agents by what breaches them, so agents that resist every
            attack tie.
          </p>
        </Card>
      )}
      <Card
        title="Rankings"
        description="Each cell is breaches out of episodes for one attack class. Hover a cell for the class name."
        actions={
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-safe-soft ring-1 ring-safe/40" /> held
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-breach-soft ring-1 ring-breach/40" /> some
              breached
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-breach" /> half or more breached
            </span>
          </div>
        }
      >
        {board.isPending && !board.error && <Loading what="the leaderboard" />}
        <ErrorText error={board.error} />
        {board.data?.entries.length === 0 && <EmptyState title="No ratings published yet" />}
        {board.data && board.data.entries.length > 0 && (
          <Table>
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-2 pr-2">#</th>
                <th className="pr-2">Agent</th>
                <th className="pr-2">Score</th>
                {CLASSES.map((c) => (
                  <th key={c} className="px-1 text-center">
                    {c}
                  </th>
                ))}
                <th className="pl-2">On chain</th>
              </tr>
            </thead>
            <tbody>
              {[...board.data.entries]
                .sort((a, b) => b.score - a.score)
                .map((e, i) => (
                  <tr key={e.slug}>
                    <td className="pr-2 text-muted tabular-nums">{i + 1}</td>
                    <td className="min-w-56 pr-4">
                      <div className="font-medium">
                        {e.template ? (
                          <a
                            href={e.template}
                            className="hover:underline"
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
                        <span className="text-lg font-semibold tabular-nums">{e.score}</span>
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
                            agent {e.onchain.agentId}
                          </Link>
                          {e.onchain.tx ? (
                            <TxLink hash={e.onchain.tx} />
                          ) : (
                            <span className="text-muted">score pending</span>
                          )}
                          {e.verified === true && <span className="text-safe">score verified</span>}
                          {e.verified === false && (
                            <span className="text-muted">re-rated since</span>
                          )}
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
    </Page>
  );
}

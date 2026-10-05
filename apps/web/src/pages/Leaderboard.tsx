import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type LeaderboardRecord } from "../lib/api";
import { Badge, Card, ErrorText, Loading, Page, TxLink } from "../components/ui";

const CLASSES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];

/** Share of a class's episodes that breached, as a cell colour. */
function Cell({ c }: { c?: LeaderboardRecord["classes"][number] }) {
  if (!c || c.episodes === 0) return <td className="px-1 py-1 text-center text-muted">·</td>;
  const rate = c.breaches / c.episodes;
  const tone =
    rate === 0
      ? "bg-safe/20 text-safe"
      : rate < 0.5
        ? "bg-breach/20 text-breach"
        : "bg-breach/50 text-paper";
  return (
    <td className="px-1 py-1 text-center">
      <span
        title={`${c.name}: ${c.breaches} of ${c.episodes} episodes breached`}
        className={`inline-block min-w-8 rounded px-1 text-xs tabular-nums ${tone}`}
      >
        {c.breaches}/{c.episodes}
      </span>
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
        <Card>
          <p className="text-2xl font-semibold">
            {h.failingTemplates === 0
              ? `None of the ${h.templates} popular agent templates rated (${h.evaluations} template/model evaluations) fell for basic prompt injection.`
              : `${h.failingTemplates} of ${h.templates} popular agent templates (${h.failingEvaluations} of ${h.evaluations} template/model evaluations) fall for basic prompt injection.`}
          </p>
          <p className="mt-1 text-sm text-muted">
            Judged on the injection attacks (classes A1, A2 and A7) in the Arena, with each
            template's published prompt and the models listed, with five runs of every attack. The
            templates are chatbots that sometimes stop to ask the user, and results can differ with
            other models or settings. Every agent with no breaches scores the same, 79 in Monitor
            mode with an operator-held key: the score separates agents by what breaches them, so
            agents that resist every attack tie.
          </p>
        </Card>
      )}
      <Card title="Rankings">
        {board.isPending && !board.error && <Loading what="the leaderboard" />}
        <ErrorText error={board.error} />
        {board.data?.entries.length === 0 && (
          <p className="text-sm text-muted">No ratings published yet.</p>
        )}
        {board.data && board.data.entries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
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
                    <tr key={e.slug} className="border-t border-line align-top">
                      <td className="py-2 pr-2 tabular-nums text-muted">{i + 1}</td>
                      <td className="py-2 pr-2">
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
                      <td className="py-2 pr-2">
                        <span className="tabular-nums font-semibold">{e.score}</span>{" "}
                        <Badge tone={e.score >= 70 ? "safe" : e.score < 40 ? "breach" : "neutral"}>
                          {e.tier}
                        </Badge>
                      </td>
                      {CLASSES.map((c) => (
                        <Cell key={c} c={e.classes.find((x) => x.class === c)} />
                      ))}
                      <td className="py-2 pl-2 text-xs">
                        {e.onchain ? (
                          <span className="flex flex-col gap-0.5">
                            <Link
                              to={`/agents/${e.onchain.agentId}`}
                              className="text-accent hover:underline"
                            >
                              agent {e.onchain.agentId}
                            </Link>
                            {e.onchain.tx ? (
                              <TxLink hash={e.onchain.tx} />
                            ) : (
                              <span className="text-muted">score pending</span>
                            )}
                            {e.verified === true && (
                              <span className="text-safe">score verified</span>
                            )}
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
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}

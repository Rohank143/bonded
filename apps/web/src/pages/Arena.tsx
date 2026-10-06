import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useEpisodeFeed } from "../lib/events";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  Page,
  Stat,
  Term,
  TierBadge,
  linkClass,
} from "../components/ui";
import { OperatorTokenField, useOperatorToken } from "../components/wallet";

export function Arena() {
  const { token } = useOperatorToken();
  const [agentId, setAgentId] = useState("2");
  const [runId, setRunId] = useState<string>();
  const [startError, setStartError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const feed = useEpisodeFeed(runId);
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: Boolean(runId),
    refetchInterval: (q) =>
      q.state.data?.status === "done" || q.state.data?.status === "failed" ? false : 3000,
  });

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      setRunId((await api.startRun(token, agentId.trim())).runId);
    } catch (e) {
      setStartError(e);
    } finally {
      setStarting(false);
    }
  }

  const done = feed.cards.length;
  const breaches = feed.cards.filter((c) => c.breached).length;
  const held = feed.cards.filter((c) => c.attackClass && !c.breached).length;
  const runTone =
    run.data?.status === "failed" ? "breach" : run.data?.status === "done" ? "safe" : "neutral";
  return (
    <Page
      title="Arena"
      eyebrow="Live red team"
      intro="Watch agents get attacked, live. Each card is one episode: green means the agent held, red means its vault recorded a breach, and grey is a control with no attack."
    >
      <Card
        title={runId ? `Run ${runId.slice(0, 8)}` : "All runs"}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={feed.connected ? "safe" : "neutral"} dot>
              {feed.connected ? "Live" : "Reconnecting"}
            </Badge>
            {runId && (
              <Button kind="secondary" size="sm" onClick={() => setRunId(undefined)}>
                Show all runs
              </Button>
            )}
          </div>
        }
      >
        <p className="mb-4 max-w-3xl text-sm text-muted">
          Attacks are hidden in what the agent reads: news, messages, token data, tool output.
          Whether it breached is decided by the vault's on-chain breach log, the same record that
          pays claims, never by an AI judge.
        </p>
        <div className="mb-5 grid grid-cols-3 gap-4 rounded-lg bg-sunken p-4 sm:max-w-lg">
          <Stat label="Episodes shown" value={done} />
          <Stat
            label={<Term term="held">Held</Term>}
            value={<span className="text-safe">{held}</span>}
          />
          <Stat
            label={<Term term="breach">Breached</Term>}
            value={<span className={breaches ? "text-breach" : ""}>{breaches}</span>}
          />
        </div>
        {run.data && (
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <Badge tone={runTone}>{run.data.status}</Badge>
            {run.data.report && (
              <span className="flex items-center gap-2">
                Score <strong className="tabular-nums">{run.data.report.scoring.score}</strong>
                <TierBadge score={run.data.report.scoring.score} />
              </span>
            )}
            {run.data.error && <span className="text-breach">{run.data.error}</span>}
          </div>
        )}
        {feed.failedRuns.length > 0 && (
          <p className="mb-4 text-sm text-muted">{feed.failedRuns.length} run(s) failed.</p>
        )}
        {feed.cards.length === 0 ? (
          <EmptyState title="No episodes yet">
            Episodes appear here the moment a rating runs. Agent owners can start one from their
            agent's page.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {feed.cards.map((c) => (
              <li
                key={c.eventId}
                className={`flex flex-col gap-1 rounded-lg border-l-[3px] p-3 text-xs ${
                  c.breached
                    ? "border-breach bg-breach-soft"
                    : c.attackClass
                      ? "border-safe bg-safe-soft"
                      : "border-line-strong bg-sunken"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-medium">{c.attackClass ?? "control"}</span>
                  <span className="text-muted tabular-nums">
                    {c.index + 1}/{c.total}
                  </span>
                </div>
                <div className="truncate text-muted" title={c.attackId ?? "no attack"}>
                  {c.attackId ?? "no attack"}
                </div>
                <div className={`font-semibold ${c.breached ? "text-breach" : "text-safe"}`}>
                  {c.breached ? `Breach · $${c.lossUsd.toFixed(0)}` : "Held"}
                </div>
                {!runId && (
                  <button
                    className="self-start font-mono text-accent hover:underline"
                    onClick={() => setRunId(c.runId)}
                  >
                    run {c.runId.slice(0, 8)}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-sm text-muted">
        See the score this produces for a rated agent:{" "}
        <Link to="/agents/2" className={linkClass}>
          agent 2
        </Link>
        .
      </p>

      <details className="group rounded-(--radius-card) border border-line bg-surface p-5 shadow-(--shadow-card) sm:p-6">
        <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">
          Operator: start a rating
          <span className="text-muted transition-transform group-open:rotate-180" aria-hidden>
            ⌄
          </span>
        </summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <OperatorTokenField />
          <Input label="Agent ID" value={agentId} onChange={setAgentId} inputMode="numeric" />
          <Button
            disabled={!token || !/^\d+$/.test(agentId.trim())}
            loading={starting}
            onClick={start}
          >
            {starting ? "Queuing…" : "Run 42 episodes"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Only agents in the server's agents file can be rated. The worker rates on a private fork,
          then posts one signed score to the chain (this costs the attester testnet gas).
        </p>
        <ErrorText error={startError} />
      </details>
    </Page>
  );
}

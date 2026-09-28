import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useEpisodeFeed } from "../lib/events";
import { Badge, Button, Card, ErrorText, Input, Page } from "../components/ui";
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
  return (
    <Page
      title="Arena"
      intro="Each card is one episode: an attack planted in the agent's world, or a control with no attack. Red means the vault recorded a breach. The verdict comes from the vault's on-chain breach log, the same record that pays claims."
    >
      <Card title="Start a rating">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <OperatorTokenField />
          <Input label="Agent ID" value={agentId} onChange={setAgentId} />
          <Button disabled={!token || !/^\d+$/.test(agentId.trim()) || starting} onClick={start}>
            {starting ? "Queuing…" : "Run 42 episodes"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Only agents in the server's agents file can be rated. The worker rates on a private fork,
          then posts one signed score to the chain (this costs the attester testnet gas).
        </p>
        <ErrorText error={startError} />
      </Card>

      <Card
        title={runId ? `Run ${runId.slice(0, 8)}` : "All runs"}
        actions={
          <div className="flex items-center gap-2 text-xs">
            <Badge tone={feed.connected ? "safe" : "neutral"}>
              {feed.connected ? "live" : "reconnecting"}
            </Badge>
            {runId && (
              <Button kind="secondary" onClick={() => setRunId(undefined)}>
                Show all runs
              </Button>
            )}
          </div>
        }
      >
        {run.data && (
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <Badge
              tone={
                run.data.status === "failed"
                  ? "breach"
                  : run.data.status === "done"
                    ? "safe"
                    : "neutral"
              }
            >
              {run.data.status}
            </Badge>
            {run.data.report && (
              <span>
                Score <strong>{run.data.report.scoring.score}</strong> (
                {run.data.report.scoring.tier})
              </span>
            )}
            {run.data.error && <span className="text-breach">{run.data.error}</span>}
          </div>
        )}
        <p className="mb-3 text-sm text-muted">
          {done} episodes shown, {breaches} with a breach.
          {feed.failedRuns.length > 0 && ` ${feed.failedRuns.length} run(s) failed.`}
        </p>
        {feed.cards.length === 0 ? (
          <p className="text-sm text-muted">No episodes yet. Start a rating to watch it here.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {feed.cards.map((c) => (
              <li
                key={c.eventId}
                className={`rounded-md border p-2 text-xs ${c.breached ? "border-breach bg-breach/10" : "border-safe bg-safe/10"}`}
              >
                <div className="flex justify-between font-mono">
                  <span>{c.attackClass ?? "control"}</span>
                  <span className="text-muted">
                    {c.index + 1}/{c.total}
                  </span>
                </div>
                <div className="truncate text-muted" title={c.attackId ?? "no attack"}>
                  {c.attackId ?? "no attack"}
                </div>
                <div
                  className={c.breached ? "font-semibold text-breach" : "font-semibold text-safe"}
                >
                  {c.breached ? `breach, $${c.lossUsd.toFixed(0)}` : "held"}
                </div>
                {!runId && (
                  <button className="text-accent hover:underline" onClick={() => setRunId(c.runId)}>
                    run {c.runId.slice(0, 8)}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-sm text-muted">
        Scores for a rated agent:{" "}
        <Link to="/agents/2" className="text-accent hover:underline">
          agent 2
        </Link>
        .
      </p>
    </Page>
  );
}

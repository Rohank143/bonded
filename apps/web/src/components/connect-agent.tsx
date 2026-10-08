import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import type { BindingLevel, RemoteMode } from "@bonded/shared";
import { api, type RatingAttempt, type SelfAgentRecord } from "../lib/api";
import {
  BINDING_LABELS,
  expectedLine,
  lapseReason,
  progressLine,
  ratingFailure,
  runnerCommand,
  runnerDockerCommand,
  runnerView,
} from "../lib/byoa";
import { createRunnerToken, requestRating, revokeRunnerToken } from "../lib/self-serve";
import { useRatingRun } from "../lib/rating-run";
import { when } from "../lib/format";
import { DOCS_BYOA } from "../lib/routes";
import { Badge, Button, Card, ErrorText, linkClass } from "./ui";

type Registered = Extract<SelfAgentRecord, { registered: true }>;

/**
 * "Connect your agent": the owner's controls for an agent they run themselves (bring your own
 * agent). Make a runner token by signing, copy the command that starts the runner next to the
 * agent, watch it connect, rate the agent and follow the rating. Shown only to the owner.
 */
export function ConnectAgent({
  agentId,
  record,
  scoreExpired,
  onRated,
  readOnly = false,
  registryOwner,
}: {
  agentId: string;
  record: Registered;
  /** The agent has a score and it has expired. */
  scoreExpired: boolean;
  onRated?: () => void;
  /** Status only: the viewer isn't the owner (no token, no rating). */
  readOnly?: boolean;
  /** The agent's owner in the registry now, to tell when it changed hands. */
  registryOwner?: string;
}) {
  const { signMessageAsync } = useSignMessage();
  const [token, setToken] = useState<{ value: string; gatewayUrl: string | null }>();
  const [runId, setRunId] = useState<string>();
  const [busy, setBusy] = useState<"token" | "revoke" | "rate">();
  const [error, setError] = useState<unknown>(null);
  const runner = useQuery({
    queryKey: ["runner", agentId],
    queryFn: () => api.runner(agentId),
    refetchInterval: 10_000,
  });
  const run = useRatingRun(runId);
  const running = Boolean(runId) && !["done", "failed"].includes(run.data?.status ?? "");

  const mode: RemoteMode = record.mode ?? "tools";
  const view = runnerView(runner.data);
  const connected = runner.data?.runner?.connected === true;
  const waiting = record.nextRatingAt && new Date(record.nextRatingAt) > new Date();
  const lapse = lapseReason({ expired: scoreExpired, connected });
  const standing = record.standing;
  const cooling =
    standing?.cooldownUntil && Date.parse(standing.cooldownUntil) > Date.now()
      ? standing.cooldownUntil
      : undefined;
  // Registered by an earlier owner: the new owner rates under their own config.
  const handsChanged = Boolean(
    registryOwner && record.owner && registryOwner.toLowerCase() !== record.owner.toLowerCase(),
  );
  const gatewayUrl = token?.gatewayUrl ?? runner.data?.gatewayUrl ?? null;
  const commandInput = token && {
    gatewayUrl: gatewayUrl ?? "<gateway URL>",
    token: token.value,
    mode,
    teeUrl: record.tee?.url ?? null,
  };

  async function act(kind: NonNullable<typeof busy>, fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  }
  const makeToken = () =>
    act("token", async () => {
      const made = await createRunnerToken(signMessageAsync, agentId);
      setToken({ value: made.token, gatewayUrl: made.gatewayUrl });
      await runner.refetch();
    });
  const revoke = () =>
    act("revoke", async () => {
      await revokeRunnerToken(signMessageAsync, agentId);
      setToken(undefined);
      await runner.refetch();
    });
  const rate = () =>
    act("rate", async () => {
      const { runId: id } = await requestRating(signMessageAsync, agentId);
      setRunId(id);
      onRated?.();
    });

  const caps = record.coverCaps;
  return (
    <Card
      title={readOnly ? "Its runner" : "Connect your agent"}
      description={
        readOnly
          ? "This agent runs on its operator's servers. A small runner next to it connects out to the Arena, and the Arena attacks the agent through it."
          : "Your agent runs where it runs. A small runner next to it connects out to the Arena, and the Arena attacks the agent through it."
      }
      actions={
        <Badge tone={view.tone} dot>
          Runner {view.label}
        </Badge>
      }
    >
      <div className="flex flex-col gap-5 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 [&_dt]:text-muted">
          <dt>Mode</dt>
          <dd>
            {mode === "chain"
              ? "Chain: it signs its own transactions to its vault"
              : "Tools: it reads and trades through MCP or HTTP tools"}
          </dd>
          <dt>Code hash</dt>
          <dd className="truncate font-mono text-xs" title={record.codeHash}>
            {record.codeHash}
          </dd>
          <dt>TEE</dt>
          <dd className="truncate">
            {record.tee ? (
              <>
                <span className="font-mono text-xs">{record.tee.url}</span>: every episode must
                prove it
              </>
            ) : (
              "None: the binding will be declared"
            )}
          </dd>
        </dl>

        {standing?.superseded && (
          <p
            role="alert"
            className="rounded-xl border border-breach/35 bg-breach-soft px-3.5 py-2.5"
          >
            Its score is superseded: the latest rating was stopped by the agent (
            {standing.superseded.reason}). No new cover until a complete rating posts.
            {cooling &&
              ` The next rating can start ${when(Math.floor(Date.parse(cooling) / 1000))}; the wait doubles with each stop in a row, up to 48 hours.`}
          </p>
        )}
        {readOnly ? (
          <section className="flex flex-col gap-2">
            <p className="text-muted">
              {connected
                ? "Its runner is connected, so the Arena can rate it and renew its score."
                : runner.data?.runner
                  ? `Its runner is offline (last seen ${when(Math.floor(Date.parse(runner.data.runner.lastHeartbeatAt) / 1000))}).`
                  : "Its runner hasn't connected yet."}{" "}
              Only the agent's owner can make a runner token or ask for a rating: connect the
              owner's wallet.
            </p>
            {lapse && (
              <p className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5">{lapse}</p>
            )}
            {runner.data?.lastSkip && (
              <p className="text-xs text-muted">
                Skipped {when(Math.floor(Date.parse(runner.data.lastSkip.at) / 1000))}:{" "}
                {runner.data.lastSkip.reason}.
              </p>
            )}
          </section>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">1. Runner token</h3>
              <p className="text-muted">
                The token says which agent the runner is for. It is shown once; a new one replaces
                the old, and a runner using the old one is disconnected.
                {runner.data?.token &&
                  ` Current token made ${when(Math.floor(Date.parse(runner.data.token.createdAt) / 1000))}.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  loading={busy === "token"}
                  disabled={Boolean(busy)}
                  onClick={makeToken}
                >
                  {busy === "token"
                    ? "Sign in your wallet…"
                    : runner.data?.token
                      ? "Replace the token"
                      : "Create a runner token"}
                </Button>
                {runner.data?.token && (
                  <Button
                    size="sm"
                    kind="secondary"
                    loading={busy === "revoke"}
                    disabled={Boolean(busy)}
                    onClick={revoke}
                  >
                    Revoke it
                  </Button>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">2. Start the runner where your agent runs</h3>
              {commandInput ? (
                <>
                  <p className="text-muted">
                    Copy it now: the token won't be shown again. Replace{" "}
                    <code className="font-mono text-xs">&lt;your agent command&gt;</code> with how
                    you start your agent; the runner starts it once per attack with the Arena's
                    addresses in its environment. For Docker, build your agent into an image from
                    the runner's.
                  </p>
                  <CommandLine label="With Node" text={runnerCommand(commandInput)} />
                  <CommandLine label="With Docker" text={runnerDockerCommand(commandInput)} />
                </>
              ) : (
                <p className="text-muted">
                  Create a token to get the command. It looks like{" "}
                  <code className="font-mono text-xs">
                    BONDED_RUNNER_TOKEN=… npx @bonded/runner --gateway … -- &lt;your agent
                    command&gt;
                  </code>
                  .
                </p>
              )}
              <p className="text-xs text-muted">{runner.data?.problem ?? view.hint}</p>
              {runner.data?.runner && !connected && (
                <p className="text-xs text-muted">
                  Last seen{" "}
                  {when(Math.floor(Date.parse(runner.data.runner.lastHeartbeatAt) / 1000))}.
                </p>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">3. Rate it</h3>
              <p className="text-muted">
                Every published attack runs five times against your agent, plus a held-out set made
                for this rating alone, then the signed score is posted on chain. The rating stops at
                the first episode your agent fails (a crash, an error exit, a timeout) and has a
                time limit; a stopped rating stays in the history below and doesn't change the
                score. While the runner stays connected, the score is renewed in its last 3 days.
              </p>
              {lapse && (
                <p className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5">
                  {lapse}
                </p>
              )}
              {runner.data?.lastSkip && (
                <p className="text-xs text-muted">
                  Skipped {when(Math.floor(Date.parse(runner.data.lastSkip.at) / 1000))}:{" "}
                  {runner.data.lastSkip.reason}.
                </p>
              )}
              {expectedLine(record.expectedRating) && (
                <p className="text-xs text-muted">{expectedLine(record.expectedRating)}</p>
              )}
              {handsChanged && (
                <p className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5">
                  This agent changed hands since it was registered. Re-register it to rate under
                  your own config.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={
                    Boolean(busy) ||
                    !connected ||
                    Boolean(waiting) ||
                    running ||
                    Boolean(cooling) ||
                    handsChanged
                  }
                  loading={busy === "rate"}
                  onClick={rate}
                >
                  {busy === "rate" ? "Sign in your wallet…" : "Rate my agent"}
                </Button>
                {!connected && <span className="text-xs text-muted">Start the runner first.</span>}
                {waiting && (
                  <span className="text-xs text-muted">
                    One rating an hour per agent; next from{" "}
                    {when(Date.parse(record.nextRatingAt!) / 1000)}.
                  </span>
                )}
              </div>
              {runId && (
                <p>
                  Rating{" "}
                  <Badge
                    tone={
                      run.data?.status === "failed"
                        ? "breach"
                        : run.data?.status === "done"
                          ? "safe"
                          : "neutral"
                    }
                  >
                    {run.data?.status ?? "queued"}
                  </Badge>{" "}
                  {run.data?.status === "done" ? (
                    "The new score is above."
                  ) : run.data?.status === "failed" ? (
                    ratingFailure(run.data)
                  ) : (
                    <>
                      {progressLine(run.data?.progress)
                        ? `${progressLine(run.data?.progress)}. `
                        : "Waiting for the first episode. "}
                      Watch them live in the{" "}
                      <Link to={`/arena?run=${runId}`} className={linkClass}>
                        Arena
                      </Link>
                      .
                    </>
                  )}
                </p>
              )}
              {runner.data?.attempts && runner.data.attempts.length > 0 && (
                <Attempts agentId={agentId} attempts={runner.data.attempts} />
              )}
            </section>
          </>
        )}

        {caps && (
          <p className="border-t border-line pt-4 text-xs text-muted">
            Cover limit (underwriting policy, not the score): up to{" "}
            {caps.declared.toLocaleString("en-US")} tUSDG while the binding is{" "}
            {BINDING_LABELS.declared.label.toLowerCase()}, and {caps.tee.toLocaleString("en-US")}{" "}
            tUSDG when every episode proves a TEE.{" "}
            <a className={linkClass} href={DOCS_BYOA}>
              How it works
            </a>
          </p>
        )}
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

/** One copyable command line. */
function CommandLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-soft">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-full px-2.5 py-1 text-xs font-semibold text-accent hover:bg-white/[0.06]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-xl bg-black/40 p-3.5 font-mono text-xs whitespace-pre-wrap break-all text-soft">
        {text}
      </pre>
    </div>
  );
}

/** A short line on a score's binding, for the report. */
export function BindingLine({ binding }: { binding: BindingLevel }) {
  const b = BINDING_LABELS[binding];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={binding === "tee" ? "safe" : "warn"}>{b.label}</Badge>
      <span className="text-xs text-muted">{b.hint}</span>
    </span>
  );
}

/** The agent's ratings, newest first: the stopped and failed ones too, so none is hidden. */
function Attempts({ agentId, attempts }: { agentId: string; attempts: RatingAttempt[] }) {
  const [older, setOlder] = useState<RatingAttempt[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(attempts.length >= 10);
  const loadOlder = async () => {
    const next = await api.ratings(agentId, page + 1);
    setOlder((list) => [...list, ...next.items]);
    setPage(next.page);
    setMore(next.page < next.pages);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-soft">Ratings</span>
      <ul className="flex flex-col gap-1.5 text-xs">
        {[...attempts, ...older].map((a) => (
          <li key={a.runId} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="text-muted">{when(Math.floor(Date.parse(a.createdAt) / 1000))}</span>
              <Badge
                tone={a.status === "done" ? "safe" : a.status === "failed" ? "breach" : "neutral"}
              >
                {a.status === "done" && a.score !== null ? `score ${a.score}` : a.status}
              </Badge>
              {a.agentCaused && <span className="text-breach">caused by the agent</span>}
              {a.error && <span className="text-muted">{a.error}</span>}
            </span>
            {a.agentReport && (
              <span className="pl-1 text-muted">
                Reported by the runner: <span className="font-mono break-all">{a.agentReport}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {more && (
        <button
          type="button"
          onClick={() => void loadOlder()}
          className="self-start text-xs text-accent hover:underline"
        >
          Show older ratings
        </button>
      )}
    </div>
  );
}

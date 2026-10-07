import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import type { BindingLevel, RemoteMode } from "@bonded/shared";
import { api, type SelfAgentRecord } from "../lib/api";
import {
  BINDING_LABELS,
  lapseReason,
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
}: {
  agentId: string;
  record: Registered;
  /** The agent has a score and it has expired. */
  scoreExpired: boolean;
  onRated?: () => void;
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
  const progress = useQuery({
    queryKey: ["run-episodes", runId],
    queryFn: () => api.episodes({ runId: runId!, limit: 1 }),
    enabled: running,
    refetchInterval: 5_000,
  });

  const mode: RemoteMode = record.mode ?? "tools";
  const view = runnerView(runner.data);
  const connected = runner.data?.runner?.connected === true;
  const waiting = record.nextRatingAt && new Date(record.nextRatingAt) > new Date();
  const lapse = lapseReason({ expired: scoreExpired, connected });
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
      title="Connect your agent"
      description="Your agent runs where it runs. A small runner next to it connects out to the Arena, and the Arena attacks the agent through it."
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

        <section className="flex flex-col gap-3">
          <h3 className="font-semibold">1. Runner token</h3>
          <p className="text-muted">
            The token says which agent the runner is for. It is shown once; a new one replaces the
            old, and a runner using the old one is disconnected.
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
                <code className="font-mono text-xs">&lt;your agent command&gt;</code> with how you
                start your agent; the runner starts it once per attack with the Arena's addresses in
                its environment. For Docker, build your agent into an image from the runner's.
              </p>
              <CommandLine label="With Node" text={runnerCommand(commandInput)} />
              <CommandLine label="With Docker" text={runnerDockerCommand(commandInput)} />
            </>
          ) : (
            <p className="text-muted">
              Create a token to get the command. It looks like{" "}
              <code className="font-mono text-xs">
                BONDED_RUNNER_TOKEN=… npx @bonded/runner --gateway … -- &lt;your agent command&gt;
              </code>
              .
            </p>
          )}
          <p className="text-xs text-muted">{runner.data?.problem ?? view.hint}</p>
          {runner.data?.runner && !connected && (
            <p className="text-xs text-muted">
              Last seen {when(Math.floor(Date.parse(runner.data.runner.lastHeartbeatAt) / 1000))}.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="font-semibold">3. Rate it</h3>
          <p className="text-muted">
            Every attack in the library runs five times against your agent, plus a held-out set made
            for this rating alone, then the signed score is posted on chain. While the runner stays
            connected, the score is renewed in its last 3 days.
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
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={Boolean(busy) || !connected || Boolean(waiting) || running}
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
                  {progress.data?.total
                    ? `${progress.data.total} episodes so far. `
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
        </section>

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

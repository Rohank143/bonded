import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSignMessage } from "wagmi";
import type { BindingLevel, RemoteMode } from "@bonded/shared";
import { api, type RatingAttempt, type SelfAgentRecord } from "../lib/api";
import { BINDING_LABELS, expectedLine, lapseReason, runnerView } from "../lib/byoa";
import { requestRating, revokeRunnerToken } from "../lib/self-serve";
import type { Auth, Connection, Subject } from "../lib/byoa-api";
import {
  codeSourceLabel,
  isConnected,
  passingCheck,
  statusFromRunner,
  type ConnectionStatus,
} from "../lib/connect";
import { when } from "../lib/format";
import { DOCS_BYOA } from "../lib/routes";
import { deployment } from "../config";
import { CONNECTION_TEXT, ConnectStep, ConnectionChoice } from "./connection-setup";
import { ConnectionCheck } from "./connection-check";
import { Estimate, NotificationSettingsForm, RatingLive } from "./rating-live";
import { Badge, Button, Card, ErrorText, Loading, Unavailable, linkClass } from "./ui";

type Registered = Extract<SelfAgentRecord, { registered: true }>;

/** The connection's state as a badge: the runner's, or the Agent URL's. */
function connectionBadge(status: ConnectionStatus, connection: Connection) {
  if (connection === "url")
    return status.agentUrl?.verifiedAt
      ? { tone: "safe" as const, label: "URL verified" }
      : { tone: "neutral" as const, label: "URL not set" };
  const view = runnerView({
    token: status.hasToken ? { id: "", createdAt: "" } : null,
    runner: status.runner,
    lastSkip: null,
    gatewayUrl: status.gatewayUrl,
  });
  return { tone: view.tone, label: `Runner ${view.label}` };
}

/**
 * Connect an agent on chain and check the connection: choose its URL or the runner, set it up,
 * and run a connection check. Used on the agent's page and right after onboarding.
 */
export function ConnectAndCheck({
  agentId,
  status,
  refresh,
  teeUrl,
  initialConnection,
  initialUrl,
  headingLevel = "h3",
  showBadge = true,
}: {
  agentId: string;
  status: ConnectionStatus;
  refresh: () => unknown;
  teeUrl?: string | null;
  initialConnection?: Connection;
  initialUrl?: string;
  headingLevel?: "h2" | "h3";
  /** Off where the card's own badge already shows the runner's state. */
  showBadge?: boolean;
}) {
  const { signMessageAsync } = useSignMessage();
  const [connection, setConnection] = useState<Connection>(initialConnection ?? status.connection);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const subject: Subject = { kind: "agent", agentId };
  const auth: Auth = { sign: signMessageAsync };
  // The check is for the connection chosen here: a check of the other one doesn't count.
  const current: ConnectionStatus = { ...status, connection };
  const H = headingLevel;
  const revoke = async () => {
    setRevoking(true);
    setError(null);
    try {
      await revokeRunnerToken(signMessageAsync, agentId);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setRevoking(false);
    }
  };
  return (
    <>
      <section className="flex flex-col gap-3">
        <H className="font-semibold">1. How it connects</H>
        <ConnectionChoice
          connection={connection}
          mode={status.mode}
          onConnection={setConnection}
          name={`agent-${agentId}`}
        />
        {connection !== status.connection && (status.agentUrl || status.hasToken) && (
          <p className="text-xs text-muted">
            It's connected {status.connection === "url" ? "by its URL" : "by its runner"} now.
            Setting up the other way switches it, and needs a new connection check.
          </p>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <H className="font-semibold">2. Connect it</H>
        <ConnectStep
          subject={subject}
          auth={auth}
          status={current}
          connection={connection}
          onChanged={refresh}
          showBadge={showBadge}
          {...(teeUrl !== undefined ? { teeUrl } : {})}
          {...(initialUrl ? { initialUrl } : {})}
        />
        {connection === "runner" && status.hasToken && (
          <div>
            <Button size="sm" kind="ghost" loading={revoking} onClick={() => void revoke()}>
              {revoking ? "Sign in your wallet…" : "Revoke the runner token"}
            </Button>
          </div>
        )}
        <ErrorText error={error} />
      </section>
      <section className="flex flex-col gap-3">
        <H className="font-semibold">3. Check the connection</H>
        <ConnectionCheck
          key={`${agentId}:${connection}`}
          subject={subject}
          auth={auth}
          status={current}
          ready={isConnected(current)}
          notReadyReason={
            connection === "url"
              ? "Verify its URL first."
              : "Start the runner first: the check runs through it."
          }
          onFinished={refresh}
        />
      </section>
    </>
  );
}

/** Right after onboarding: connect the new agent and check it, before its first rating. */
export function NewAgentConnection({
  agentId,
  mode,
  initialConnection,
  initialUrl,
}: {
  agentId: string;
  mode: RemoteMode;
  initialConnection?: Connection;
  initialUrl?: string;
}) {
  const runner = useQuery({
    queryKey: ["runner", agentId],
    queryFn: () => api.runner(agentId),
    refetchInterval: 5_000,
  });
  if (runner.isPending) return <Loading what="its connection" />;
  if (runner.error)
    return <Unavailable error={runner.error} onRetry={() => void runner.refetch()} />;
  return (
    <div className="flex flex-col gap-5 text-sm">
      <ConnectAndCheck
        agentId={agentId}
        status={statusFromRunner(runner.data, mode)}
        refresh={() => runner.refetch()}
        {...(initialConnection ? { initialConnection } : {})}
        {...(initialUrl ? { initialUrl } : {})}
      />
    </div>
  );
}

/**
 * "Connect your agent": the owner's controls for an agent they run themselves (bring your own
 * agent). Connect it (its URL, or the runner), pass a connection check, see the estimate, rate it
 * and follow the rating. Shown only to the owner; others see the runner's state, read-only.
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
  // Everything the owner did here belongs to one agent: a rating or error that finished after
  // the page moved on to another agent is never shown for this one.
  const identity = `${deployment.chainId}:${agentId}`;
  const [asked, setRunId] = useState<{ for: string; id: string }>();
  const [busy, setBusy] = useState<string>();
  const [failed, setError] = useState<{ for: string; error: unknown }>();
  const runId = asked?.for === identity ? asked.id : undefined;
  const error = failed?.for === identity ? failed.error : null;
  const working = busy === identity;
  const runner = useQuery({
    queryKey: ["runner", agentId],
    queryFn: () => api.runner(agentId),
    refetchInterval: 10_000,
  });
  const [finished, setFinished] = useState<string>();
  const running = Boolean(runId) && finished !== runId;

  const mode: RemoteMode = record.mode ?? "tools";
  const status = statusFromRunner(runner.data, mode, record.codeHash);
  const connected = isConnected(status);
  const checked = passingCheck(status);
  const badge = connectionBadge(status, status.connection);
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

  const rate = async () => {
    const forId = identity;
    setBusy(forId);
    setError(undefined);
    try {
      const { runId: id } = await requestRating(signMessageAsync, agentId);
      setRunId({ for: forId, id });
      onRated?.();
    } catch (e) {
      setError({ for: forId, error: e });
    } finally {
      setBusy((b) => (b === forId ? undefined : b));
    }
  };
  const rateBlocked = !connected
    ? status.connection === "url"
      ? "Verify its URL first."
      : "Start the runner first."
    : !checked
      ? "Pass a connection check first."
      : undefined;

  const caps = record.coverCaps;
  return (
    <Card
      title={readOnly ? "Its runner" : "Connect your agent"}
      description={
        readOnly
          ? "This agent runs on its operator's servers. The Arena reaches it through a small runner next to it, or at its URL, and attacks it there."
          : "Your agent runs where it runs. Bonded reaches it at its URL, or through a small runner next to it, and attacks it there."
      }
      actions={
        <Badge tone={badge.tone} dot>
          {badge.label}
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
          <dt>Connection</dt>
          <dd>
            {status.connection === "url" ? (
              status.agentUrl ? (
                <span className="font-mono text-xs break-all">{status.agentUrl.url}</span>
              ) : (
                CONNECTION_TEXT.url.title
              )
            ) : (
              "The runner, next to the agent"
            )}
          </dd>
          <dt>Code hash</dt>
          <dd className="min-w-0">
            {status.codeHash ? (
              <>
                <span className="block truncate font-mono text-xs" title={status.codeHash.value}>
                  {status.codeHash.value}
                </span>
                <span className="text-xs text-muted">From {codeSourceLabel(status.codeHash)}.</span>
              </>
            ) : (
              <span className="text-muted">
                Fills itself in when the agent first connects: the runner reports your commit or
                image, an Agent URL its version.
              </span>
            )}
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
        {runner.error && !runner.data && (
          <Unavailable error={runner.error} onRetry={() => void runner.refetch()} />
        )}
        {readOnly ? (
          <section className="flex flex-col gap-2">
            <p className="text-muted">
              {connected
                ? status.connection === "url"
                  ? "Its URL is verified, so the Arena can rate it and renew its score."
                  : "Its runner is connected, so the Arena can rate it and renew its score."
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
            {runner.isPending ? (
              <Loading what="its connection" />
            ) : (
              <ConnectAndCheck
                key={identity}
                agentId={agentId}
                status={status}
                refresh={() => runner.refetch()}
                teeUrl={record.tee?.url ?? null}
                showBadge={false}
              />
            )}

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">4. Rate it</h3>
              <p className="text-muted">
                Every published attack runs against your agent, plus a held-out set made for this
                rating alone, then the signed score is posted on chain. The rating stops at the
                first episode your agent fails (a crash, an error exit, a timeout) and has a time
                limit; a stopped rating stays in the history below and doesn't change the score.
                While it stays connected, the score is renewed in its last 3 days.
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
              <Estimate subject={{ kind: "agent", agentId }} enabled={Boolean(checked)} />
              {handsChanged && (
                <p className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5">
                  This agent changed hands since it was registered. Re-register it to rate under
                  your own config.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={
                    working ||
                    Boolean(rateBlocked) ||
                    Boolean(waiting) ||
                    running ||
                    Boolean(cooling) ||
                    handsChanged
                  }
                  loading={working}
                  onClick={() => void rate()}
                >
                  {working ? "Sign in your wallet…" : "Rate my agent"}
                </Button>
                {rateBlocked && <span className="text-xs text-muted">{rateBlocked}</span>}
                {waiting && (
                  <span className="text-xs text-muted">
                    One rating an hour per agent; next from{" "}
                    {when(Date.parse(record.nextRatingAt!) / 1000)}.
                  </span>
                )}
              </div>
              {runId && (
                <RatingLive
                  key={runId}
                  runId={runId}
                  label="Your agent's rating"
                  doneText="The new score is above."
                  onFinished={() => {
                    setFinished(runId);
                    void runner.refetch();
                  }}
                />
              )}
              <NotificationSettingsForm
                subject={{ kind: "agent", agentId }}
                auth={{ sign: signMessageAsync }}
              />
              {runner.data?.attempts && runner.data.attempts.length > 0 && (
                <Attempts key={identity} agentId={agentId} attempts={runner.data.attempts} />
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

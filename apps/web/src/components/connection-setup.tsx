import { useEffect, useRef, useState } from "react";
import type { RemoteMode } from "@bonded/shared";
import { runnerCommand, runnerDockerCommand, runnerView } from "../lib/byoa";
import {
  byoaApi,
  type AgentUrlRegistered,
  type Auth,
  type Connection,
  type Subject,
} from "../lib/byoa-api";
import {
  agentUrlError,
  codeSourceLabel,
  isConnected,
  problemAdvice,
  type ConnectionStatus,
} from "../lib/connect";
import { snippets } from "../lib/snippets";
import { when } from "../lib/format";
import { DOCS_BYOA } from "../lib/routes";
import { ApiError } from "../lib/api";
import { Badge, Button, Choice, ErrorText, Input, linkClass } from "./ui";
import { CopyBlock, SecretOnce, Tabs } from "./copy";

/** The one-line explanations of each choice, shared by every place that offers them. */
export const CONNECTION_TEXT: Record<Connection, { title: string; line: string }> = {
  url: {
    title: "It's online (paste its URL)",
    line: "Bonded sends each episode to your agent's HTTPS address. Nothing to install.",
  },
  runner: {
    title: "It runs on my machine (use the runner)",
    line: "A small runner next to your agent connects out to Bonded and starts your agent for each episode. No open ports.",
  },
};
export const MODE_TEXT: Record<RemoteMode, { title: string; line: string }> = {
  tools: {
    title: "Tools",
    line: "It reads and trades through tool calls (MCP or HTTP). The easiest to connect.",
  },
  chain: {
    title: "Chain",
    line: "It reads through tools and signs its own transactions to its vault, as in production.",
  },
};

/** How the agent runs (URL or runner) and how it acts (tools or chain). */
export function ConnectionChoice({
  connection,
  mode,
  onConnection,
  onMode,
  name = "connect",
}: {
  connection: Connection;
  mode: RemoteMode;
  onConnection: (c: Connection) => void;
  /** Omit to hide the mode choice (it's fixed, e.g. by the agent's registration). */
  onMode?: (m: RemoteMode) => void;
  name?: string;
}) {
  return (
    <div className="flex flex-col gap-5 text-sm">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium">How your agent runs</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["url", "runner"] as const).map((c) => (
            <Choice
              key={c}
              name={`${name}-connection`}
              checked={connection === c}
              onChange={() => onConnection(c)}
              title={CONNECTION_TEXT[c].title}
            >
              {CONNECTION_TEXT[c].line}
            </Choice>
          ))}
        </div>
      </fieldset>
      {onMode && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium">How it acts</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["tools", "chain"] as const).map((m) => (
              <Choice
                key={m}
                name={`${name}-mode`}
                checked={mode === m}
                onChange={() => onMode(m)}
                title={MODE_TEXT[m].title}
              >
                {MODE_TEXT[m].line}
              </Choice>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Whether a write signs in the wallet (an agent on chain) or uses the preview's session. */
const signs = (auth: Auth) => "sign" in auth;

/**
 * The runner: make its token (shown once, prefilled into the commands), copy the command, and see
 * the runner connect. With a preview session the token is made straight away, no signature.
 */
export function ConnectRunner({
  subject,
  auth,
  status,
  onChanged,
  teeUrl,
  autoCreate = false,
  showBadge = true,
}: {
  subject: Subject;
  auth: Auth;
  status: ConnectionStatus;
  onChanged: () => unknown;
  teeUrl?: string | null;
  /** Make the token as soon as this shows (previews: it costs no signature). */
  autoCreate?: boolean;
  /** Off where the runner's state already shows nearby. */
  showBadge?: boolean;
}) {
  const [token, setToken] = useState<{ value: string; gatewayUrl: string | null }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const made = useRef(false);
  const view = runnerView({
    token: status.hasToken || token ? { id: "", createdAt: "" } : null,
    runner: status.runner,
    lastSkip: null,
    gatewayUrl: status.gatewayUrl,
  });
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await byoaApi.createRunnerToken(subject, auth);
      setToken({ value: t.token, gatewayUrl: t.gatewayUrl });
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoCreate && !status.hasToken && !made.current) {
      made.current = true;
      void create();
    }
    // Only once, when the step first shows.
  }, [autoCreate]);
  const gatewayUrl = token?.gatewayUrl ?? status.gatewayUrl ?? "<gateway URL>";
  const input = token && {
    gatewayUrl,
    token: token.value,
    mode: status.mode,
    teeUrl: teeUrl ?? null,
  };
  const connected = isConnected(status, "runner");
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted">
          Run this where your agent runs. It starts your agent once per episode, with the episode's
          addresses in its environment.
        </p>
        {showBadge && (
          <Badge tone={view.tone} dot>
            Runner {view.label}
          </Badge>
        )}
      </div>
      {input ? (
        <>
          <CopyBlock
            label="With Node (npx)"
            text={runnerCommand(input)}
            note={
              <>
                Replace <code className="font-mono">&lt;your agent command&gt;</code> with how you
                start your agent, e.g. <code className="font-mono">node agent.js</code> or{" "}
                <code className="font-mono">python agent.py</code>.
              </>
            }
          />
          <CopyBlock
            label="With Docker"
            text={runnerDockerCommand(input)}
            note="Build your agent into an image FROM the runner's image first (see the guide)."
          />
          <p className="text-xs text-warn">
            The token is in these commands and won't be shown again. Copy them now.
          </p>
        </>
      ) : (
        <div className="flex min-h-24 flex-col gap-3 rounded-2xl border border-dashed border-line-strong p-4">
          <p className="text-muted">
            {status.hasToken
              ? "A runner token exists, but it's only shown once. If you didn't keep the command, make a new token: the old one stops working."
              : busy
                ? "Making your runner token…"
                : "The command needs a runner token, which says which agent the runner is for."}
          </p>
          <div>
            <Button size="sm" loading={busy} onClick={() => void create()}>
              {busy && signs(auth)
                ? "Sign in your wallet…"
                : status.hasToken
                  ? "Make a new token"
                  : "Create a runner token"}
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted" aria-live="polite">
        {status.problem ??
          (connected
            ? view.hint
            : status.runner && !status.runner.connected
              ? `The runner was last seen ${when(Math.floor(Date.parse(status.runner.lastHeartbeatAt) / 1000))}. Start it again.`
              : input || status.hasToken
                ? "Waiting for the runner to connect. This updates on its own."
                : null)}
      </p>
      <ErrorText error={error} />
      <Snippets
        connection="runner"
        mode={status.mode}
        gatewayUrl={token?.gatewayUrl ?? status.gatewayUrl}
      />
    </div>
  );
}

/**
 * Agent URL: paste the address, Bonded verifies it owns it (a signed challenge it must echo),
 * then shows the agent secret once.
 */
export function ConnectUrl({
  subject,
  auth,
  status,
  onChanged,
  initialUrl,
  onSecret,
}: {
  subject: Subject;
  auth: Auth;
  status: ConnectionStatus;
  onChanged: () => unknown;
  initialUrl?: string;
  /**
   * Told when a secret is on screen (true) and when the owner says it's saved (false), so a
   * flow that moves on by itself can wait: the secret is never shown again.
   */
  onSecret?: (showing: boolean) => void;
}) {
  const [url, setUrl] = useState(status.agentUrl?.url ?? initialUrl ?? "");
  const [touched, setTouched] = useState(false);
  const [editing, setEditing] = useState(!status.agentUrl?.verifiedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [registered, setRegistered] = useState<AgentUrlRegistered>();
  const invalid = agentUrlError(url);
  const verify = async () => {
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await byoaApi.registerAgentUrl(subject, auth, url.trim());
      setRegistered(r);
      setEditing(false);
      onSecret?.(true);
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const failure = error instanceof ApiError && error.status < 500 ? error.message : undefined;
  const advice = failure ? problemAdvice(failure, "url") : undefined;
  const shown = registered ?? status.agentUrl;
  const codeHash = registered?.codeHash ?? status.codeHash;
  return (
    <div className="flex flex-col gap-4 text-sm">
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <Input
            label="Your agent's URL"
            hint="Public https. Bonded POSTs each episode here, signed with your agent secret."
            value={url}
            onChange={setUrl}
            placeholder="https://my-agent.example.com/bonded"
            error={url || touched ? invalid : null}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              loading={busy}
              disabled={Boolean(url) && Boolean(invalid)}
            >
              {busy ? (signs(auth) ? "Sign in your wallet…" : "Verifying…") : "Verify it"}
            </Button>
            {status.agentUrl?.verifiedAt && (
              <Button size="sm" kind="ghost" onClick={() => setEditing(false)}>
                Keep the current URL
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">
            To verify, Bonded sends{" "}
            <code className="font-mono">{'{ "type": "verify", "challenge": "…" }'}</code>; your
            agent answers 200 with the same challenge within 10 seconds. The handler snippet below
            does it for you.
          </p>
        </form>
      ) : (
        shown && (
          <div className="flex flex-col gap-2 rounded-2xl border border-safe/30 bg-safe-soft p-4">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="safe" dot>
                Verified
              </Badge>
              <span className="font-mono text-xs break-all">{shown.url}</span>
            </p>
            <p className="text-xs text-soft">
              It answered the challenge
              {shown.verifiedAt ? ` ${when(Math.floor(Date.parse(shown.verifiedAt) / 1000))}` : ""}
              {shown.version ? `, reporting version ${shown.version}` : ", without a version"}.
              {codeHash && ` Code hash from ${codeSourceLabel(codeHash)}.`}
            </p>
            <div>
              <Button size="sm" kind="secondary" onClick={() => setEditing(true)}>
                Change the URL
              </Button>
            </div>
          </div>
        )
      )}
      {failure ? (
        <div role="alert" className="rounded-2xl border border-breach/35 bg-breach-soft p-4">
          <p className="font-semibold">{failure}</p>
          {advice && <p className="mt-1 text-soft">{advice}</p>}
        </div>
      ) : (
        <ErrorText error={error} />
      )}
      {registered && (
        <SecretOnce label="Your agent secret" value={registered.secret}>
          Set it as <code className="font-mono">BONDED_AGENT_SECRET</code> where your agent runs. It
          checks that each call really comes from Bonded. Changing the URL makes a new secret.
          {onSecret && (
            <div className="mt-3">
              <Button size="sm" onClick={() => onSecret(false)}>
                I've saved it, continue
              </Button>
            </div>
          )}
        </SecretOnce>
      )}
      <Snippets connection="url" mode={status.mode} />
    </div>
  );
}

/** Framework snippets in tabs: the episode's tools in one call, per framework. */
export function Snippets({
  connection,
  mode,
  gatewayUrl,
}: {
  connection: Connection;
  mode: RemoteMode;
  gatewayUrl?: string | null;
}) {
  const list = snippets(connection, mode, gatewayUrl);
  const [selected, setSelected] = useState(list[0]!.id);
  const current = list.find((s) => s.id === selected) ?? list[0]!;
  return (
    <details className="group rounded-2xl border border-line-strong p-4">
      <summary className="cursor-pointer text-sm font-semibold marker:text-muted">
        {connection === "url"
          ? "Code for your agent: the handler and frameworks"
          : "Code for your agent, by framework"}
      </summary>
      <div className="mt-4">
        <Tabs
          label="Framework"
          tabs={list.map((s) => ({ id: s.id, label: s.label }))}
          selected={current.id}
          onSelect={setSelected}
        >
          <div className="flex flex-col gap-3">
            {current.install && <CopyBlock label="Install" text={current.install} />}
            <CopyBlock label={current.label} text={current.code} note={current.note} />
          </div>
        </Tabs>
        <p className="mt-3 text-xs text-muted">
          More in the{" "}
          <a className={linkClass} href={DOCS_BYOA}>
            guide
          </a>
          .
        </p>
      </div>
    </details>
  );
}

/** Connect through whichever connection is chosen. */
export function ConnectStep(props: {
  subject: Subject;
  auth: Auth;
  status: ConnectionStatus;
  connection: Connection;
  onChanged: () => unknown;
  teeUrl?: string | null;
  autoCreate?: boolean;
  showBadge?: boolean;
  /** A URL to start the form with (e.g. carried over from a preview). */
  initialUrl?: string;
  onSecret?: (showing: boolean) => void;
}) {
  // Keyed by what it connects, so a token or secret made for one agent never shows on another.
  const k =
    props.subject.kind === "agent"
      ? `agent:${props.subject.agentId}`
      : `preview:${props.subject.id}`;
  return props.connection === "url" ? (
    <ConnectUrl
      key={k}
      subject={props.subject}
      auth={props.auth}
      status={props.status}
      onChanged={props.onChanged}
      {...(props.initialUrl ? { initialUrl: props.initialUrl } : {})}
      {...(props.onSecret ? { onSecret: props.onSecret } : {})}
    />
  ) : (
    <ConnectRunner
      key={k}
      subject={props.subject}
      auth={props.auth}
      status={props.status}
      onChanged={props.onChanged}
      {...(props.teeUrl !== undefined ? { teeUrl: props.teeUrl } : {})}
      {...(props.autoCreate !== undefined ? { autoCreate: props.autoCreate } : {})}
      {...(props.showBadge !== undefined ? { showBadge: props.showBadge } : {})}
    />
  );
}

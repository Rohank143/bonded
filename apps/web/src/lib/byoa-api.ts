import type { RemoteMode } from "@bonded/shared";
import { apiUrl, deployment } from "../config";
import { request, type RunnerRecord } from "./api";
import { byoaMessage, type ByoaAction } from "./byoa-messages";
import { createRunnerToken, type Signer } from "./self-serve";

/**
 * The API calls behind "Test your agent", Agent URL mode, connection checks, progress, cost
 * estimates and notifications (bring your own agent, round 2). Each call is one function on
 * `byoaApi`, so tests can replace any of them with a fixture.
 *
 * A preview belongs to a wallet: the owner signs in once (`signIn`) and the session it returns
 * authorises that wallet's preview calls. An agent registered on chain is acted on as today:
 * each write is signed by its owner's wallet.
 */

/** How Bonded reaches the agent: the runner next to it, or a POST to its HTTPS Agent URL. */
export type Connection = "runner" | "url";
export const CONNECTIONS: readonly Connection[] = ["url", "runner"];

/** What a connection belongs to: a preview (no vault, no bond), or an agent on chain. */
export type Subject = { kind: "preview"; id: string } | { kind: "agent"; agentId: string };

/** How a request is authorised: a preview session, or the agent owner's wallet signature. */
export type Auth = { session: string } | { sign: Signer };

/** Where the code hash a rating records came from (the runner's `codeSource`, or the URL). */
export type CodeSource =
  "declared" | "flag" | "env" | "image" | "git" | "git-dirty" | "unpinned" | "url-version";

export interface CodeHashInfo {
  value: string;
  source: CodeSource | string;
  /** E.g. the commit, the image digest or the URL's version string. */
  detail?: string | null;
}

/** A registered Agent URL. Its secret is shown once, when it is registered, and never again. */
export interface AgentUrlInfo {
  url: string;
  verifiedAt: string | null;
  version: string | null;
}

/** POST …/agent-url: Bonded challenged the URL and it answered. */
export interface AgentUrlRegistered extends AgentUrlInfo {
  /** Signs every call Bonded makes to the URL (`bonded_as_…`). Shown once. */
  secret: string;
  codeHash: CodeHashInfo | null;
}

export interface CheckSummary {
  id: string;
  status: "running" | "passed" | "failed";
  createdAt: string;
  connection: Connection;
  /** A passing check lets a rating start until then (24 hours). */
  expiresAt?: string | null;
  problems?: string[];
}

/** What the agent reported using at `/done` (optional, never trusted). */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** One event of a connection check, as GET /checks/:id/events streams them. */
export type CheckEvent =
  | { type: "started" }
  | { type: "tool"; name: string; surface?: string | null; ok: boolean; error?: string }
  | { type: "tx"; ok: boolean; reason?: string }
  | {
      type: "done";
      exitCode?: number | null;
      durationMs: number;
      stdoutTail?: string;
      stderrTail?: string;
    }
  | {
      type: "result";
      passed: boolean;
      problems: string[];
      taskCompleted: boolean;
      toolsCalled: number;
      surfacesRead: string[];
      usage?: Usage | null;
    };

export type CheckResult = Extract<CheckEvent, { type: "result" }>;

/** GET /checks/:id: the check so far (for a page opened after it started, or a lost stream). */
export interface CheckRecord {
  id: string;
  status: CheckSummary["status"];
  events: CheckEvent[];
}

/** GET …/estimate: a rating's time and cost, extrapolated from the passing check. */
export interface CostEstimate {
  episodes: number;
  perEpisode: { toolCalls: number; seconds: number; costUsd?: number | null };
  total: { seconds: number; costUsd?: number | null };
  basis: string;
}

/** A rating's progress: counts and time only, never verdicts, until it finishes. */
export interface RatingProgress {
  done: number;
  total: number | null;
  etaSeconds: number | null;
  startedAt: string | null;
}

/** Where a finished, failed or refused rating is announced. Shown masked; never the secret. */
export interface NotificationSettings {
  webhook: { url: string } | null;
  email: string | null;
  /** This deployment can send email (an email provider is configured). */
  emailAvailable: boolean;
}

export type PreviewStatus =
  | "created"
  | "checking"
  | "ready"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "refused"
  | "stopped";

export interface PreviewRecord {
  id: string;
  chainId: number;
  owner: string;
  mode: RemoteMode;
  connection: Connection;
  status: PreviewStatus;
  createdAt: string;
  agentUrl: AgentUrlInfo | null;
  codeHash: CodeHashInfo | null;
  /** Its rating, once one started (the `ratings` row, kind "preview"). */
  ratingId: string | null;
  /** The runner token exists (never the token itself). */
  hasRunnerToken: boolean;
  runner: RunnerRecord["runner"];
  /** Why a runner that is there doesn't count (e.g. the other mode). */
  problem?: string | null;
  gatewayUrl: string | null;
  lastCheck: CheckSummary | null;
  /** Waiting to start: how many previews or official ratings are ahead of it. */
  queue?: { position: number } | null;
  /** Why it was refused or stopped, in a sentence. */
  reason?: string | null;
}

/** GET /previews/allowance: whether this wallet can start a preview now, and if not, when. */
export interface PreviewAllowance {
  allowed: boolean;
  /** In a sentence, when not allowed. */
  reason?: string | null;
  /** When the wallet's daily preview comes back, or the global cap resets. */
  retryAt?: string | null;
  /** Previews and official ratings ahead in the queue right now. */
  queued: number;
  /** What a preview runs, for the page to say before it starts. */
  plan?: { episodes: number; budgetSeconds: number } | null;
}

/** The signed-in wallet's preview session. */
export interface PreviewSession {
  session: string;
  wallet: string;
  expiresAt: string;
}

const now = () => Math.floor(Date.now() / 1000);

/** The API path of a subject's own endpoints. */
export function subjectPath(subject: Subject): string {
  return subject.kind === "preview"
    ? `/previews/${encodeURIComponent(subject.id)}`
    : `/self/agents/${subject.agentId}`;
}

/** Headers and body fields for an authorised write: a session, or a fresh wallet signature. */
async function authorise(
  subject: Subject,
  auth: Auth,
  action: ByoaAction,
  fields: Record<string, string> = {},
): Promise<{ headers: Record<string, string>; signed: Record<string, unknown> }> {
  if ("session" in auth)
    return { headers: { Authorization: `Bearer ${auth.session}` }, signed: {} };
  if (subject.kind !== "agent") throw new Error("a preview needs its session: sign in again");
  const timestamp = now();
  const signature = await auth.sign({
    message: byoaMessage({
      action,
      chainId: deployment.chainId,
      agentId: subject.agentId,
      fields,
      timestamp,
    }),
  });
  return { headers: {}, signed: { timestamp, signature } };
}

async function write<T>(
  method: "POST" | "PUT",
  path: string,
  subject: Subject,
  auth: Auth,
  action: ByoaAction,
  body: Record<string, unknown> = {},
  fields: Record<string, string> = {},
): Promise<T> {
  const { headers, signed } = await authorise(subject, auth, action, fields);
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ ...body, ...signed }),
  });
}

const bearer = (session: string) => ({ headers: { Authorization: `Bearer ${session}` } });

/**
 * Follow a server-sent event stream. Returns a function that closes it. Each `data:` line is
 * JSON; `onError` is told once when the stream drops for good (the browser retries on its own
 * first).
 */
export function streamEvents<T>(
  path: string,
  onEvent: (event: T) => void,
  onError?: (error: Error) => void,
): () => void {
  if (typeof EventSource === "undefined") {
    onError?.(new Error("this browser can't follow live updates"));
    return () => {};
  }
  const source = new EventSource(`${apiUrl}${path}`);
  source.onmessage = (m: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(m.data) as T);
    } catch {
      // A line that isn't JSON (a comment or keep-alive) is ignored.
    }
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onError?.(new Error("the live updates stopped"));
  };
  return () => source.close();
}

export const byoaApi = {
  /** POST /previews/session: sign in with the wallet once; the session authorises its previews. */
  signIn: async (sign: Signer, wallet: string): Promise<PreviewSession> => {
    const timestamp = now();
    const signature = await sign({
      message: byoaMessage({
        action: "sign-in",
        chainId: deployment.chainId,
        wallet,
        timestamp,
      }),
    });
    return request<PreviewSession>("/previews/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: deployment.chainId, wallet, timestamp, signature }),
    });
  },
  /** GET /previews/allowance?wallet=: can this wallet start a preview now. No sign-in needed. */
  previewAllowance: (wallet: string) =>
    request<PreviewAllowance>(`/previews/allowance?wallet=${encodeURIComponent(wallet)}`),
  /** GET /previews: the signed-in wallet's previews, newest first. */
  listPreviews: (session: string) =>
    request<{ items: PreviewRecord[] }>("/previews", bearer(session)),
  /** POST /previews: a new preview with its mode and connection. Nothing is made on chain. */
  createPreview: (session: string, input: { mode: RemoteMode; connection: Connection }) =>
    request<PreviewRecord>("/previews", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(session).headers },
      body: JSON.stringify(input),
    }),
  /** GET /previews/:id. */
  preview: (session: string, id: string) =>
    request<PreviewRecord>(subjectPath({ kind: "preview", id }), bearer(session)),
  /** POST …/runner-token: a runner token, shown once. An agent's goes through the existing call. */
  createRunnerToken: (
    subject: Subject,
    auth: Auth,
  ): Promise<{ token: string; gatewayUrl: string | null }> =>
    subject.kind === "agent" && "sign" in auth
      ? createRunnerToken(auth.sign, subject.agentId)
      : write("POST", `${subjectPath(subject)}/runner-token`, subject, auth, "runner-token"),
  /**
   * POST …/agent-url: register the agent's HTTPS endpoint. Bonded sends it a signed challenge
   * and it must echo it within 10 s; refused (422) with the reason in a sentence otherwise.
   */
  registerAgentUrl: (subject: Subject, auth: Auth, url: string) =>
    write<AgentUrlRegistered>(
      "POST",
      `${subjectPath(subject)}/agent-url`,
      subject,
      auth,
      "agent-url",
      { url },
      { url },
    ),
  /** POST …/checks: start a connection check: one benign episode, never scored. */
  startCheck: (subject: Subject, auth: Auth) =>
    write<{ checkId: string }>("POST", `${subjectPath(subject)}/checks`, subject, auth, "check"),
  /** GET /checks/:id: the events so far. */
  check: (checkId: string) => request<CheckRecord>(`/checks/${encodeURIComponent(checkId)}`),
  /** GET /checks/:id/events (SSE): each event as it happens, ending with `result`. */
  checkEvents: (
    checkId: string,
    onEvent: (event: CheckEvent) => void,
    onError?: (error: Error) => void,
  ) => streamEvents<CheckEvent>(`/checks/${encodeURIComponent(checkId)}/events`, onEvent, onError),
  /** GET …/estimate: from the latest passing check; 409 without one. */
  estimate: (subject: Subject) => request<CostEstimate>(`${subjectPath(subject)}/estimate`),
  /**
   * POST /previews/:id/rate: start the preview rating. 202 with the run id (and its place in the
   * queue); 409 without a passing check; 429 past the limits, with `retryAt`.
   */
  startPreviewRating: (session: string, id: string) =>
    request<{ runId: string; queue?: { position: number } | null }>(
      `${subjectPath({ kind: "preview", id })}/rate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(session).headers },
      },
    ),
  /** GET /ratings/:id/progress (SSE): counts and time left, never verdicts. */
  ratingProgress: (
    runId: string,
    onProgress: (progress: RatingProgress) => void,
    onError?: (error: Error) => void,
  ) =>
    streamEvents<RatingProgress>(
      `/ratings/${encodeURIComponent(runId)}/progress`,
      onProgress,
      onError,
    ),
  /** GET …/notifications: where the result is sent, masked. */
  notifications: (subject: Subject) =>
    request<NotificationSettings>(`${subjectPath(subject)}/notifications`),
  /**
   * PUT …/notifications: set or clear the webhook and the email. A new webhook gets a signing
   * secret, shown once.
   */
  saveNotifications: (
    subject: Subject,
    auth: Auth,
    input: { webhookUrl: string | null; email: string | null },
  ) =>
    write<NotificationSettings & { webhookSecret?: string | null }>(
      "PUT",
      `${subjectPath(subject)}/notifications`,
      subject,
      auth,
      "notifications",
      input,
      { webhook: input.webhookUrl ?? "none", email: input.email ?? "none" },
    ),
};

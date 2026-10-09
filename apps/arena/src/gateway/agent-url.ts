import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  AGENT_URL_ANSWER_MS,
  AGENT_URL_MAX_BODY_BYTES,
  AGENT_URL_MAX_RESPONSE_BYTES,
  type AgentUrlMessage,
  AgentUrlVerifyAnswer,
  agentUrlCodeHash,
  signAgentUrlRequest,
} from "@bonded/shared";
import { FetchTimeoutError, publicAddress, safeRequest, UnsafeUrlError } from "../safe-fetch.js";

/**
 * The gateway's side of Agent URL mode (the protocol is in @bonded/shared, agent-url.ts): every
 * call the Arena makes to an agent's own HTTPS endpoint. The URL is chosen by an untrusted
 * operator, so every call:
 * - goes through safe-fetch: https only, every resolved address public (checked when connecting),
 *   no redirects, one deadline for the whole call (AGENT_URL_ANSWER_MS) and at most
 *   AGENT_URL_MAX_RESPONSE_BYTES of the answer read;
 * - is refused for Bonded's own hosts (BONDED_OWN_HOSTS, the gateway's own URL, and any the
 *   caller adds), so the Arena can't be pointed at itself;
 * - is rate limited per host (a token bucket), whoever asks: a rating, a check or a registration;
 * - is signed with the agent secret.
 *
 * Failures come back as plain sentences for the operator ("Your URL answered 404"), never thrown.
 */

/** Bonded's own deployed hosts: never an agent URL (subdomains included). */
export const BONDED_OWN_HOSTS: readonly string[] = [
  "bonded-nu.vercel.app",
  "api-production-ba50.up.railway.app",
  "arena-worker-production.up.railway.app",
  "bonded-arena-gateway.up.railway.app",
];

export interface AgentUrlLimits {
  /** Deadline for each call, from the name lookup to the last byte of the answer. */
  answerMs: number;
  /** The most of an answer read. */
  maxResponseBytes: number;
  /** Calls per host per minute, on average, with this many in a burst. */
  callsPerMinute: number;
  callBurst: number;
}

export const DEFAULT_AGENT_URL_LIMITS: AgentUrlLimits = {
  answerMs: AGENT_URL_ANSWER_MS,
  maxResponseBytes: AGENT_URL_MAX_RESPONSE_BYTES,
  callsPerMinute: 30,
  callBurst: 10,
};

export interface AgentUrlClientOptions {
  /** Allow http and loopback addresses (a local CLI rating or tests only; never hosted). */
  allowLoopback?: boolean;
  /** More hosts to refuse, beyond BONDED_OWN_HOSTS (e.g. from an env variable). */
  refusedHosts?: readonly string[];
  limits?: Partial<AgentUrlLimits>;
}

/** The outcome of one call: the answer, or why there is none, as a sentence for the operator. */
export type AgentUrlCall =
  | { ok: true; status: number; text: string }
  | {
      ok: false;
      problem: string;
      /** The status the URL answered with, when it answered. */
      status?: number;
      /**
       * Who the failure is down to: "agent" (its URL refused, failed, timed out or isn't
       * allowed), or "bonded" (the per-host rate limit, so not the agent's fault).
       */
      caused: "agent" | "bonded";
    };

export type AgentUrlVerifyResult =
  | {
      ok: true;
      /** The version the agent reported, if any. */
      version?: string;
      /** keccak256("url:" + version), when it reported one. */
      codeHash?: `0x${string}`;
    }
  | { ok: false; problem: string };

interface Bucket {
  allowance: number;
  refilled: number;
}

export class AgentUrlClient {
  readonly limits: AgentUrlLimits;
  private readonly refusedHosts = new Set<string>();
  private readonly refusedOrigins = new Set<string>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly busy = new Map<string, string>();

  constructor(private readonly options: AgentUrlClientOptions = {}) {
    this.limits = { ...DEFAULT_AGENT_URL_LIMITS, ...options.limits };
    for (const host of [...BONDED_OWN_HOSTS, ...(options.refusedHosts ?? [])])
      this.refuseHost(host);
  }

  /** Never call this host or any subdomain of it. */
  refuseHost(host: string): void {
    const clean = host.trim().toLowerCase().replace(/\.$/, "");
    if (clean) this.refusedHosts.add(clean);
  }

  /** Never call this exact origin (scheme, host and port): the gateway's own, when it's local. */
  refuseOrigin(origin: string): void {
    this.refusedOrigins.add(new URL(origin).origin);
  }

  /** Why `text` can't be an agent URL (a sentence), or undefined when it can. */
  urlProblem(text: string): string | undefined {
    if (text.length > 2_048) return "Your URL is too long";
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return "That isn't a URL";
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const bare = host.replace(/^\[|\]$/g, "");
    // Plain http only to this machine, and only when loopback is allowed (a local rating).
    const loopback =
      host === "localhost" ||
      (isIP(bare) !== 0 && publicAddress(bare, true) && !publicAddress(bare));
    if (
      url.protocol !== "https:" &&
      !(this.options.allowLoopback && url.protocol === "http:" && loopback)
    )
      return "Your URL must use https";
    if (url.username || url.password) return "Your URL can't carry a user name or password";
    if (this.refusedOrigins.has(url.origin)) return "Your URL is one of Bonded's own addresses";
    for (const refused of this.refusedHosts)
      if (host === refused || host.endsWith(`.${refused}`))
        return "Your URL is one of Bonded's own addresses";
    if (host === "localhost" && !this.options.allowLoopback)
      return "Your URL points at a private or internal address; it must be reachable on the public internet";
    if (isIP(bare) && !publicAddress(bare, this.options.allowLoopback))
      return "Your URL points at a private or internal address; it must be reachable on the public internet";
    return undefined;
  }

  /**
   * POSTs one signed message to the agent's URL. `waitMs` waits that long for the host's rate
   * limit to allow the call (episodes do; a registration check doesn't).
   */
  async send(
    url: string,
    secret: string,
    message: AgentUrlMessage,
    options: { waitMs?: number } = {},
  ): Promise<AgentUrlCall> {
    const problem = this.urlProblem(url);
    if (problem) return { ok: false, problem, caused: "agent" };
    const target = new URL(url);
    if (!(await this.slot(target.hostname.toLowerCase(), options.waitMs ?? 0)))
      return {
        ok: false,
        problem: "Bonded has called your URL too often in the last minute; try again shortly",
        caused: "bonded",
      };
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > AGENT_URL_MAX_BODY_BYTES)
      return { ok: false, problem: "the message is too large to send", caused: "bonded" };
    try {
      const { status, text } = await safeRequest(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Bonded-Gateway/1",
          ...(await signAgentUrlRequest(secret, body)),
        },
        body,
        timeoutMs: this.limits.answerMs,
        maxBytes: this.limits.maxResponseBytes,
        ...(this.options.allowLoopback ? { allowLoopback: true } : {}),
      });
      if (status < 200 || status > 299)
        return { ok: false, problem: statusProblem(status), status, caused: "agent" };
      return { ok: true, status, text };
    } catch (error) {
      return { ok: false, problem: this.failureProblem(error), caused: "agent" };
    }
  }

  /**
   * The ownership check: POSTs `{ type: "verify", challenge }` and expects 200 with the same
   * challenge back (and optionally the agent's version).
   */
  async verify(url: string, secret: string): Promise<AgentUrlVerifyResult> {
    const challenge = randomBytes(24).toString("base64url");
    const call = await this.send(url, secret, { type: "verify", challenge });
    if (!call.ok) return { ok: false, problem: call.problem };
    if (call.status !== 200)
      return {
        ok: false,
        problem: `Your URL answered ${call.status} to the check; it must be 200`,
      };
    let raw: unknown;
    try {
      raw = JSON.parse(call.text);
    } catch {
      return { ok: false, problem: "Your URL answered the check, but not with JSON" };
    }
    const answer = AgentUrlVerifyAnswer.safeParse(raw);
    if (!answer.success || answer.data.challenge !== challenge)
      return {
        ok: false,
        problem:
          "Your URL answered the check without sending the challenge back: answer verify with { challenge }",
      };
    const version = answer.data.version;
    return version ? { ok: true, version, codeHash: agentUrlCodeHash(version) } : { ok: true };
  }

  /**
   * Reserves the URL for one episode, waiting up to `waitMs` for an episode already there to
   * finish: an agent gets one episode at a time, however many ratings or checks ask. Returns the
   * release function.
   */
  async acquire(url: string, episodeId: string, waitMs: number): Promise<() => void> {
    const key = normalise(url);
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (!this.busy.has(key)) {
        this.busy.set(key, episodeId);
        return () => {
          if (this.busy.get(key) === episodeId) this.busy.delete(key);
        };
      }
      if (Date.now() >= deadline)
        throw new Error(`the agent's URL is still busy with episode ${this.busy.get(key)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Takes one call from the host's bucket, waiting up to `waitMs` for one. */
  private async slot(host: string, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (this.take(host)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private take(host: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(host) ?? { allowance: this.limits.callBurst, refilled: now };
    bucket.allowance = Math.min(
      this.limits.callBurst,
      bucket.allowance + ((now - bucket.refilled) / 60_000) * this.limits.callsPerMinute,
    );
    bucket.refilled = now;
    this.buckets.set(host, bucket);
    if (this.buckets.size > 10_000) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined && oldest !== host) this.buckets.delete(oldest);
    }
    if (bucket.allowance < 1) return false;
    bucket.allowance -= 1;
    return true;
  }

  private failureProblem(error: unknown): string {
    const seconds = Math.round(this.limits.answerMs / 100) / 10;
    if (error instanceof FetchTimeoutError)
      return `Your URL didn't answer within ${seconds} seconds`;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnsafeUrlError) {
      if (/redirect/.test(message))
        return "Your URL answered with a redirect; Bonded doesn't follow redirects, so give the final URL";
      if (/private or internal/.test(message))
        return "Your URL points at a private or internal address; it must be reachable on the public internet";
      if (/over \d+ bytes/.test(message))
        return `Your URL's answer was over ${Math.round(this.limits.maxResponseBytes / 1024)} KiB`;
      if (/https/.test(message)) return "Your URL must use https";
    }
    const code = (error as { code?: string } | undefined)?.code ?? "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Your URL's host name doesn't resolve";
    if (code === "ECONNREFUSED") return "Nothing accepted a connection at your URL";
    if (code === "ECONNRESET" || /closed before/.test(message))
      return "Your URL closed the connection before answering";
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO/.test(code))
      return `Your URL's TLS certificate was refused (${code})`;
    return `Bonded couldn't reach your URL (${message.slice(0, 200)})`;
  }
}

function statusProblem(status: number): string {
  if (status === 401 || status === 403)
    return `Your URL answered ${status}: check that your agent uses the agent secret Bonded gave you`;
  return `Your URL answered ${status}`;
}

function normalise(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * The ownership check on its own (registration, before a check or a rating): POSTs a signed
 * `{ type: "verify", challenge }` and expects the challenge back within 10 seconds. Pass the
 * gateway's client (`gateway.agentUrls`) so the per-host rate limit is shared.
 */
export function verifyAgentUrl(
  url: string,
  secret: string,
  options: AgentUrlClientOptions | { client: AgentUrlClient } = {},
): Promise<AgentUrlVerifyResult> {
  const client = "client" in options ? options.client : new AgentUrlClient(options);
  return client.verify(url, secret);
}

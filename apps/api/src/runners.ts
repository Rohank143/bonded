import { createHash, randomBytes } from "node:crypto";
import type { Database, RunnerHello } from "@bonded/db";
import { agentConfig } from "./worker.js";

/**
 * Runner tokens (bring your own agent): what `@bonded/runner` presents to the Arena Gateway to say
 * which agent it runs. The owner creates one by signing in their wallet (self-serve.ts); the API
 * shows it once and stores only its sha256. The gateway runs in the arena-worker and checks each
 * connection against the database here, and writes the runner's presence back for the API to read.
 */

/** Prefix of every runner token, so one is recognisable in a config file or a leaked log. */
export const RUNNER_TOKEN_PREFIX = "bonded_rt_";

/** A new runner token: the prefix and 32 random bytes, base64url. */
export function newRunnerToken(): string {
  return `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** What the database keeps of a token: its sha256, hex. */
export function runnerTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The agent a valid runner token belongs to. */
export interface RunnerIdentity {
  tokenId: string;
  /** The agent's row id, "<chain id>:<agent id>". The worker's RemoteAgent asks for this key. */
  agentKey: string;
  chainId: number;
  /** The on-chain agent id. */
  agentId: string;
  /** How the operator registered the agent to act: the runner must connect in this mode. */
  mode: "tools" | "chain";
  /** The agent's registered TEE URL, when it has one. */
  teeUrl?: string;
}

/** Checks the token a runner connects with. Undefined for an unknown or revoked token. */
export interface RunnerTokenValidator {
  validate(token: string): Promise<RunnerIdentity | undefined>;
}

/** Records runner connections, so the API can show them and refuse ratings with no runner. */
export interface RunnerPresence {
  /** A runner connected. Returns its connection id, or undefined when the token was just revoked. */
  connected(identity: RunnerIdentity, hello: RunnerHello): Promise<string | undefined>;
  /** A heartbeat. False means drop the connection (token revoked, or replaced by a newer one). */
  heartbeat(connectionId: string): Promise<boolean>;
  disconnected(connectionId: string): Promise<void>;
}

/**
 * Why the gateway should refuse a runner's hello for this agent, or undefined when it fits: the
 * runner must act in the mode the owner registered (and signed for).
 */
export function helloProblem(identity: RunnerIdentity, hello: RunnerHello): string | undefined {
  if (hello.mode !== identity.mode)
    return `this agent is registered to be rated in ${identity.mode} mode; start the runner with --mode ${identity.mode}`;
  return undefined;
}

/** The gateway's token check and presence writer, backed by Postgres. */
export class DbRunnerAuth implements RunnerTokenValidator, RunnerPresence {
  constructor(
    private readonly db: Database,
    /** Only tokens for agents on this chain are accepted: one worker serves one chain. */
    private readonly chainId: number,
  ) {}

  async validate(token: string): Promise<RunnerIdentity | undefined> {
    if (!token.startsWith(RUNNER_TOKEN_PREFIX) || token.length > 128) return undefined;
    const record = await this.db.runnerToken(runnerTokenHash(token));
    if (!record || record.chainId !== this.chainId) return undefined;
    const config = agentConfig.safeParse(record.config);
    if (!config.success || config.data.kind !== "remote") return undefined;
    return {
      tokenId: record.tokenId,
      agentKey: record.agentKey,
      chainId: record.chainId,
      agentId: record.agentId,
      mode: config.data.mode,
      ...(config.data.tee ? { teeUrl: config.data.tee.url } : {}),
    };
  }

  /** Refuses (undefined) a hello `helloProblem` objects to, recording nothing. */
  async connected(identity: RunnerIdentity, hello: RunnerHello) {
    if (helloProblem(identity, hello)) return undefined;
    return this.db.runnerConnected(identity.tokenId, hello);
  }

  heartbeat(connectionId: string) {
    return this.db.runnerHeartbeat(connectionId);
  }

  disconnected(connectionId: string) {
    return this.db.runnerDisconnected(connectionId);
  }
}

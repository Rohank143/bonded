import { randomBytes } from "node:crypto";
import {
  hashToken,
  type HeldOutLedger,
  type RunnerPresenceEvent,
  type RunnerTokenValidator,
} from "@bonded/arena";
import type { Database } from "@bonded/db";
import type { AgentMode } from "@bonded/shared";
import { agentConfig } from "./worker.js";

/**
 * Runner tokens (bring your own agent): what `@bonded/runner` presents to the Arena Gateway to say
 * which agent it runs. The owner creates one by signing in their wallet (self-serve.ts); the API
 * shows it once and stores only its sha256. The gateway runs in the arena-worker, checks each
 * connection and every heartbeat against the database here, and its presence events are written
 * back for the API to read.
 */

/** Prefix of every runner token, so one is recognisable in a config file or a leaked log. */
export const RUNNER_TOKEN_PREFIX = "bonded_rt_";

/** A new runner token: the prefix and 32 random bytes, base64url. */
export function newRunnerToken(): string {
  return `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** What the database keeps of a token: the gateway's own hash (sha256, hex). */
export const runnerTokenHash = hashToken;

/** The agent a valid runner token belongs to: the gateway's `RunnerIdentity`, and more. */
export interface RunnerIdentity {
  /** The agent's row id, "<chain id>:<agent id>": the key the worker's RemoteAgent asks for. */
  key: string;
  tokenId: string;
  chainId: number;
  /** The on-chain agent id. */
  agentId: string;
  /** How the owner registered (and signed) the agent to act: its runner must use this mode. */
  mode: AgentMode;
  /** The agent's registered TEE URL, when it has one. */
  teeUrl?: string;
}

/**
 * Why a runner's hello doesn't fit the agent, or undefined when it does: it must act in the mode
 * the owner registered. A runner in another mode is recorded but never counts as connected.
 */
export function helloProblem(
  identity: Pick<RunnerIdentity, "mode">,
  hello: { mode: string },
): string | undefined {
  if (hello.mode !== identity.mode)
    return `this agent is registered to be rated in ${identity.mode} mode; start the runner with --mode ${identity.mode}`;
  return undefined;
}

/** The agent's current owner in the registry, lowercase. */
export type OwnerOf = (agentId: string) => Promise<string>;

/**
 * The gateway's runner token check, against the database: a live token of an enabled agent on
 * this worker's chain, registered as the owner's own agent, and made by the agent's current
 * registry owner (a token doesn't survive a transfer of the agent). The gateway asks again at
 * every heartbeat, so revoking a token, or the agent changing hands, drops its runner within one.
 */
export class DbRunnerAuth implements RunnerTokenValidator {
  private readonly owners = new Map<string, { owner: string; at: number }>();

  constructor(
    private readonly db: Database,
    /** Only tokens for agents on this chain are accepted: one worker serves one chain. */
    private readonly chainId: number,
    /** Reads the registry; without it the owner isn't checked (tests of the database only). */
    private readonly ownerOf?: OwnerOf,
    /** How long an owner read is reused (default a minute: heartbeats come every 15 s). */
    private readonly ownerCacheMs = 60_000,
  ) {}

  async validate(token: string): Promise<RunnerIdentity | null> {
    if (!token.startsWith(RUNNER_TOKEN_PREFIX) || token.length > 128) return null;
    const record = await this.db.runnerToken(runnerTokenHash(token));
    if (!record || record.chainId !== this.chainId) return null;
    const config = agentConfig.safeParse(record.config);
    if (!config.success || config.data.kind !== "remote") return null;
    if (this.ownerOf && (await this.owner(record.agentId)) !== record.createdBy.toLowerCase())
      return null;
    return {
      key: record.agentKey,
      tokenId: record.tokenId,
      chainId: record.chainId,
      agentId: record.agentId,
      mode: config.data.mode,
      ...(config.data.tee ? { teeUrl: config.data.tee.url } : {}),
    };
  }

  private async owner(agentId: string): Promise<string> {
    const cached = this.owners.get(agentId);
    if (cached && Date.now() - cached.at < this.ownerCacheMs) return cached.owner;
    const owner = (await this.ownerOf!(agentId)).toLowerCase();
    this.owners.set(agentId, { owner, at: Date.now() });
    return owner;
  }
}

/**
 * Writes the gateway's runner presence events to the database (`onRunnerPresence`). Events come
 * synchronously; for each agent, one write runs at a time, in order. Heartbeats coalesce: while a
 * write is running, a newer heartbeat replaces a waiting one, so a slow database can't build an
 * unbounded queue. A failed write is logged, never thrown into the gateway.
 */
export class RunnerPresenceWriter {
  private readonly connections = new Map<string, string>();
  private readonly waiting = new Map<string, RunnerPresenceEvent[]>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** The gateway's `onRunnerPresence`. */
  readonly onEvent = (event: RunnerPresenceEvent): void => {
    const queue = this.waiting.get(event.key) ?? [];
    // A heartbeat only says "still here": the newest one is enough.
    if (event.type === "heartbeat" && queue.at(-1)?.type === "heartbeat") queue.pop();
    queue.push(event);
    // Connections come and go at most a few times a second; keep the latest few.
    if (queue.length > 8) queue.splice(0, queue.length - 8);
    this.waiting.set(event.key, queue);
    if (!this.running.has(event.key)) this.drain(event.key);
  };

  /** Resolves once every event received so far is written. */
  async flush(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  private drain(key: string) {
    const work = (async () => {
      for (;;) {
        const event = this.waiting.get(key)?.shift();
        if (!event) break;
        await this.write(event).catch(() =>
          this.log(`runner presence for ${key} could not be recorded`),
        );
      }
      this.waiting.delete(key);
      this.running.delete(key);
    })();
    this.running.set(key, work);
  }

  /** Events waiting to be written for an agent (for tests). */
  pending(key: string): number {
    return this.waiting.get(key)?.length ?? 0;
  }

  private async write(event: RunnerPresenceEvent) {
    if (event.type === "connected") {
      if (!event.hello) return;
      const id = await this.db.runnerConnected(event.key, {
        runnerVersion: event.hello.runnerVersion,
        mode: event.hello.mode,
        teeUrl: event.hello.teeUrl,
      });
      if (id) this.connections.set(event.key, id);
      else this.connections.delete(event.key);
      return;
    }
    const id = this.connections.get(event.key);
    if (!id) return;
    if (event.type === "heartbeat") await this.db.runnerHeartbeat(id);
    else {
      this.connections.delete(event.key);
      await this.db.runnerDisconnected(id);
    }
  }
}

/** Held-out payloads already used, kept in the database so no remote rating reuses one. */
export class DbHeldOutLedger implements HeldOutLedger {
  constructor(private readonly db: Database) {}
  used(hashes: readonly string[]) {
    return this.db.heldOutPayloadsUsed(hashes);
  }
  record(hashes: readonly string[]) {
    return this.db.recordHeldOutPayloads(hashes);
  }
}

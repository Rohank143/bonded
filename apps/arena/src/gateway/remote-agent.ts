import { randomBytes, randomUUID } from "node:crypto";
import {
  type AgentMode,
  type AgentRunSummary,
  type AgentTask,
  type AgentToolbox,
  type AttackSurface,
  type DoneRequest,
  type EpisodeDoneMessage,
  type EpisodeMessage,
  RUNNER_KILL_GRACE_MS,
  type RunnerToServer,
} from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { SelfSigningAgent } from "../episode.js";
import type { Sandbox } from "../sandbox.js";
import { ArenaToolbox } from "../toolbox.js";
import { marketTokens } from "../vault.js";
import { liveClientVersion } from "./rpc.js";
import type { ArenaGateway, GatewayEpisode } from "./server.js";

/**
 * An agent that runs on its operator's own servers, rated through the Arena Gateway. To the
 * episode runner, judge and rating it is just another `ArenaAgent`: `run` serves the episode's
 * toolbox behind a fresh capability token, hands the episode to the agent's connected runner, and
 * waits for the agent to finish, exit or run out of time.
 *
 * - Tool mode: writes are tool calls the toolbox sends through the vault with the sandbox's key.
 * - Chain mode: the episode's vault names a fresh session key as its agent (or, for a TEE-bound
 *   agent, the TEE's attested address, and no key is sent); the agent signs its own execute()
 *   transactions and sends them through the gateway's RPC endpoint.
 *
 * Steps are the tool calls and transactions the gateway saw (the toolbox trace), never what the
 * agent claims.
 */
export interface RemoteAgentOptions {
  gateway: ArenaGateway;
  /** The sandbox the rating runs in (chain mode forwards RPC to it and funds the agent's key). */
  sandbox: Sandbox;
  /** The key of the runner to use: what its runner token maps to (RunnerIdentity.key). */
  runner: string;
  mode: AgentMode;
  /** How the agent is named in reports (default "remote/<runner>"). */
  name?: string;
  /**
   * Wall-clock budget per episode (default 4 minutes, inside the episode runner's 5-minute stop).
   * The agent is told it, and cancelled when it runs out.
   */
  episodeTimeoutMs?: number;
  /** How long to wait for the runner to be connected and idle before failing an episode. */
  runnerWaitMs?: number;
  /**
   * A TEE-bound agent: every episode carries a fresh nonce, the runner answers with the TEE's
   * evidence, and nothing is served until `onEvidence` accepts it (throw to refuse: the episode
   * then fails). Verification belongs to the caller (the rating service uses tee.ts).
   */
  tee?: {
    onEvidence(evidence: unknown, context: { episodeId: string; nonce: `0x${string}` }): unknown;
    /**
     * Chain mode: the rating's Arena key id. Each episode asks the TEE to attest the key it derives
     * for this id (verify with `arenaKeyId`), and `agentAddress` should be that key, so nothing
     * the agent signs in the Arena (whose fork keeps the live chain's id) is valid for its
     * production key. Get its address before the rating with attestTeeAgent({ arenaKeyId }).
     */
    keyId?: `0x${string}`;
    /** How long to wait for the evidence (default 30 s). */
    timeoutMs?: number;
  };
  /**
   * Chain mode, TEE-bound: the attested EVM address the episode's vault names as its agent: the
   * rating's Arena key (`tee.keyId`), never the production key. No key is sent; the TEE signs.
   * Without it, each episode gets a fresh session key.
   */
  agentAddress?: `0x${string}`;
}

/** What a remote episode adds to the agent's summary (kept in the episode's trace record). */
export interface RemoteEpisode {
  episodeId: string;
  exitCode: number | null;
  signal?: string | null;
  durationMs: number;
  stdoutTail?: string;
  stderrTail?: string;
  /** Why the runner couldn't run it, if it said. */
  runnerError?: string;
  /** Successful reads per attack surface, as the gateway logged them. */
  reads: Partial<Record<AttackSurface, number>>;
  /** Model usage the agent reported at /done: recorded, never used for spending limits. */
  reportedUsage?: DoneRequest["usage"];
  /** The TEE evidence the runner forwarded for this episode, as received. */
  teeEvidence?: unknown;
  /**
   * On a budgeted fork: the agent spent its share of reads from the live chain during this
   * episode, and further reads were refused. Anything that fails for lack of fork budget during
   * or after such an episode was caused by the agent, not the rating.
   */
  budgetExhausted?: boolean;
  /** Live-chain requests the agent's episode caused (budgeted forks only). */
  forkFetches?: number;
  nonce?: `0x${string}`;
}

export type RemoteRunSummary = AgentRunSummary & { remote: RemoteEpisode };

const DEFAULT_TIMEOUT_MS = 4 * 60_000;
/** How long an agent that posted /done has to exit before it is stopped. */
const DONE_EXIT_GRACE_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteAgent implements SelfSigningAgent {
  readonly name: string;
  /** Every episode this agent ran, in order. */
  readonly episodes: RemoteEpisode[] = [];
  private pendingKey: { key: `0x${string}`; address: `0x${string}` } | undefined;
  private running = false;

  constructor(private readonly options: RemoteAgentOptions) {
    this.name = options.name ?? `remote/${options.runner}`;
  }

  get mode(): AgentMode {
    return this.options.mode;
  }

  /** Chain mode: the key this episode's vault accepts, funded with test gas. */
  async episodeSigner(sandbox: Sandbox): Promise<`0x${string}` | undefined> {
    if (this.options.mode !== "chain") return undefined;
    if (this.options.agentAddress) {
      this.pendingKey = undefined;
      await sandbox.fund(this.options.agentAddress);
      return this.options.agentAddress;
    }
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    this.pendingKey = { key, address };
    await sandbox.fund(address);
    return address;
  }

  async run(task: AgentTask, tools: AgentToolbox): Promise<RemoteRunSummary> {
    if (!(tools instanceof ArenaToolbox))
      throw new Error("a remote agent runs only against the Arena's own toolbox");
    if (this.running) throw new Error("a remote agent runs one episode at a time");
    this.running = true;
    try {
      return await this.runEpisode(task, tools);
    } finally {
      this.running = false;
      this.pendingKey = undefined;
    }
  }

  private async runEpisode(task: AgentTask, toolbox: ArenaToolbox): Promise<RemoteRunSummary> {
    const { gateway, sandbox, mode } = this.options;
    const timeoutMs = this.options.episodeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const episodeId = randomUUID();
    const started = Date.now();
    const record: RemoteEpisode = { episodeId, exitCode: null, durationMs: 0, reads: {} };
    this.episodes.push(record);

    const signer =
      mode === "chain" ? (this.options.agentAddress ?? this.pendingKey?.address) : undefined;
    if (mode === "chain" && !signer)
      throw new Error("chain mode needs the episode's vault to name the agent's key");

    const runner = await gateway.acquireRunner(
      this.options.runner,
      episodeId,
      this.options.runnerWaitMs ?? 60_000,
    );
    let episode: GatewayEpisode | undefined;
    let sent = false;
    // On a budgeted fork, what the agent's reads cost the live chain is charged to it alone.
    const forkScope = sandbox.forkScope();
    const cleanups: (() => void)[] = [];
    // The runner's exit report for this episode (undefined if the runner goes away first). It
    // stays subscribed past the episode's end, so a report arriving late is still caught.
    let exited: EpisodeDoneMessage | undefined;
    const exit = new Promise<EpisodeDoneMessage | undefined>((resolve) => {
      const finish = (message: EpisodeDoneMessage | undefined) => {
        offMessage();
        offClose();
        clearTimeout(safety);
        exited = message;
        resolve(message);
      };
      const offMessage = runner.onMessage((message) => {
        if (message.type === "episode_done" && message.episodeId === episodeId) finish(message);
      });
      const offClose = runner.onClose(() => finish(undefined));
      const safety = setTimeout(() => finish(undefined), timeoutMs + 120_000);
    });
    try {
      if (runner.hello?.mode !== mode)
        throw new Error(`the runner is in ${runner.hello?.mode} mode, but this rating is ${mode}`);
      const nonce = this.options.tee
        ? (`0x${randomBytes(32).toString("hex")}` as const)
        : undefined;
      if (nonce) record.nonce = nonce;
      const clientVersion =
        mode === "chain"
          ? ((sandbox.forkUrl ? await liveClientVersion(sandbox.forkUrl) : undefined) ??
            gateway.clientVersion)
          : undefined;
      const opened = gateway.openEpisode({
        episodeId,
        toolbox,
        mode,
        gated: Boolean(nonce),
        ...(mode === "chain"
          ? {
              chain: {
                upstream: sandbox.rpcUrl,
                chainId: sandbox.chain.id,
                vault: toolbox.vault,
                agent: signer!,
                ...(forkScope ? { forkScope } : {}),
                ...(clientVersion ? { clientVersion } : {}),
              },
            }
          : {}),
      });
      episode = opened;

      // Everything that can end the episode, as one race.
      const ended = new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("deadline"), timeoutMs);
        cleanups.push(() => clearTimeout(timer));
        const onAbort = () => resolve("aborted");
        toolbox.signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => toolbox.signal.removeEventListener("abort", onAbort));
        void opened.done.then(() => resolve("done"));
        void exit.then((message) => resolve(message ? "exited" : "disconnected"));
        const refuse = (reason: string) => {
          record.runnerError = reason;
          resolve("tee_refused");
        };
        cleanups.push(
          runner.onMessage((message) => {
            if (message.type !== "tee_evidence" || message.episodeId !== episodeId) return;
            void this.acceptEvidence(message, record, opened).catch((error: unknown) =>
              refuse(
                `TEE evidence refused: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }),
        );
        if (nonce) {
          const teeTimer = setTimeout(() => {
            if (record.teeEvidence === undefined) refuse("no TEE evidence arrived");
          }, this.options.tee?.timeoutMs ?? 30_000);
          cleanups.push(() => clearTimeout(teeTimer));
        }
      });

      const message: EpisodeMessage = {
        type: "episode",
        episodeId,
        task,
        mode,
        endpoints: opened.endpoints,
        chainId: sandbox.chain.id,
        vault: toolbox.vault,
        contracts: {
          exchange: sandbox.deployment.router,
          tokens: marketTokens(sandbox).map(({ symbol, address, decimals }) => ({
            symbol,
            address,
            decimals,
          })),
        },
        ...(mode === "chain" && !this.options.agentAddress && this.pendingKey
          ? { sessionKey: this.pendingKey.key }
          : {}),
        deadlineMs: timeoutMs,
        ...(nonce ? { nonce } : {}),
        ...(nonce && this.options.tee?.keyId ? { teeKeyId: this.options.tee.keyId } : {}),
      };
      if (!runner.send(message)) throw new Error("the runner disconnected");
      sent = true;
      const why = await ended;
      opened.close();

      // An agent that said it's done gets a moment to exit on its own.
      if (why === "done" && !exited && !runner.closed)
        await Promise.race([exit, sleep(DONE_EXIT_GRACE_MS)]);
      // The process may still be running (it said done, or ran out of time): stop it, and wait
      // for its exit report so the tails and exit code are recorded.
      if (!exited && !runner.closed) {
        runner.send({ type: "cancel", episodeId });
        await Promise.race([exit, sleep(RUNNER_KILL_GRACE_MS + 3_000)]);
      }
      if (exited) {
        record.exitCode = exited.exitCode;
        if (exited.signal !== undefined) record.signal = exited.signal;
        if (exited.stdoutTail) record.stdoutTail = exited.stdoutTail;
        if (exited.stderrTail) record.stderrTail = exited.stderrTail;
        if (exited.error) record.runnerError ??= exited.error;
      }
      record.durationMs = Date.now() - started;
      for (const read of opened.reads)
        if (read.surface && read.ok)
          record.reads[read.surface] = (record.reads[read.surface] ?? 0) + 1;
      if (opened.finished?.usage) record.reportedUsage = opened.finished.usage;

      return { ...this.summarise(why, record, opened, toolbox, timeoutMs), remote: record };
    } finally {
      for (const cleanup of cleanups) cleanup();
      episode?.close();
      if (forkScope) {
        forkScope.close();
        record.forkFetches = forkScope.used;
        if (forkScope.exhausted) record.budgetExhausted = true;
      }
      // Free the runner only once its process is gone, so the next episode can't overlap it.
      if (!sent || exited || runner.closed) gateway.releaseRunner(runner, episodeId);
      else void exit.then(() => gateway.releaseRunner(runner, episodeId));
    }
  }

  private async acceptEvidence(
    message: Extract<RunnerToServer, { type: "tee_evidence" }>,
    record: RemoteEpisode,
    episode: GatewayEpisode,
  ): Promise<void> {
    if (!record.nonce || !this.options.tee)
      throw new Error("this episode asked for no TEE evidence");
    if (record.teeEvidence !== undefined) throw new Error("evidence was already sent");
    if (message.error || message.evidence === undefined)
      throw new Error(message.error ?? "the runner sent no evidence");
    record.teeEvidence = message.evidence;
    await this.options.tee.onEvidence(message.evidence, {
      episodeId: record.episodeId,
      nonce: record.nonce,
    });
    episode.open();
  }

  private summarise(
    why: string,
    record: RemoteEpisode,
    episode: GatewayEpisode,
    toolbox: ArenaToolbox,
    timeoutMs: number,
  ): AgentRunSummary {
    const steps = toolbox.trace.length;
    const said = episode.finished?.finalMessage;
    const withMessage = (stoppedBecause: AgentRunSummary["stoppedBecause"], fallback: string) => ({
      steps,
      stoppedBecause,
      finalMessage: said ?? fallback,
    });
    switch (why) {
      case "done":
        return withMessage("done", "the agent said it was done");
      case "exited":
        return record.exitCode === 0
          ? withMessage("done", "the agent exited")
          : withMessage(
              "error",
              record.runnerError ??
                `the agent exited with ${record.exitCode === null ? `signal ${record.signal ?? "unknown"}` : `code ${record.exitCode}`}`,
            );
      case "deadline":
        return withMessage("error", `timed out after ${timeoutMs} ms`);
      case "disconnected":
        return withMessage("error", "the agent's runner disconnected during the episode");
      case "tee_refused":
        return withMessage("error", record.runnerError ?? "TEE evidence refused");
      default:
        return withMessage("error", "the episode was stopped");
    }
  }
}

import {
  type AgentRunSummary,
  type AgentTask,
  type ArenaAgent,
  type AttackSpec,
  type EvmMandate,
  mandateVaultAbi,
} from "@bonded/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { lookalikeOf } from "./attacks.js";
import { DEFAULT_GOAL, mandatePolicy, plantAttack, runWithTimeout } from "./episode.js";
import type { ChainHandle } from "./sandbox.js";
import { ArenaToolbox, type TraceStep } from "./toolbox.js";
import { describeMandate, marketTokens } from "./vault.js";
import { type PlantedContent, World } from "./world.js";

export interface LiveAttackOptions {
  /** The chain the vault lives on; `wallet("agent")` must hold the vault's execution key. */
  chain: ChainHandle;
  vault: `0x${string}`;
  /** The vault's mandate, as configured for the agent (what the agent is told). */
  mandate: EvmMandate;
  agent: ArenaAgent;
  attack: AttackSpec;
  goal?: string;
  /** Overrides for the attack's placeholders (amount, token, ...). */
  vars?: Record<string, string>;
  maxSteps?: number;
  timeoutMs?: number;
}

export interface LiveAttackResult {
  planted: PlantedContent[];
  trace: TraceStep[];
  agentSummary: AgentRunSummary;
  /** Breach ids the vault recorded during the run. */
  breachIds: number[];
  frozen: boolean;
}

/**
 * Plants one attack in the agent's world and lets the agent act on a **real** vault: the same
 * world, tools and planting as an Arena episode, but on the chain given (the demo's break-it run
 * on testnet). The vault's own breach log, read before and after, is the verdict.
 *
 * Unlike an episode, nothing here is a sandbox: the agent's writes are real transactions.
 */
export async function runLiveAttack(options: LiveAttackOptions): Promise<LiveAttackResult> {
  const { chain, vault, mandate } = options;
  const read = chain.publicClient;
  const tokens = marketTokens(chain);
  const breachCount = () =>
    read.readContract({ address: vault, abi: mandateVaultAbi, functionName: "breachCount" });
  const before = await breachCount();

  // The depositor the agent may refund (what address poisoning imitates), as in an episode.
  const depositor = mandate.destinations[0] as `0x${string}` | undefined;
  if (!depositor) throw new Error("the mandate has no destination for the attack to imitate");
  const world = new World(tokens, depositor);
  const planted = plantAttack(world, options.attack, {
    attacker: privateKeyToAccount(generatePrivateKey()).address,
    vault,
    amount: "5000",
    token: "tUSDG",
    depositor,
    lookalike: lookalikeOf(depositor),
    ...options.vars,
  });

  const task: AgentTask = {
    goal: options.goal ?? DEFAULT_GOAL,
    mandate: describeMandate(mandate, tokens),
    policy: mandatePolicy(mandate, tokens),
    maxSteps: options.maxSteps ?? 20,
  };
  const toolbox = new ArenaToolbox(chain, world, vault, task.maxSteps);
  const agentSummary = await runWithTimeout(options.agent, task, toolbox, options.timeoutMs);

  const after = await breachCount();
  const frozen = await read.readContract({
    address: vault,
    abi: mandateVaultAbi,
    functionName: "frozen",
  });
  return {
    planted,
    trace: toolbox.trace,
    agentSummary,
    breachIds: Array.from({ length: Number(after - before) }, (_, i) => Number(before) + i),
    frozen,
  };
}

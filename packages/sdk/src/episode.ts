import { type AgentTask, EpisodeEnv, parseEpisodeEnv } from "@bonded/shared";
import type { Address, Hex } from "viem";
import { BondedError } from "./errors.js";
import type { TokenInfo } from "./guarded.js";

/**
 * An Arena episode, as the Bonded runner hands it to an agent it launches: the task, where the
 * episode's tools are, and in chain mode a fork RPC and the key to sign with. The agent acts
 * exactly as in production, against these endpoints, and the Arena judges it by the episode
 * vault's breach log.
 */
export interface BondedEpisode {
  episodeId: string;
  task: AgentTask;
  /** tools: writes are the `swap`/`transfer`/`approve` tools. chain: writes are signed `execute` txs to `endpoints.rpc`. */
  mode: "tools" | "chain";
  endpoints: {
    /** MCP over streamable HTTP. */
    mcp: string;
    /** Plain HTTP: `GET {tools}` lists them, `POST {tools}/{name}` with JSON args calls one. */
    tools: string;
    openapi: string;
    /** `POST` here when finished (`{ finalMessage? }`). */
    done: string;
    /** Chain mode: the episode's fork. Only signed `execute` calls to the episode vault are accepted. */
    rpc?: string;
  };
  vault: Address;
  chainId: number;
  /** The episode's market: the exchange (swap router) and the tokens the agent can trade. */
  contracts: { exchange: Address; tokens: TokenInfo[] };
  /** Chain mode: the episode's agent key. Absent when the agent's key lives in a TEE. */
  sessionKey?: Hex;
  /** How long the agent has, in milliseconds from when it starts. */
  deadlineMs: number;
}

/**
 * The BONDED_* variables the runner sets for each episode. The schema lives in @bonded/shared,
 * next to `episodeEnv` that writes them, so the runner, the gateway and the SDK can't drift.
 */
export const bondedEpisodeEnv = EpisodeEnv;

/**
 * Reads the episode the Bonded runner set up from the environment. Throws `BondedError`
 * (`EPISODE_ENV`) naming every missing or malformed variable.
 *
 * ```ts
 * const episode = fromBondedEnv();
 * if (episode.mode === "chain") {
 *   const vault = new BondedVault({ vault: episode.vault, rpcUrl: episode.endpoints.rpc, ... });
 * }
 * ```
 */
export function fromBondedEnv(
  env: Record<string, string | undefined> = process.env,
): BondedEpisode {
  const parsed = parseEpisodeEnv(env);
  if (!parsed.ok)
    throw new BondedError(
      "EPISODE_ENV",
      `not a valid Bonded episode environment: ${parsed.problems.join("; ")}`,
    );
  const { contracts, ...episode } = parsed.episode;
  return { ...episode, contracts: { exchange: contracts.exchange, tokens: contracts.tokens } };
}

import type { AgentTask } from "@bonded/shared";
import { type Address, getAddress, type Hex, isAddress } from "viem";
import { z } from "zod";
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

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));
const url = z.url();
const json = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "must be JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);

const taskSchema = z.object({
  goal: z.string(),
  mandate: z.string(),
  policy: z
    .object({
      tokens: z.array(z.string()),
      maxTradeUsd: z.number(),
      maxDailyUsd: z.number(),
      transferAllowlist: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
      approvalAllowlist: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    })
    .optional(),
  maxSteps: z.number().int().positive(),
});

/** The BONDED_* variables the runner sets for each episode. */
export const bondedEpisodeEnv = z
  .object({
    BONDED_EPISODE_ID: z.string().min(1),
    BONDED_TASK: json(taskSchema),
    BONDED_MODE: z.enum(["tools", "chain"]),
    BONDED_MCP_URL: url,
    BONDED_TOOLS_URL: url,
    BONDED_OPENAPI_URL: url,
    BONDED_DONE_URL: url,
    BONDED_RPC_URL: url.optional(),
    BONDED_SESSION_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
      .optional(),
    BONDED_VAULT: address,
    BONDED_CHAIN_ID: z.coerce.number().int().positive(),
    BONDED_DEADLINE_MS: z.coerce.number().int().positive(),
    BONDED_CONTRACTS: json(
      z.object({
        exchange: address,
        tokens: z
          .array(
            z.object({
              symbol: z.string().min(1),
              address,
              decimals: z.number().int().min(0).max(36),
            }),
          )
          .min(1),
      }),
    ),
  })
  .refine((env) => env.BONDED_MODE !== "chain" || env.BONDED_RPC_URL, {
    message: "chain mode needs BONDED_RPC_URL",
    path: ["BONDED_RPC_URL"],
  });

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
  const parsed = bondedEpisodeEnv.safeParse(env);
  if (!parsed.success)
    throw new BondedError(
      "EPISODE_ENV",
      `not a valid Bonded episode environment: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "environment"} ${i.message}`)
        .join("; ")}`,
    );
  const e = parsed.data;
  return {
    episodeId: e.BONDED_EPISODE_ID,
    task: e.BONDED_TASK as AgentTask,
    mode: e.BONDED_MODE,
    endpoints: {
      mcp: e.BONDED_MCP_URL,
      tools: e.BONDED_TOOLS_URL,
      openapi: e.BONDED_OPENAPI_URL,
      done: e.BONDED_DONE_URL,
      ...(e.BONDED_RPC_URL ? { rpc: e.BONDED_RPC_URL } : {}),
    },
    vault: e.BONDED_VAULT,
    chainId: e.BONDED_CHAIN_ID,
    contracts: e.BONDED_CONTRACTS,
    ...(e.BONDED_SESSION_KEY ? { sessionKey: e.BONDED_SESSION_KEY as Hex } : {}),
    deadlineMs: e.BONDED_DEADLINE_MS,
  };
}

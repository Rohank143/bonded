/**
 * The parts of ElizaOS's plugin interface this plugin uses, written out so the SDK doesn't
 * import @elizaos/core: its type declarations only resolve with `moduleResolution: "bundler"`.
 * test/eliza-types.ts checks against the real types that a plugin built here is an ElizaOS
 * `Plugin` (run by `pnpm typecheck`).
 */
export interface ElizaMemory {
  content: { text?: string };
}
export interface ElizaState {
  text?: string;
}
export interface ElizaRuntime {
  useModel(modelType: "OBJECT_SMALL", params: { prompt: string }): Promise<unknown>;
}
type ElizaCallback = (response: { text?: string; actions?: string[] }) => Promise<unknown>;
export interface ElizaActionResult {
  success: boolean;
  text?: string;
  data?: Record<string, unknown>;
  error?: string | Error;
}
export interface ElizaAction {
  [key: string]: unknown;
  name: string;
  similes?: string[];
  description: string;
  validate: (runtime: ElizaRuntime, message: ElizaMemory, state?: ElizaState) => Promise<boolean>;
  handler: (
    runtime: ElizaRuntime,
    message: ElizaMemory,
    state?: ElizaState,
    options?: { [key: string]: unknown },
    callback?: ElizaCallback,
  ) => Promise<ElizaActionResult>;
}
export interface ElizaProvider {
  name: string;
  description?: string;
  get: (
    runtime: ElizaRuntime,
    message: ElizaMemory,
    state: ElizaState,
  ) => Promise<{ text?: string; values?: Record<string, unknown>; data?: Record<string, unknown> }>;
}
export interface ElizaPlugin {
  name: string;
  description: string;
  actions: ElizaAction[];
  providers: ElizaProvider[];
  /** Runs when the runtime registers the plugin, before it reads `actions` and `providers`. */
  init?: (config: Record<string, string>, runtime: unknown) => Promise<void>;
}

import { type Address, erc20Abi, getAddress, isAddress, parseUnits } from "viem";
import { z } from "zod";
import type { VaultAction } from "./actions.js";
import { BondedError } from "./errors.js";
import {
  type GuardContext,
  GuardedVault,
  type SentinelGuardOptions,
  type TokenInfo,
} from "./guarded.js";
import { SENTINEL_INPUT_CHARS } from "@bondedhq/shared";
import { type BondedEpisode, episodeVault, fromBondedEnv } from "./episode.js";
import {
  type EpisodeTool,
  type EpisodeTools,
  isBondedEpisode,
  resolveTools,
  resultText,
} from "./mcp.js";
import type { ActionResult, BondedVault } from "./vault.js";

export interface BondedElizaOptions {
  /** The vault, with the agent key to send from (and a `router` for swaps). */
  vault: BondedVault;
  /** Tokens the agent may name by symbol. Others must be given by address. */
  tokens?: readonly TokenInfo[];
  /**
   * Dry-run each action first and refuse a predicted breach. On by default: an LLM-driven
   * agent should not knowingly breach. The vault judges either way.
   */
  guard?: boolean;
  /** Ask Sentinel before each action, with the conversation as the untrusted input. */
  sentinel?: SentinelGuardOptions;
  /**
   * Rating mode. With `"auto"` (the default), when the process is running a Bonded episode
   * (`isBondedEpisode()`: the runner set `BONDED_*` variables), the plugin swaps its actions for
   * the episode's, when the runtime registers it: see `bondedEpisodePlugin`. `"off"` keeps the
   * vault actions always.
   */
  rating?: "auto" | "off";
}

/** The action names this plugin adds. */
export const BONDED_ACTIONS = ["BONDED_SWAP", "BONDED_TRANSFER", "BONDED_APPROVE"] as const;
type BondedActionName = (typeof BONDED_ACTIONS)[number];

const amount = z.string().regex(/^\d+(\.\d+)?$/, "a decimal amount, e.g. 250 or 12.5");
const PARAMS = {
  BONDED_SWAP: z.object({ tokenIn: z.string(), tokenOut: z.string(), amount }),
  BONDED_TRANSFER: z.object({ token: z.string(), to: z.string(), amount }),
  BONDED_APPROVE: z.object({ token: z.string(), spender: z.string(), amount }),
} satisfies Record<BondedActionName, z.ZodType>;

const DESCRIPTIONS: Record<BondedActionName, string> = {
  BONDED_SWAP: "Swap one token for another with the funds in the agent's Bonded Mandate Vault.",
  BONDED_TRANSFER: "Send tokens from the agent's Bonded Mandate Vault to an address.",
  BONDED_APPROVE: "Let an address spend tokens from the agent's Bonded Mandate Vault.",
};

const FIELDS: Record<BondedActionName, string> = {
  BONDED_SWAP: '{"tokenIn": symbol or address, "tokenOut": symbol or address, "amount": "decimal"}',
  BONDED_TRANSFER: '{"token": symbol or address, "to": "0x address", "amount": "decimal"}',
  BONDED_APPROVE: '{"token": symbol or address, "spender": "0x address", "amount": "decimal"}',
};

/**
 * An ElizaOS plugin: `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` act through the
 * agent's Mandate Vault, and the `BONDED_VAULT` provider tells the agent the vault's state.
 *
 * Each action takes its parameters from `options.parameters` when the caller passes them, or
 * asks the runtime's `OBJECT_SMALL` model to read them from the conversation. Amounts are whole
 * tokens ("12.5"). By default each action is dry-run against the vault first and refused if the
 * vault would record a breach; with `sentinel`, Sentinel is asked too, with the conversation as
 * what the agent read.
 */
export function bondedPlugin(options: BondedElizaOptions): ElizaPlugin {
  const guard = options.guard ?? true;
  const guarded = new GuardedVault(
    options.vault,
    options.sentinel ? { sentinel: options.sentinel } : {},
  );

  const action = (name: BondedActionName): ElizaAction => ({
    name,
    similes: [],
    description: DESCRIPTIONS[name],
    validate: async () => options.vault.walletClient !== undefined,
    handler: async (runtime, message, state, handlerOptions, callback) => {
      try {
        const params = await readParams(name, runtime, message, state, handlerOptions);
        const vaultAction = await toVaultAction(name, params, options);
        const context: GuardContext = { untrustedInputs: conversation(message, state) };
        const result: ActionResult =
          guard || options.sentinel
            ? await guarded.execute(vaultAction, context)
            : await options.vault.execute(vaultAction);
        const text = result.breaches.length
          ? `Done, but the vault recorded a breach: ${result.breaches.map((b) => `${b.type} (${b.reason})`).join("; ")}. The vault may have frozen the agent.`
          : `Done within the mandate (${result.hashes.length} transaction${result.hashes.length === 1 ? "" : "s"}).`;
        await callback?.({ text, actions: [name] });
        return {
          success: true,
          text,
          data: {
            hashes: result.hashes,
            breaches: result.breaches.map((b) => ({
              ...b,
              id: b.id.toString(),
              lossUsd6: b.lossUsd6.toString(),
            })),
          },
        };
      } catch (error) {
        const text = `Not done: ${error instanceof Error ? error.message : String(error)}`;
        await callback?.({ text, actions: [name] });
        return { success: false, text, error: error instanceof Error ? error : String(error) };
      }
    },
  });

  const provider: ElizaProvider = {
    name: "BONDED_VAULT",
    description: "The agent's Bonded Mandate Vault: mode, frozen or not, and breaches recorded.",
    get: async () => {
      const status = await options.vault.status();
      const text =
        (status.kind === "module"
          ? `Funds are in smart account ${status.holder}, guarded by Bonded mandate module ${options.vault.address} (${status.mode} mode). `
          : `Funds are in Bonded Mandate Vault ${options.vault.address} (${status.mode} mode). `) +
        (status.frozen
          ? "It is frozen: no action will run until its guardian unfreezes it. "
          : "It is active. ") +
        `${status.breachCount} breach${status.breachCount === 1n ? "" : "es"} recorded.`;
      return {
        text,
        values: { bondedVaultFrozen: status.frozen, bondedVaultMode: status.mode },
        data: {
          vault: options.vault.address,
          kind: status.kind,
          holder: status.holder,
          frozen: status.frozen,
          mode: status.mode,
          breachCount: status.breachCount.toString(),
        },
      };
    },
  };

  const plugin: ElizaPlugin = {
    name: "bonded",
    description: "Trade through a Bonded Mandate Vault, checked against the agent's mandate.",
    actions: BONDED_ACTIONS.map(action),
    providers: [provider],
  };
  if ((options.rating ?? "auto") === "auto")
    plugin.init = async (config, runtime) => {
      if (!isBondedEpisode()) return;
      const rated = bondedEpisodePlugin({ guard });
      await rated.init!(config, runtime);
      plugin.actions = rated.actions;
      plugin.providers = rated.providers;
    };
  return plugin;
}

export interface BondedEpisodeElizaOptions {
  /** The episode. Default: the one the runner set up (`fromBondedEnv`). */
  episode?: BondedEpisode;
  /** An existing connection to the episode's tools (otherwise one is made at `init`). */
  tools?: EpisodeTools;
  /** Chain mode: dry-run each vault action first (default true), as `bondedPlugin` does. */
  guard?: boolean;
}

/**
 * Rating mode for ElizaOS: a plugin whose actions are the episode's tools, so an Eliza agent is
 * rated with the same character and model it runs in production. Each tool becomes an action
 * named after it in capitals (`get_prices` is `GET_PRICES`); its parameters come from
 * `options.parameters`, or the runtime's `OBJECT_SMALL` model reads them from the conversation
 * against the tool's JSON Schema. The `BONDED_TASK` provider gives the agent the episode's task.
 *
 * In tools mode the writes (`SWAP`, `TRANSFER`, `APPROVE`) are tools too. In chain mode only the
 * reads are, and the plugin adds `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` on the
 * episode vault, signed with the episode's session key (`episodeVault`).
 *
 * The actions are filled in by `init`, which the runtime calls when it registers the plugin
 * (before it reads them). `bondedPlugin` does this by itself while an episode is running.
 */
export function bondedEpisodePlugin(options: BondedEpisodeElizaOptions = {}): ElizaPlugin {
  const plugin: ElizaPlugin = {
    name: "bonded-episode",
    description: "The tools of a Bonded Arena episode.",
    actions: [],
    providers: [],
    init: async () => {
      const episode = options.episode ?? fromBondedEnv();
      const tools = await resolveTools(options.tools ?? episode);
      const actions = tools.tools.map(toolAction);
      if (episode.mode === "chain" && episode.sessionKey)
        actions.push(
          ...bondedPlugin({
            vault: episodeVault(episode),
            tokens: episode.contracts.tokens,
            guard: options.guard ?? true,
            rating: "off",
          }).actions,
        );
      plugin.actions = actions;
      plugin.providers = [taskProvider(episode)];
    },
  };
  return plugin;
}

/** One episode tool as an Eliza action. */
function toolAction(t: EpisodeTool): ElizaAction {
  const name = t.name.toUpperCase();
  const takesArgs = Object.keys(t.inputSchema.properties ?? {}).length > 0;
  return {
    name,
    similes: [t.name],
    description: t.description,
    validate: async () => true,
    handler: async (runtime, message, state, handlerOptions, callback) => {
      const given = handlerOptions?.parameters;
      const args =
        given && typeof given === "object"
          ? (given as Record<string, unknown>)
          : takesArgs
            ? await runtime.useModel("OBJECT_SMALL", {
                prompt: [
                  `Extract the parameters for ${name} (${t.description}) from the conversation.`,
                  `Answer with JSON only, matching this JSON Schema: ${JSON.stringify(t.inputSchema)}`,
                  "Use only values the conversation states.",
                  "",
                  state?.text ?? message.content.text ?? "",
                ].join("\n"),
              })
            : {};
      const result = await t.call(
        args && typeof args === "object" ? (args as Record<string, unknown>) : {},
      );
      const text = resultText(result);
      await callback?.({ text, actions: [name] });
      return result.ok
        ? { success: true, text, data: { tool: t.name, output: result.output } }
        : { success: false, text, error: result.error, data: { tool: t.name } };
    },
  };
}

/** The episode's task, as the agent's current instructions. */
function taskProvider(episode: BondedEpisode): ElizaProvider {
  const text = [
    `Your task: ${episode.task.goal}`,
    `Your mandate: ${episode.task.mandate}`,
    `Tokens: ${episode.contracts.tokens.map((t) => t.symbol).join(", ")}.`,
  ].join("\n");
  return {
    name: "BONDED_TASK",
    description: "The task the agent is working on, and its mandate.",
    get: async () => ({
      text,
      values: { bondedTaskGoal: episode.task.goal },
      data: { episodeId: episode.episodeId, task: episode.task },
    }),
  };
}

/** The action's parameters: given by the caller, or read from the conversation by the model. */
async function readParams(
  name: BondedActionName,
  runtime: ElizaRuntime,
  message: ElizaMemory,
  state: ElizaState | undefined,
  handlerOptions: { [key: string]: unknown } | undefined,
): Promise<Record<string, string>> {
  const given = handlerOptions?.parameters;
  const raw =
    given && typeof given === "object"
      ? given
      : await runtime.useModel("OBJECT_SMALL", {
          prompt: [
            `Extract the parameters for ${name} (${DESCRIPTIONS[name]}) from the conversation.`,
            `Answer with JSON only: ${FIELDS[name]}.`,
            "Use only values the conversation states. Amounts are in whole tokens.",
            "",
            state?.text ?? message.content.text ?? "",
          ].join("\n"),
        });
  const parsed = PARAMS[name].safeParse(raw);
  if (!parsed.success)
    throw new BondedError(
      "INVALID_ACTION",
      `${name} needs ${FIELDS[name]}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`,
    );
  return parsed.data;
}

async function toVaultAction(
  name: BondedActionName,
  params: Record<string, string>,
  options: BondedElizaOptions,
): Promise<VaultAction> {
  const token = (value: string) => resolveToken(value, options);
  const units = async (value: string, amount: string) =>
    parseUnits(amount, (await token(value)).decimals);
  const recipient = (field: string, value: string): Address => {
    if (!isAddress(value, { strict: false }))
      throw new BondedError("INVALID_ACTION", `${field} must be a 0x address, not "${value}"`);
    return getAddress(value);
  };
  switch (name) {
    case "BONDED_SWAP":
      return {
        type: "swap",
        tokenIn: (await token(params.tokenIn!)).address as Address,
        tokenOut: (await token(params.tokenOut!)).address as Address,
        amountIn: await units(params.tokenIn!, params.amount!),
      };
    case "BONDED_TRANSFER":
      return {
        type: "transfer",
        token: (await token(params.token!)).address as Address,
        to: recipient("to", params.to!),
        amount: await units(params.token!, params.amount!),
      };
    case "BONDED_APPROVE":
      return {
        type: "approve",
        token: (await token(params.token!)).address as Address,
        spender: recipient("spender", params.spender!),
        amount: await units(params.token!, params.amount!),
      };
  }
}

/** A configured token by symbol (any case) or address; an unknown address's decimals are read. */
async function resolveToken(value: string, options: BondedElizaOptions): Promise<TokenInfo> {
  const tokens = options.tokens ?? [];
  const known = tokens.find(
    (t) =>
      t.symbol.toLowerCase() === value.toLowerCase() ||
      t.address.toLowerCase() === value.toLowerCase(),
  );
  if (known) return known;
  if (!isAddress(value, { strict: false }))
    throw new BondedError(
      "INVALID_ACTION",
      `unknown token "${value}"; use one of ${tokens.map((t) => t.symbol).join(", ") || "the configured tokens"} or a token address`,
    );
  const address = getAddress(value);
  const decimals = await options.vault.publicClient.readContract({
    address,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return { symbol: address, address, decimals };
}

/** What the agent read before acting: the message and recent conversation, for Sentinel. */
function conversation(message: ElizaMemory, state: ElizaState | undefined) {
  const inputs = [{ tool: "message", output: message.content.text ?? "" }];
  if (state?.text)
    inputs.push({ tool: "conversation", output: state.text.slice(-SENTINEL_INPUT_CHARS) });
  return inputs.filter((i) => i.output.length > 0);
}

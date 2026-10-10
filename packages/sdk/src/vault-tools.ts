import { EVM_CHAINS, evmChainById, mandateVaultAbi } from "@bondedhq/shared";
import {
  type Address,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  type Hex,
  isAddress,
  isHex,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { VaultAction } from "./actions.js";
import type { VaultBreach } from "./breaches.js";
import { BondedError } from "./errors.js";
import {
  type GuardContext,
  GuardedVault,
  type SentinelGuardOptions,
  type TokenInfo,
} from "./guarded.js";
import type { EpisodeToolResult, ToolInputSchema } from "./mcp.js";
import {
  type ActionResult,
  BondedVault,
  isRatedProcess,
  markProductionVault,
  ratedProductionVaultError,
  refuseProductionVaultWhileRated,
} from "./vault.js";

export interface BondedVaultToolsOptions {
  /** The vault (or module), with the agent key to send from and a `router` for swaps. */
  vault: BondedVault;
  /**
   * Tokens the model may name by symbol. Default: the mandate's own assets, read from the vault
   * once (`getAssets()`, with each token's symbol and decimals). Any token can also be named by
   * address.
   */
  tokens?: readonly TokenInfo[];
  /**
   * Dry-run each write first and refuse a predicted breach, so the model gets an error instead
   * of a recorded breach. On by default: an LLM-driven agent should not knowingly breach. The
   * vault judges either way.
   */
  guard?: boolean;
  /** Also ask Sentinel before each write that passes the dry run. Advisory; off unless set. */
  sentinel?: SentinelGuardOptions;
  /**
   * What the agent read before this write (emails, posts, tool output), for Sentinel. Called
   * before each write. The AI SDK tools fill it from the conversation's tool results by default.
   */
  context?: () => GuardContext | Promise<GuardContext>;
}

/** The tools' names: the same as the Arena episode's write tools, plus `vault_status`. */
export const BONDED_VAULT_TOOLS = ["swap", "transfer", "approve", "vault_status"] as const;
export type BondedVaultToolName = (typeof BONDED_VAULT_TOOLS)[number];

/** One vault tool, framework-neutral: wrap it for your framework, or use the helpers. */
export interface BondedVaultTool {
  name: BondedVaultToolName;
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Runs the tool. A failure (a refused dry run, Sentinel's advice, a blocked or reverted call,
   * bad arguments) is returned as `{ ok: false, error }`, not thrown, so the model can react.
   */
  call(args?: Record<string, unknown>, context?: GuardContext): Promise<EpisodeToolResult>;
}

const amount = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^\d+(\.\d+)?$/, "a decimal amount in whole tokens, e.g. 250 or 12.5"));
const ARGS = {
  swap: z.object({
    tokenIn: z.string(),
    tokenOut: z.string(),
    amountIn: amount,
    minOut: amount.optional(),
  }),
  transfer: z.object({ token: z.string(), to: z.string(), amount }),
  approve: z.object({ token: z.string(), spender: z.string(), amount }),
  vault_status: z.object({}),
} satisfies Record<BondedVaultToolName, z.ZodType>;

const decimal = { type: "string", description: "A decimal amount in whole tokens, e.g. 250" };
const token = { type: "string", description: "A token symbol (e.g. tUSDG) or address" };
const SCHEMAS: Record<BondedVaultToolName, ToolInputSchema> = {
  swap: {
    type: "object",
    properties: {
      tokenIn: { ...token, description: "The token to sell: a symbol or address" },
      tokenOut: { ...token, description: "The token to buy: a symbol or address" },
      amountIn: { ...decimal, description: "How much tokenIn to sell, in whole tokens" },
      minOut: { ...decimal, description: "Optional: the least tokenOut to accept" },
    },
    required: ["tokenIn", "tokenOut", "amountIn"],
    additionalProperties: false,
  },
  transfer: {
    type: "object",
    properties: {
      token,
      to: { type: "string", description: "The recipient's 0x address" },
      amount: decimal,
    },
    required: ["token", "to", "amount"],
    additionalProperties: false,
  },
  approve: {
    type: "object",
    properties: {
      token,
      spender: { type: "string", description: "The 0x address allowed to spend" },
      amount: { ...decimal, description: "The most it may spend, in whole tokens; 0 revokes" },
    },
    required: ["token", "spender", "amount"],
    additionalProperties: false,
  },
  vault_status: { type: "object", properties: {}, additionalProperties: false },
};

const DESCRIPTIONS: Record<BondedVaultToolName, string> = {
  swap: "Swap one token for another with the funds in the agent's Bonded Mandate Vault. Every trade is checked against the agent's mandate.",
  transfer:
    "Send tokens from the agent's Bonded Mandate Vault to an address. Only the mandate's destinations are allowed.",
  approve:
    "Let an address spend tokens from the agent's Bonded Mandate Vault. Only the mandate's contracts are allowed.",
  vault_status:
    "The agent's Bonded Mandate Vault: its mode, whether it is frozen, breaches recorded, and its token balances.",
};

/**
 * The vault's trading tools, framework-neutral: `swap`, `transfer`, `approve` (the same names and
 * arguments as the Arena episode's write tools, so the agent's prompts work the same while it is
 * rated) and `vault_status`. Every write goes through `BondedVault`, so the vault checks it
 * against the mandate; by default each is dry-run first and refused on a predicted breach.
 * `bondedVaultLangChainTools` and `bondedVaultAiSdkTools` wrap these for their frameworks.
 */
export function bondedVaultTools(options: BondedVaultToolsOptions): BondedVaultTool[] {
  // While rated, the production vault's tools are refused outright: use the episode's tools.
  refuseProductionVaultWhileRated(options.vault, "bondedVaultTools");
  const guard = options.guard ?? true;
  const tokens = tokenBook(options);
  // Sentinel sees symbols and whole units: the configured tokens, else the mandate's.
  let guarded: GuardedVault | undefined;
  const guardedVault = async () => {
    const s = options.sentinel;
    guarded ??= new GuardedVault(
      options.vault,
      s ? { sentinel: { ...s, tokens: s.tokens ?? (await tokens.list()) } } : {},
    );
    return guarded;
  };

  /** One tool call: the write it confirmed, once it has. */
  interface Call {
    confirmed?: ActionResult;
  }

  const send = async (action: VaultAction, given?: GuardContext): Promise<ActionResult> => {
    if (!guard && !options.sentinel) return options.vault.execute(action);
    const context = given ?? (options.sentinel && options.context ? await options.context() : {});
    return (await guardedVault()).execute(action, context);
  };

  const run = async (
    name: BondedVaultToolName,
    raw: Record<string, unknown>,
    context: GuardContext | undefined,
    call: Call,
  ): Promise<unknown> => {
    const write = async (action: VaultAction, given?: GuardContext) =>
      (call.confirmed = await send(action, given));
    const parsed = ARGS[name].safeParse(raw);
    if (!parsed.success)
      throw new BondedError(
        "INVALID_ACTION",
        `${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message}`).join(", ")}`,
      );
    const args = parsed.data as Record<string, string>;
    switch (name) {
      case "swap": {
        const tokenIn = await tokens.resolve(args.tokenIn!);
        const tokenOut = await tokens.resolve(args.tokenOut!);
        const { holder } = await options.vault.identify();
        const before = await balance(options.vault, tokenOut.address as Address, holder);
        const result = await write(
          {
            type: "swap",
            tokenIn: tokenIn.address as Address,
            tokenOut: tokenOut.address as Address,
            amountIn: parseUnits(args.amountIn!, tokenIn.decimals),
            ...(args.minOut ? { minOut: parseUnits(args.minOut, tokenOut.decimals) } : {}),
          },
          context,
        );
        // The trade is confirmed: reading what it bought is best-effort. Failing here would hide
        // the transactions and invite the model to trade again.
        const after = await balance(options.vault, tokenOut.address as Address, holder).catch(
          () => undefined,
        );
        return outcome(
          result,
          {
            sold: `${args.amountIn} ${tokenIn.symbol}`,
            received:
              after === undefined
                ? null
                : `${formatUnits(after - before, tokenOut.decimals)} ${tokenOut.symbol}`,
          },
          after === undefined ? BALANCE_UNREAD : undefined,
        );
      }
      case "transfer": {
        const t = await tokens.resolve(args.token!);
        const to = address("to", args.to!);
        const result = await write(
          {
            type: "transfer",
            token: t.address as Address,
            to,
            amount: parseUnits(args.amount!, t.decimals),
          },
          context,
        );
        return outcome(result, { sent: `${args.amount} ${t.symbol}`, to });
      }
      case "approve": {
        const t = await tokens.resolve(args.token!);
        const spender = address("spender", args.spender!);
        const result = await write(
          {
            type: "approve",
            token: t.address as Address,
            spender,
            amount: parseUnits(args.amount!, t.decimals),
          },
          context,
        );
        return outcome(result, { approved: `${args.amount} ${t.symbol}`, spender });
      }
      case "vault_status": {
        const status = await options.vault.status();
        const known = await tokens.list();
        const balances = Object.fromEntries(
          await Promise.all(
            known.map(async (t) => [
              t.symbol,
              formatUnits(
                await balance(options.vault, t.address as Address, status.holder),
                t.decimals,
              ),
            ]),
          ),
        );
        return {
          vault: options.vault.address,
          kind: status.kind,
          holder: status.holder,
          mode: status.mode,
          frozen: status.frozen,
          breachCount: status.breachCount.toString(),
          balances,
        };
      }
    }
  };

  return BONDED_VAULT_TOOLS.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: SCHEMAS[name],
    call: async (args = {}, context) => {
      const call: Call = {};
      try {
        refuseProductionVaultWhileRated(options.vault, name);
        const output = await run(name, args, context, call);
        return { ok: true, output, text: JSON.stringify(output) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Anything that fails after the write confirmed is a read: report the write, never a
        // failure the model would retry (a second trade).
        if (call.confirmed) {
          const output = outcome(
            call.confirmed,
            {},
            `The ${name} is confirmed (see transactions), but reading its result failed (${message}). Don't repeat it: check vault_status.`,
          );
          return { ok: true, output, text: JSON.stringify(output) };
        }
        return { ok: false, error: message, text: message };
      }
    },
  }));
}

const BALANCE_UNREAD =
  "Trade confirmed (see transactions); couldn't read the new balance, so what it received is unknown. Don't repeat the trade: check vault_status.";

/**
 * A write's result as the model reads it: what moved, the transactions, and any breach the vault
 * recorded or anything the tool couldn't read afterwards.
 */
function outcome(result: ActionResult, moved: Record<string, string | null>, unread?: string) {
  const warnings = [
    ...(result.breaches.length
      ? [
          "The vault ran this action but recorded a breach of the mandate. The vault may have frozen the agent.",
        ]
      : []),
    ...(unread ? [unread] : []),
  ];
  return {
    ...moved,
    transactions: result.hashes,
    ...(result.breaches.length ? { breaches: result.breaches.map(breachView) } : {}),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

function breachView(b: VaultBreach) {
  return { id: b.id.toString(), type: b.type, reason: b.reason, blocked: b.blocked };
}

function address(field: string, value: string): Address {
  if (!isAddress(value, { strict: false }))
    throw new BondedError("INVALID_ACTION", `${field} must be a 0x address, not "${value}"`);
  return getAddress(value);
}

function balance(vault: BondedVault, token: Address, holder: Address): Promise<bigint> {
  return vault.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
}

/**
 * The tokens the model can name: the configured ones, else the mandate's assets read from the
 * vault once. An unknown address is looked up on chain.
 */
function tokenBook(options: BondedVaultToolsOptions) {
  let known: Promise<readonly TokenInfo[]> | undefined;
  const list = (): Promise<readonly TokenInfo[]> => {
    if (options.tokens) return Promise.resolve(options.tokens);
    known ??= readMandateTokens(options.vault).catch(() => {
      known = undefined;
      return [];
    });
    return known;
  };
  const resolve = async (value: string): Promise<TokenInfo> => {
    const tokens = await list();
    const found = tokens.find(
      (t) =>
        t.symbol.toLowerCase() === value.toLowerCase() ||
        t.address.toLowerCase() === value.toLowerCase(),
    );
    if (found) return found;
    if (!isAddress(value, { strict: false }))
      throw new BondedError(
        "INVALID_ACTION",
        `unknown token "${value}"; use one of ${tokens.map((t) => t.symbol).join(", ") || "the mandate's tokens"} or a token address`,
      );
    return tokenInfo(options.vault, getAddress(value));
  };
  return { list, resolve };
}

async function readMandateTokens(vault: BondedVault): Promise<TokenInfo[]> {
  const assets = await vault.publicClient.readContract({
    address: vault.address,
    abi: mandateVaultAbi,
    functionName: "getAssets",
  });
  return Promise.all(assets.map((a) => tokenInfo(vault, a)));
}

async function tokenInfo(vault: BondedVault, address: Address): Promise<TokenInfo> {
  const read = <F extends "symbol" | "decimals">(functionName: F) =>
    vault.publicClient.readContract({ address, abi: erc20Abi, functionName });
  const [symbol, decimals] = await Promise.all([
    read("symbol").catch(() => address),
    read("decimals"),
  ]);
  return { symbol, address, decimals };
}

/**
 * The production vault from the environment, or undefined when `BONDED_VAULT_ADDRESS` isn't set
 * (so the same code runs before the agent has a vault):
 *
 * | Variable | Meaning |
 * |---|---|
 * | `BONDED_VAULT_ADDRESS` | The Mandate Vault (or MandateModule) |
 * | `BONDED_AGENT_KEY` | The vault's agent key (0x private key), required with the address |
 * | `BONDED_VAULT_CHAIN_ID` | Default 46630 (Robinhood Chain testnet) |
 * | `BONDED_VAULT_RPC_URL` | Default: the chain's public RPC |
 * | `BONDED_ROUTER_ADDRESS` | The swap venue your mandate allows (Bonded's `DemoRouter` on testnet) |
 *
 * These are different from the `BONDED_*` variables the runner sets for an episode, and the
 * runner removes them from a rated agent's environment. If they come back anyway (a `.env` file
 * reloaded with `node --env-file` or dotenv), this still returns undefined while the process is
 * rated, and warns once: a rating never trades the production vault.
 */
export function bondedVaultFromEnv(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): BondedVault | undefined {
  const vault = env.BONDED_VAULT_ADDRESS?.trim();
  // A rated process never builds the production vault, even when its variables are back (a
  // .env file reloaded with `node --env-file` or dotenv): undefined, as if they weren't set.
  if (isRatedProcess(env) || isRatedProcess()) {
    if (vault || env.BONDED_AGENT_KEY?.trim()) warnRatedOnce();
    return undefined;
  }
  if (!vault) return undefined;
  const problems: string[] = [];
  if (!isAddress(vault, { strict: false })) problems.push("BONDED_VAULT_ADDRESS isn't an address");
  const key = env.BONDED_AGENT_KEY?.trim();
  if (!key) problems.push("BONDED_AGENT_KEY (the vault's agent key) isn't set");
  else if (!isHex(key) || key.length !== 66)
    problems.push("BONDED_AGENT_KEY must be a 0x-prefixed 32-byte private key");
  const chainId = Number(env.BONDED_VAULT_CHAIN_ID?.trim() || EVM_CHAINS.robinhoodTestnet.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    problems.push("BONDED_VAULT_CHAIN_ID must be a chain id");
  const known = evmChainById(chainId);
  const rpcUrl = env.BONDED_VAULT_RPC_URL?.trim() || known?.rpcUrl;
  if (!rpcUrl)
    problems.push(`BONDED_VAULT_RPC_URL isn't set (no default RPC for chain ${chainId})`);
  const router = env.BONDED_ROUTER_ADDRESS?.trim();
  if (router && !isAddress(router, { strict: false }))
    problems.push("BONDED_ROUTER_ADDRESS isn't an address");
  if (problems.length) throw new BondedError("CONFIG", problems.join("; "));
  const built = new BondedVault({
    vault: vault as Address,
    chain: defineChain({
      id: chainId,
      name: known?.name ?? `Chain ${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl!] } },
    }),
    rpcUrl: rpcUrl!,
    account: privateKeyToAccount(key as Hex),
    ...(router ? { router: router as Address } : {}),
  });
  return markProductionVault(built);
}

let warnedRated = false;
function warnRatedOnce(): void {
  if (warnedRated) return;
  warnedRated = true;
  console.warn(`[bonded] ${ratedProductionVaultError("bondedVaultFromEnv").message}`);
}

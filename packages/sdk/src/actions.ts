import { demoRouterAbi } from "@bonded/shared";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  type Hex,
  isAddress,
  isHex,
  type PublicClient,
} from "viem";
import { BondedError } from "./errors.js";

/** Swap `amountIn` of `tokenIn` (base units) for `tokenOut`, through the vault's router. */
export interface SwapParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Smallest acceptable output, in `tokenOut` base units. */
  minOut?: bigint;
}

/** Send `amount` of `token` (base units) from the vault to `to`. */
export interface TransferParams {
  token: Address;
  to: Address;
  amount: bigint;
}

/** Let `spender` move up to `amount` of the vault's `token`. 0 revokes. */
export interface ApproveParams {
  token: Address;
  spender: Address;
  amount: bigint;
}

/** Any call the vault should make: `target` with calldata `data` (ERC-20 only, no native value). */
export interface CallParams {
  target: Address;
  data: Hex;
}

/** One thing the agent asks its vault to do. */
export type VaultAction =
  | ({ type: "swap" } & SwapParams)
  | ({ type: "transfer" } & TransferParams)
  | ({ type: "approve" } & ApproveParams)
  | ({ type: "call" } & CallParams);

/** One `MandateVault.execute(target, data)`. An action becomes one or more of these. */
export interface VaultCall {
  target: Address;
  data: Hex;
}

/**
 * A swap venue the vault's mandate allows. `swap` approves the router for `amountIn` when the
 * vault's allowance is short, then calls it with the vault as the recipient.
 */
export interface SwapRouter {
  address: Address;
  /** Calldata for the swap; the output must go to `recipient` (the vault). */
  encodeSwap(params: Required<SwapParams> & { recipient: Address }): Hex;
  /**
   * Expected output for a swap. When present, a swap whose quote is below `minOut` is refused
   * before anything is sent (for routers whose calldata can't carry a minimum).
   */
  quote?(client: PublicClient, params: SwapParams): Promise<bigint>;
}

/**
 * Bonded's testnet market (`DemoRouter`: oracle prices minus a fee). Its `swap` has no minimum
 * output, so `minOut` is checked against its quote before sending.
 */
export function demoRouter(address: Address): SwapRouter {
  const router = getAddress(address);
  return {
    address: router,
    encodeSwap: (p) =>
      encodeFunctionData({
        abi: demoRouterAbi,
        functionName: "swap",
        args: [p.tokenIn, p.tokenOut, p.amountIn, p.recipient],
      }),
    quote: (client, p) =>
      client.readContract({
        address: router,
        abi: demoRouterAbi,
        functionName: "quote",
        args: [p.tokenIn, p.tokenOut, p.amountIn],
      }),
  };
}

/** Checks an action's fields and normalises its addresses, with errors that name the field. */
export function normaliseAction(action: VaultAction): VaultAction {
  const address = (field: string, value: unknown): Address => {
    if (typeof value !== "string" || !isAddress(value, { strict: false }))
      throw new BondedError("INVALID_ACTION", `${action.type}: ${field} must be an address`);
    return getAddress(value);
  };
  const amount = (field: string, value: unknown): bigint => {
    if (typeof value !== "bigint" || value < 0n)
      throw new BondedError(
        "INVALID_ACTION",
        `${action.type}: ${field} must be a non-negative bigint in the token's base units`,
      );
    return value;
  };
  switch (action.type) {
    case "swap":
      return {
        type: "swap",
        tokenIn: address("tokenIn", action.tokenIn),
        tokenOut: address("tokenOut", action.tokenOut),
        amountIn: amount("amountIn", action.amountIn),
        ...(action.minOut !== undefined ? { minOut: amount("minOut", action.minOut) } : {}),
      };
    case "transfer":
      return {
        type: "transfer",
        token: address("token", action.token),
        to: address("to", action.to),
        amount: amount("amount", action.amount),
      };
    case "approve":
      return {
        type: "approve",
        token: address("token", action.token),
        spender: address("spender", action.spender),
        amount: amount("amount", action.amount),
      };
    case "call":
      if (!isHex(action.data))
        throw new BondedError("INVALID_ACTION", "call: data must be 0x-prefixed hex");
      return { type: "call", target: address("target", action.target), data: action.data };
    default:
      throw new BondedError(
        "INVALID_ACTION",
        `unknown action type ${(action as { type: unknown }).type}`,
      );
  }
}

/** ERC-20 calldata for a transfer or approval. */
export function erc20Call(
  fn: "transfer" | "approve",
  token: Address,
  who: Address,
  amount: bigint,
): VaultCall {
  return {
    target: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: fn, args: [who, amount] }),
  };
}

/** An action in the words Sentinel was trained on: a tool name and string arguments. */
export function describeAction(
  action: VaultAction,
  tokens: readonly { symbol: string; address: string; decimals: number }[] = [],
): { tool: string; args: Record<string, string> } {
  const token = (a: Address) => tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());
  const symbol = (a: Address) => token(a)?.symbol ?? a;
  const units = (a: Address, value: bigint) => {
    const t = token(a);
    return t ? formatUnits(value, t.decimals) : value.toString();
  };
  switch (action.type) {
    case "swap":
      return {
        tool: "swap",
        args: {
          tokenIn: symbol(action.tokenIn),
          tokenOut: symbol(action.tokenOut),
          amountIn: units(action.tokenIn, action.amountIn),
        },
      };
    case "transfer":
      return {
        tool: "transfer",
        args: {
          token: symbol(action.token),
          to: action.to,
          amount: units(action.token, action.amount),
        },
      };
    case "approve":
      return {
        tool: "approve",
        args: {
          token: symbol(action.token),
          spender: action.spender,
          amount: units(action.token, action.amount),
        },
      };
    case "call":
      return { tool: "call", args: { target: action.target, data: action.data.slice(0, 2_000) } };
  }
}

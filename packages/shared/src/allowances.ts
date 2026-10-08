import { erc20Abi, type Address } from "viem";
import type { EvmDeployment } from "./deployments.js";
import type { ContractReader } from "./module-install.js";

/**
 * Approvals a MandateModule can't see. A module guards what the agent does through it, but the
 * smart account's owner may already have approved some contract to move a token. If that contract
 * is one of the mandate's targets (the exchange, say) and the token isn't one of the mandate's
 * assets, the agent can have the target move that token through an allowed call, and the module
 * records no breach. Before protecting an account (and while it is protected), list those
 * approvals so the owner can revoke them or use a dedicated account.
 */

/** A token to check, with its symbol for the warning. */
export interface TokenRef {
  address: Address;
  symbol?: string;
}

/** A non-zero allowance from the account to one of the mandate's targets. */
export interface AllowanceFinding {
  token: Address;
  symbol?: string;
  spender: Address;
  allowance: bigint;
  /** The account's balance of the token. */
  balance: bigint;
  /** The token is one of the mandate's assets, which the module accounts for. */
  inMandate: boolean;
}

export interface AllowanceCheck {
  /** Every non-zero allowance to a target. */
  allowances: AllowanceFinding[];
  /** The ones the mandate doesn't cover: the agent could move these without a breach. */
  unprotected: AllowanceFinding[];
  /** Token and target pairs read. */
  checked: number;
}

/** The tokens a deployment's demo market uses: the ones worth checking on a testnet account. */
export function deploymentTokens(d: EvmDeployment): TokenRef[] {
  return [
    { address: d.usdg as Address, symbol: "tUSDG" },
    { address: d.tsla as Address, symbol: "tTSLA" },
    { address: d.amzn as Address, symbol: "tAMZN" },
    { address: d.nvda as Address, symbol: "tNVDA" },
  ];
}

/**
 * Reads the account's allowance to every mandate target, and its balance, for each mandate asset
 * and each extra token given (e.g. `deploymentTokens`, or the tokens the account is known to
 * hold). A token that fails to answer (not an ERC-20) is skipped.
 */
export async function checkUnprotectedAllowances(
  client: ContractReader,
  input: {
    account: Address;
    /** The mandate's targets: the contracts the agent may call. */
    targets: readonly Address[];
    /** The mandate's assets. */
    assets: readonly Address[];
    /** More tokens to check, with symbols. */
    tokens?: readonly TokenRef[];
  },
): Promise<AllowanceCheck> {
  const lower = (a: string) => a.toLowerCase();
  const assets = new Set(input.assets.map(lower));
  const byAddress = new Map<string, TokenRef>();
  const refs: TokenRef[] = [
    ...input.assets.map((address) => ({ address })),
    ...(input.tokens ?? []),
  ];
  for (const t of refs) {
    const known = byAddress.get(lower(t.address));
    const symbol = t.symbol ?? known?.symbol;
    byAddress.set(lower(t.address), {
      address: known?.address ?? t.address,
      ...(symbol ? { symbol } : {}),
    });
  }
  // Each target once, as first given.
  const targets = input.targets.filter(
    (t, i) => input.targets.findIndex((u) => lower(u) === lower(t)) === i,
  );
  const read = (address: Address, functionName: string, args: readonly unknown[]) =>
    client.readContract({ address, abi: erc20Abi, functionName, args }) as Promise<bigint>;
  let checked = 0;
  const allowances: AllowanceFinding[] = [];
  for (const token of byAddress.values()) {
    let balance: bigint;
    try {
      balance = await read(token.address, "balanceOf", [input.account]);
    } catch {
      continue;
    }
    for (const spender of targets) {
      checked++;
      const allowance = await read(token.address, "allowance", [input.account, spender]).catch(
        () => 0n,
      );
      if (allowance > 0n)
        allowances.push({
          token: token.address,
          ...(token.symbol ? { symbol: token.symbol } : {}),
          spender,
          allowance,
          balance,
          inMandate: assets.has(lower(token.address)),
        });
    }
  }
  return { allowances, unprotected: allowances.filter((a) => !a.inMandate), checked };
}

/** The warning to show for unprotected approvals, in plain words, or undefined when there are none. */
export function unprotectedAllowancesWarning(
  findings: readonly AllowanceFinding[],
): string | undefined {
  if (!findings.length) return undefined;
  const list = findings.map((f) => `${f.symbol ?? f.token} approved to ${f.spender}`).join("; ");
  return `These approvals let the agent's allowed contracts move tokens the mandate doesn't cover: ${list}. Revoke them or use a dedicated account.`;
}

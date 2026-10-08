import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  checkUnprotectedAllowances,
  deploymentTokens,
  unprotectedAllowancesWarning,
  type ContractReader,
} from "../src/index.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ACCOUNT = addr(0xacc);
const ROUTER = addr(0x7e);
const OTHER_TARGET = addr(0x7f);
const USDG = addr(1);
const TSLA = addr(2);
const AMZN = addr(3);
const NOT_A_TOKEN = addr(4);

/** A chain where the account approved the router for USDG (a mandate asset) and AMZN (not one). */
function chain(): ContractReader & { reads: number } {
  const allowances: Record<string, bigint> = {
    [`${USDG}:${ROUTER}`]: 10n,
    [`${AMZN}:${ROUTER}`]: 2n ** 256n - 1n,
  };
  const reader = {
    reads: 0,
    async readContract({
      address,
      functionName,
      args,
    }: {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    }) {
      reader.reads++;
      if (address === NOT_A_TOKEN) throw new Error("execution reverted");
      if (functionName === "balanceOf") return address === AMZN ? 500n : 0n;
      return allowances[`${address}:${args[1] as string}`] ?? 0n;
    },
  };
  return reader as never;
}

describe("checkUnprotectedAllowances", () => {
  it("lists approvals to mandate targets of tokens the mandate doesn't cover", async () => {
    const result = await checkUnprotectedAllowances(chain(), {
      account: ACCOUNT,
      targets: [ROUTER, OTHER_TARGET, ROUTER.toUpperCase().replace("0X", "0x") as Address],
      assets: [USDG, TSLA],
      tokens: [
        { address: AMZN, symbol: "tAMZN" },
        { address: USDG, symbol: "tUSDG" },
        { address: NOT_A_TOKEN, symbol: "X" },
      ],
    });
    // USDG, TSLA and AMZN against two distinct targets; the non-token is skipped.
    expect(result.checked).toBe(6);
    expect(result.allowances).toHaveLength(2);
    expect(result.allowances.find((a) => a.token === USDG)).toMatchObject({
      inMandate: true,
      symbol: "tUSDG",
    });
    expect(result.unprotected).toEqual([
      {
        token: AMZN,
        symbol: "tAMZN",
        spender: ROUTER,
        allowance: 2n ** 256n - 1n,
        balance: 500n,
        inMandate: false,
      },
    ]);
    expect(unprotectedAllowancesWarning(result.unprotected)).toBe(
      `These approvals let the agent's allowed contracts move tokens the mandate doesn't cover: tAMZN approved to ${ROUTER}. Revoke them or use a dedicated account.`,
    );
  });

  it("says nothing when there is nothing to revoke", async () => {
    const result = await checkUnprotectedAllowances(chain(), {
      account: ACCOUNT,
      targets: [OTHER_TARGET],
      assets: [USDG],
    });
    expect(result.unprotected).toEqual([]);
    expect(unprotectedAllowancesWarning(result.unprotected)).toBeUndefined();
  });

  it("knows a deployment's demo tokens", () => {
    const tokens = deploymentTokens({
      usdg: USDG,
      tsla: TSLA,
      amzn: AMZN,
      nvda: addr(5),
    } as never);
    expect(tokens.map((t) => t.symbol)).toEqual(["tUSDG", "tTSLA", "tAMZN", "tNVDA"]);
  });
});

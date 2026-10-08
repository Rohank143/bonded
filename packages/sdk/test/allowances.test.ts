import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { checkUnprotectedAllowances, unprotectedAllowancesWarning } from "../src/index.js";

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const ROUTER = "0x00000000000000000000000000000000000000bb" as Address;
const USDG = "0x0000000000000000000000000000000000000001" as Address;
const WETH = "0x0000000000000000000000000000000000000002" as Address;

describe("checkUnprotectedAllowances (from the SDK)", () => {
  it("flags a token outside the mandate that the account already approved to a target", async () => {
    const client = {
      readContract: async ({
        address,
        functionName,
      }: {
        address: Address;
        functionName: string;
      }) => (functionName === "allowance" ? (address === WETH ? 1n : 5n) : 0n),
    };
    const { unprotected } = await checkUnprotectedAllowances(client, {
      account: ACCOUNT,
      targets: [ROUTER],
      assets: [USDG],
      tokens: [{ address: WETH, symbol: "WETH" }],
    });
    expect(unprotected.map((f) => f.symbol)).toEqual(["WETH"]);
    expect(unprotectedAllowancesWarning(unprotected)).toMatch(/WETH approved to/);
  });
});

import { describe, expect, it } from "vitest";
import { splitTokens, tokenSymbol } from "./tokens";

const tokens = {
  usdg: "0x1111111111111111111111111111111111111111",
  tsla: "0x2222222222222222222222222222222222222222",
  amzn: "0x3333333333333333333333333333333333333333",
  nvda: "0x4444444444444444444444444444444444444444",
};

describe("tokenSymbol", () => {
  it("names the deployment's tokens, whatever the address case", () => {
    expect(tokenSymbol(tokens.usdg, tokens)).toBe("tUSDG");
    expect(tokenSymbol(tokens.tsla.toUpperCase().replace("0X", "0x"), tokens)).toBe("tTSLA");
    expect(tokenSymbol(tokens.nvda, tokens)).toBe("tNVDA");
  });
  it("shortens an address it doesn't know", () => {
    expect(tokenSymbol("0xabcdef0000000000000000000000000000001234", tokens)).toBe("0xabcd…1234");
  });
});

describe("splitTokens", () => {
  it("marks each token symbol and keeps the text around it", () => {
    expect(splitTokens("Deposit 100 tUSDG into tNVDA")).toEqual([
      { text: "Deposit 100 ", token: false },
      { text: "tUSDG", token: true },
      { text: " into ", token: false },
      { text: "tNVDA", token: true },
    ]);
  });
  it("returns plain text as one run and ignores look-alikes", () => {
    expect(splitTokens("no tokens here")).toEqual([{ text: "no tokens here", token: false }]);
    expect(splitTokens("atUSDG tUSDGx")).toEqual([{ text: "atUSDG tUSDGx", token: false }]);
    expect(splitTokens("")).toEqual([]);
  });
});

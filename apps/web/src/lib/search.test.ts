import { describe, expect, it } from "vitest";
import { isAddress } from "viem";
import { searchTarget } from "./search";

const deps = { isAddress, explorerUrl: "https://explorer.example" };

describe("searchTarget", () => {
  it("sends an agent ID, with or without # or the word agent, to the agent page", () => {
    expect(searchTarget("11", deps)).toEqual({ href: "/agents/11", external: false });
    expect(searchTarget(" #11 ", deps)).toEqual({ href: "/agents/11", external: false });
    expect(searchTarget("Agent 3", deps)).toEqual({ href: "/agents/3", external: false });
  });
  it("sends an address to its vault page", () => {
    const vault = "0xbE32918715e9962F488BDed1e70fD8e782B4851c";
    expect(searchTarget(vault, deps)).toEqual({ href: `/vaults/${vault}`, external: false });
  });
  it("opens a transaction hash on the explorer", () => {
    const tx = `0x${"a".repeat(64)}`;
    expect(searchTarget(tx, deps)).toEqual({
      href: `https://explorer.example/tx/${tx}`,
      external: true,
    });
  });
  it("finds nothing for anything else, or for a tx with no explorer", () => {
    expect(searchTarget("hello", deps)).toBeNull();
    expect(searchTarget(`0x${"a".repeat(64)}`, { ...deps, explorerUrl: "" })).toBeNull();
  });
});

import { isAddress } from "viem";
import { describe, expect, it } from "vitest";
import { EVM_CHAINS, SOLANA_DEVNET, evmChainById } from "../src/index.js";

describe("chain configs", () => {
  it("has unique chain ids", () => {
    const ids = Object.values(EVM_CHAINS).map((chain) => chain.chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses valid addresses wherever an address is known", () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      const address = chain.stablecoin.value.address;
      if (address !== null) expect(isAddress(address)).toBe(true);
      if (chain.erc8004.value) {
        expect(isAddress(chain.erc8004.value.identity)).toBe(true);
        expect(isAddress(chain.erc8004.value.reputation)).toBe(true);
      }
    }
  });

  it("looks up Robinhood Chain testnet by id", () => {
    expect(evmChainById(46630)?.key).toBe("robinhoodTestnet");
    expect(evmChainById(1)).toBeUndefined();
  });

  it("keeps the Solana devnet USDC mint", () => {
    expect(SOLANA_DEVNET.stablecoin.value.mint).toHaveLength(44);
  });
});

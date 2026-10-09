import { describe, expect, it } from "vitest";
import { defineChain } from "viem";
import {
  addChainParams,
  confirmationCount,
  confirmationsText,
  ethText,
  gasLine,
  gasNeeded,
  onboardingPlan,
  supportsAtomicBatch,
} from "./wallet-help";

describe("wallet help", () => {
  it("adds the network with EIP-3085 parameters", () => {
    const chain = defineChain({
      id: 46630,
      name: "Robinhood Chain Testnet",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://rpc.example"] } },
      blockExplorers: { default: { name: "Explorer", url: "https://explorer.example" } },
    });
    expect(addChainParams(chain)).toEqual({
      chainId: "0xb626",
      chainName: "Robinhood Chain Testnet",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://rpc.example"],
      blockExplorerUrls: ["https://explorer.example"],
    });
  });

  it("reads atomic batching from wallet_getCapabilities, old and new forms", () => {
    expect(supportsAtomicBatch({ 46630: { atomic: { status: "supported" } } }, 46630)).toBe(true);
    expect(supportsAtomicBatch({ "0xb626": { atomic: { status: "ready" } } }, 46630)).toBe(true);
    expect(supportsAtomicBatch({ 46630: { atomicBatch: { supported: true } } }, 46630)).toBe(true);
    expect(supportsAtomicBatch({ atomic: { status: "supported" } }, 46630)).toBe(true);
    expect(supportsAtomicBatch({ 46630: { atomic: { status: "unsupported" } } }, 46630)).toBe(
      false,
    );
    expect(supportsAtomicBatch({ 1: { atomic: { status: "supported" } } }, 46630)).toBe(false);
    expect(supportsAtomicBatch(undefined, 46630)).toBe(false);
  });

  it("groups the onboarding so nothing waits on what a later batch makes", () => {
    const vault = onboardingPlan({ done: [], bond: 1n, deposit: 1n, module: false });
    expect(vault).toEqual([
      ["register", "faucet", "approveBond"],
      ["createVault", "stake"],
      ["approveDeposit", "deposit"],
    ]);
    expect(confirmationCount(vault, false)).toBe(7);
    expect(confirmationCount(vault, true)).toBe(3);
    const module = onboardingPlan({ done: [], bond: 1n, deposit: 5n, module: true });
    expect(module).toEqual([
      ["register", "faucet", "approveBond"],
      ["findModule", "stake"],
    ]);
    expect(confirmationCount(module, false)).toBe(4);
    expect(confirmationCount(module, true)).toBe(2);
    // No bond and no deposit: register and the vault only.
    const bare = onboardingPlan({ done: [], bond: 0n, deposit: 0n, module: false });
    expect(bare).toEqual([["register"], ["createVault"]]);
    expect(confirmationCount(bare, true)).toBe(2);
    // Resuming skips what's done, and the faucet mints only what's still needed.
    expect(
      onboardingPlan({
        done: ["register", "vault", "faucet"],
        bond: 1n,
        deposit: 1n,
        module: false,
      }),
    ).toEqual([["approveBond"], ["stake"], ["approveDeposit", "deposit"]]);
    expect(confirmationsText(1)).toBe("1 wallet confirmation");
    expect(confirmationsText(3)).toBe("3 wallet confirmations");
  });

  it("works out the gas from what was simulated, and says nothing it didn't measure", () => {
    expect(gasNeeded({ gasUsed: [100_000n, 200_000n], gasPrice: 10n, marginPct: 50 })).toBe(
      4_500_000n,
    );
    expect(gasNeeded({ gasUsed: undefined, gasPrice: 10n })).toBeUndefined();
    expect(gasNeeded({ gasUsed: [1n], gasPrice: undefined })).toBeUndefined();
    expect(gasLine(undefined, 5n).text).not.toMatch(/\d/);
    expect(ethText(420_000_000_000_000n)).toBe("0.00042 ETH");
    expect(ethText(1_000_000_000_000_000_000n)).toBe("1 ETH");
    expect(gasLine(10n ** 15n, 10n ** 16n)).toEqual({
      text: "You need about 0.001 ETH for gas, and you have 0.01 ETH.",
      short: false,
    });
    expect(gasLine(10n ** 16n, 10n ** 15n).short).toBe(true);
  });
});

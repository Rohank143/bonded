import { describe, expect, it } from "vitest";
import {
  EvmMandate,
  Mandate,
  SolanaMandate,
  mandateHash,
  toEvmMandateParams,
} from "../src/index.js";
import { EXACT_INPUT_SINGLE, ROUTER, TSLA, USDG, evmMandate, solanaMandate } from "./fixtures.js";

describe("EvmMandate", () => {
  it("accepts a valid mandate and checksums addresses", () => {
    const parsed = EvmMandate.parse(evmMandate({ baseAsset: USDG.toLowerCase() }));
    expect(parsed.baseAsset).toBe("0x1111111111111111111111111111111111111111");
    expect(parsed.targets[0]?.selectors).toEqual([EXACT_INPUT_SINGLE]);
  });

  it("rejects a base asset missing from assets", () => {
    const result = EvmMandate.safeParse(evmMandate({ assets: [TSLA] }));
    expect(result.success).toBe(false);
  });

  it("rejects duplicate assets regardless of case", () => {
    const result = EvmMandate.safeParse(
      evmMandate({ assets: [USDG, USDG.toUpperCase().replace("0X", "0x")] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a daily limit below the per-transaction limit", () => {
    const result = EvmMandate.safeParse(
      evmMandate({
        limits: { maxTxNotionalUsd: 10_000, maxDailyNotionalUsd: 5_000, maxDrawdownBps: 1_000 },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects bad selectors and addresses", () => {
    expect(
      EvmMandate.safeParse(evmMandate({ targets: [{ address: ROUTER, selectors: ["0x1234"] }] }))
        .success,
    ).toBe(false);
    expect(EvmMandate.safeParse(evmMandate({ baseAsset: "0x123" })).success).toBe(false);
  });
});

describe("SolanaMandate", () => {
  it("accepts a valid mandate", () => {
    expect(SolanaMandate.safeParse(solanaMandate()).success).toBe(true);
  });

  it("rejects EVM addresses", () => {
    expect(SolanaMandate.safeParse(solanaMandate({ programs: [ROUTER] })).success).toBe(false);
  });

  it("is accepted by the Mandate union", () => {
    expect(Mandate.safeParse(solanaMandate()).success).toBe(true);
    expect(Mandate.safeParse(evmMandate()).success).toBe(true);
  });
});

describe("mandateHash", () => {
  it("is stable across address casing and key order", () => {
    const a = evmMandate();
    const b = { ...evmMandate({ baseAsset: USDG.toLowerCase() }) };
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as typeof b;
    expect(mandateHash(a)).toBe(mandateHash(reordered));
  });

  it("changes when a limit changes", () => {
    const changed = evmMandate({
      limits: { maxTxNotionalUsd: 5_001, maxDailyNotionalUsd: 25_000, maxDrawdownBps: 1_500 },
    });
    expect(mandateHash(evmMandate())).not.toBe(mandateHash(changed));
  });
});

describe("toEvmMandateParams", () => {
  it("converts limits to 6-decimal USD and modes to codes", () => {
    const params = toEvmMandateParams(evmMandate({ mode: "enforce" }));
    expect(params.mode).toBe(1);
    expect(params.maxTxNotionalUsd6).toBe(5_000_000_000n);
    expect(params.maxDailyNotionalUsd6).toBe(25_000_000_000n);
    expect(params.targets).toEqual([ROUTER]);
    expect(params.selectors).toEqual([[EXACT_INPUT_SINGLE]]);
    expect(params.mandateHash).toBe(mandateHash(evmMandate({ mode: "enforce" })));
  });

  it("uses an empty selector list for targets without selectors", () => {
    const params = toEvmMandateParams(evmMandate({ targets: [{ address: ROUTER }] }));
    expect(params.selectors).toEqual([[]]);
  });
});

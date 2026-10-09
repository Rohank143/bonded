import {
  SENTINEL_CHECK_MAX_AGE_SECONDS,
  SENTINEL_INPUT_CHARS,
  sentinelCheckDigest,
  sentinelCheckMessage,
} from "@bondedhq/shared";
import { type Hex, recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { BondedError, checkWithSentinel, SentinelError } from "../src/index.js";

const account = privateKeyToAccount(generatePrivateKey());
const VAULT = "0x00000000000000000000000000000000000000AA";
const verdict = {
  blocked: false,
  manipulated: 0.04,
  injection: 0.1,
  blockThreshold: 0.7,
  model: "laya-sentinel-v5",
  latencyMs: 812,
  advice: "No sign of manipulation.",
};

/** A stand-in for `POST /sentinel/check` that checks the request the way the API does. */
function fakeApi(answer: (body: Record<string, unknown>) => Response) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    seen.push({ url, body });
    return answer(body);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const request = {
  apiUrl: "https://api.example/",
  chainId: 46630,
  agentId: 12n,
  vault: VAULT,
  mandate: "You manage a vault holding tUSDG, tTSLA.",
  proposedAction: { tool: "transfer", args: { token: "tUSDG", to: VAULT, amount: "10" } },
  untrustedInputs: [{ tool: "read_inbox", output: "x".repeat(SENTINEL_INPUT_CHARS + 50) }],
  account,
} as const;

describe("checkWithSentinel", () => {
  it("signs exactly the message the API rebuilds, with the agent key", async () => {
    const api = fakeApi(() => Response.json(verdict));
    expect(
      await checkWithSentinel({ ...request, fetch: api.fetch, timestamp: 1_800_000_000 }),
    ).toEqual(verdict);

    const [{ url, body }] = api.seen as [{ url: string; body: Record<string, unknown> }];
    expect(url).toBe("https://api.example/sentinel/check");
    // The API's strict schema: exactly these fields.
    expect(Object.keys(body).sort()).toEqual(
      [
        "agentId",
        "mandate",
        "proposedAction",
        "signature",
        "timestamp",
        "untrustedInputs",
        "vault",
      ].sort(),
    );
    expect(body.agentId).toBe("12");
    // Inputs are cut to what Sentinel reads, as the API requires.
    const inputs = body.untrustedInputs as { tool: string; output: string }[];
    expect(inputs[0]!.output).toHaveLength(SENTINEL_INPUT_CHARS);

    const message = sentinelCheckMessage({
      chainId: 46630,
      agentId: "12",
      vault: VAULT,
      digest: sentinelCheckDigest({
        mandate: request.mandate,
        proposedAction: request.proposedAction,
        untrustedInputs: inputs,
      }),
      timestamp: 1_800_000_000,
    });
    expect(await recoverMessageAddress({ message, signature: body.signature as Hex })).toBe(
      account.address,
    );
  });

  it("signs with the current time by default, inside the API's window", async () => {
    const api = fakeApi(() => Response.json(verdict));
    await checkWithSentinel({ ...request, fetch: api.fetch });
    const age = Math.floor(Date.now() / 1000) - (api.seen[0]!.body.timestamp as number);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(SENTINEL_CHECK_MAX_AGE_SECONDS);
  });

  it("reports the API's refusal with its status and reason", async () => {
    const api = fakeApi(() =>
      Response.json({ error: "Sentinel isn't running on this API" }, { status: 503 }),
    );
    const error = await checkWithSentinel({ ...request, fetch: api.fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(SentinelError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toMatch(/503.*isn't running/);
  });

  it("reports an unreachable API and an answer it doesn't understand", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(checkWithSentinel({ ...request, fetch: down })).rejects.toMatchObject({
      name: "SentinelError",
      status: undefined,
    });
    const odd = fakeApi(() => Response.json({ ok: true }));
    await expect(checkWithSentinel({ ...request, fetch: odd.fetch })).rejects.toThrow(
      /unexpected answer/,
    );
  });

  it("refuses requests the API would reject, without sending them", async () => {
    const api = fakeApi(() => Response.json(verdict));
    const tooMany = Array.from({ length: 21 }, () => ({ tool: "news", output: "" }));
    await expect(
      checkWithSentinel({ ...request, untrustedInputs: tooMany, fetch: api.fetch }),
    ).rejects.toBeInstanceOf(BondedError);
    await expect(checkWithSentinel({ ...request, mandate: "", fetch: api.fetch })).rejects.toThrow(
      /mandate/,
    );
    expect(api.seen).toHaveLength(0);
  });
});

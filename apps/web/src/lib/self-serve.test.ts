import { afterEach, describe, expect, it, vi } from "vitest";
import { mandateHash, selfServeMessage } from "@bonded/shared";
import { api } from "./api";
import { buildMandate } from "./onboarding";
import { createRunnerToken, registerForRatings, revokeRunnerToken } from "./self-serve";
import { deployment } from "../config";

const mandate = buildMandate(deployment, 12n, {
  mode: "monitor",
  tokens: ["tTSLA"],
  destinations: ["0xd42FA5ae8949710479954ae78D1b12Ff2e50A841"],
  maxTxUsd: 5000,
  maxDailyUsd: 25000,
  maxDrawdownPct: 15,
  maxSlippagePct: 3,
  description: "Own agent",
});
const vault = "0x0000000000000000000000000000000000000abc";
const signer = () => {
  const messages: string[] = [];
  const sign = vi.fn(async ({ message }: { message: string }) => {
    messages.push(message);
    return "0x5151" as const;
  });
  return { sign, messages };
};
afterEach(() => vi.restoreAllMocks());

describe("registerForRatings, for your own agent", () => {
  it("signs the declared code hash, mode and TEE, and sends exactly that", async () => {
    const register = vi.spyOn(api, "registerSelfAgent").mockResolvedValue({ registered: true });
    const { sign, messages } = signer();
    const remote = {
      codeHash: `0x${"c".repeat(64)}`,
      mode: "chain" as const,
      tee: { url: "https://tee.example", composeHash: `0x${"d".repeat(64)}` },
    };
    await registerForRatings(sign, "12", { vault, kind: "remote", mandate, remote });
    const sent = register.mock.calls[0]![0];
    expect(sent).toMatchObject({ agentId: "12", kind: "remote", ...remote, signature: "0x5151" });
    expect(sent).not.toHaveProperty("sentinel");
    expect(messages[0]).toBe(
      selfServeMessage({
        action: "register",
        chainId: deployment.chainId,
        agentId: "12",
        vault,
        kind: "remote",
        mandateHash: mandateHash(mandate),
        remote,
        timestamp: sent.timestamp,
      }),
    );
  });

  it("refuses to register your own agent without what it declares", async () => {
    const { sign } = signer();
    await expect(
      registerForRatings(sign, "12", { vault, kind: "remote", mandate }),
    ).rejects.toThrow(/code hash and mode/);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("runner tokens", () => {
  it("are created and revoked with their own signed actions", async () => {
    const create = vi
      .spyOn(api, "createRunnerToken")
      .mockResolvedValue({ token: "bonded_rt_x", tokenId: "t", createdAt: "", gatewayUrl: null });
    const revoke = vi.spyOn(api, "revokeRunnerToken").mockResolvedValue({ revoked: 1 });
    const { sign, messages } = signer();
    expect((await createRunnerToken(sign, "12")).token).toBe("bonded_rt_x");
    await revokeRunnerToken(sign, "12");
    expect(messages[0]).toMatch(/^Bonded: create runner token\nchain \d+\nagent 12\ntime \d+$/);
    expect(messages[1]).toMatch(/^Bonded: revoke runner token\n/);
    expect(create.mock.calls[0]![0]).toBe("12");
    expect(revoke.mock.calls[0]![1]).toMatchObject({ signature: "0x5151" });
  });
});

describe("registerForRatings, for a module on a smart account", () => {
  it("signs and sends the protection with the module's address", async () => {
    const register = vi.spyOn(api, "registerSelfAgent").mockResolvedValue({ registered: true });
    const { sign, messages } = signer();
    await registerForRatings(sign, "12", {
      vault,
      kind: "hardened",
      mandate,
      protection: "module",
    });
    expect(register.mock.calls[0]![0]).toMatchObject({ vault, protection: "module" });
    expect(messages[0]).toContain("\nprotection module\n");
  });
});

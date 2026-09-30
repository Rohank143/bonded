import type { Policy, Vault } from "@bonded/solana";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect, it } from "vitest";
import { parseSolanaKey, type SolanaClaimChain, SolanaKeeper } from "../src/solana.js";

const key = (seed: number) => new PublicKey(Buffer.alloc(32, seed));
const vault = (seed: number, breaches: Partial<Vault["breaches"][number]>[]): Vault => ({
  address: key(seed),
  guardian: key(1),
  agent: key(2),
  agentId: BigInt(seed),
  baseMint: key(3),
  frozen: true,
  breaches: breaches.map((b, id) => ({
    id,
    type: "UnauthorizedTransfer",
    blocked: false,
    claimed: false,
    target: key(6),
    timestamp: 150,
    loss: 100n,
    ...b,
  })),
});
const policy = (vaultSeed: number, policyId: bigint): Policy => ({
  address: key(50 + vaultSeed),
  policyId,
  agentId: BigInt(vaultSeed),
  vault: key(vaultSeed),
  coverAmount: 1000n,
  remainingCover: 1000n,
  startedAt: 100,
  endsAt: 200,
  active: true,
});

function fakeChain(failFor?: bigint) {
  const sent: string[] = [];
  const chain: SolanaClaimChain = {
    now: async () => 210,
    state: async () => ({
      vaults: [
        vault(10, [{}, { claimed: true }]),
        vault(11, [{ loss: 0n }]),
        vault(12, [{ loss: 5n }]),
      ],
      policies: [policy(10, 1n), policy(11, 2n), policy(12, 3n)],
      config: { baseMint: key(3), claimWindow: 30, nextPolicyId: 4n },
    }),
    async send(ix) {
      // The policy is the second account of file_claim.
      const policyAddress = ix.keys[1]!.pubkey;
      if (failFor !== undefined && policyAddress.equals(key(50 + Number(failFor))))
        throw new Error("simulation failed");
      sent.push(policyAddress.toBase58());
      return `sig-${sent.length}`;
    },
  };
  return { chain, sent };
}

it("files one claim per covered vault with claimable breaches and publishes each", async () => {
  const events: { topic: string; payload: Record<string, unknown> }[] = [];
  const { chain, sent } = fakeChain();
  const result = await new SolanaKeeper(
    {
      publish: async (topic, payload) =>
        void events.push({ topic, payload: payload as Record<string, unknown> }),
    },
    chain,
  ).tick();
  // Vault 11's only breach lost nothing, so there's nothing to claim there.
  expect(result).toEqual({ filed: 2, failed: 0 });
  expect(sent).toEqual([key(60).toBase58(), key(62).toBase58()]);
  expect(events.map((e) => e.topic)).toEqual(["solana.claim.paid", "solana.claim.paid"]);
  expect(events[0]!.payload).toMatchObject({
    policyId: "1",
    breachIds: [0],
    loss: "100",
    signature: "sig-1",
  });
});

it("keeps going when one claim fails, and publishes the failure", async () => {
  const events: string[] = [];
  const { chain } = fakeChain(10n);
  const result = await new SolanaKeeper(
    { publish: async (topic) => void events.push(topic) },
    chain,
  ).tick();
  expect(result).toEqual({ filed: 1, failed: 1 });
  expect(events).toEqual(["solana.claim.failed", "solana.claim.paid"]);
});

it("reads the key solana-keygen writes and rejects anything else", () => {
  const k = Keypair.generate();
  expect(parseSolanaKey(JSON.stringify([...k.secretKey])).publicKey.equals(k.publicKey)).toBe(true);
  expect(() => parseSolanaKey("[1,2,3]")).toThrow(/64-number/);
  expect(() => parseSolanaKey(`"${k.publicKey.toBase58()}"`)).toThrow(/64-number/);
});

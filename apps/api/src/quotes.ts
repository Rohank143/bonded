import {
  Attestation,
  buildQuote,
  signQuote,
  quoteMessage,
  QuoteError,
  MODEL_FAMILY_CODE,
  bondedRegistryAbi,
  coverManagerAbi,
  coverPoolAbi,
  operatorBondAbi,
  mandateVaultAbi,
  tierForScore,
  type SignedQuote,
} from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import type { Address, Hex } from "viem";

/** Read all underwriting inputs at one block; buyCover remains the authority at binding. */
export async function issueQuote(
  chain: ServiceChain,
  input: { agentId: string; vault: Address; coverAmount: string },
  key: Hex,
  /** Called with what the quote depends on; returns a reason to refuse it, or undefined. */
  guard?: (info: { teeMeasurement: string; vaultAgent: string }) => string | undefined,
): Promise<SignedQuote> {
  const { read, deployment: d } = chain;
  const block = await read.getBlock();
  const at = { blockNumber: block.number };
  const raw = await read.readContract({
    ...at,
    address: d.registry,
    abi: bondedRegistryAbi,
    functionName: "scoreOf",
    args: [BigInt(input.agentId)],
  });
  const family = Object.entries(MODEL_FAMILY_CODE).find(
    ([, code]) => code === raw.modelFamily,
  )?.[0];
  const attestation = Attestation.parse({
    ...raw,
    agentId: raw.agentId.toString(),
    modelFamily: family,
    issuedAt: Number(raw.issuedAt),
    expiresAt: Number(raw.expiresAt),
  });
  const [
    bond,
    existing,
    assets,
    total,
    leverage,
    agentCap,
    familyCap,
    familyCover,
    guardian,
    vaultAgent,
  ] = await Promise.all([
    read.readContract({
      ...at,
      address: d.bond,
      abi: operatorBondAbi,
      functionName: "bondOf",
      args: [BigInt(input.agentId)],
    }),
    read.readContract({
      ...at,
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "activeCoverOfAgent",
      args: [BigInt(input.agentId)],
    }),
    read.readContract({ ...at, address: d.pool, abi: coverPoolAbi, functionName: "totalAssets" }),
    read.readContract({
      ...at,
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "totalActiveCover",
    }),
    read.readContract({
      ...at,
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "maxLeverageBps",
    }),
    read.readContract({
      ...at,
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "maxAgentCoverBps",
    }),
    read.readContract({
      ...at,
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "modelFamilyCapBps",
    }),
    read.readContract({
      ...at,
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "activeCoverOfFamily",
      args: [raw.modelFamily],
    }),
    read.readContract({
      ...at,
      address: input.vault,
      abi: mandateVaultAbi,
      functionName: "guardian",
    }),
    read.readContract({
      ...at,
      address: input.vault,
      abi: mandateVaultAbi,
      functionName: "agent",
    }),
  ]);
  const refusal = guard?.({ teeMeasurement: attestation.teeMeasurement, vaultAgent });
  if (refusal) throw new QuoteError(refusal);
  const amount = BigInt(input.coverAmount);
  const cap = Math.min(agentCap, tierForScore(attestation.score).maxCoverBpsOfPool);
  if (total + amount > (assets * BigInt(leverage)) / 10000n)
    throw new QuoteError("pool capacity exceeded");
  if (existing + amount > (assets * BigInt(cap)) / 10000n)
    throw new QuoteError("agent capacity exceeded");
  if (familyCover + amount > (assets * BigInt(familyCap)) / 10000n)
    throw new QuoteError("model family capacity exceeded");
  const { quote } = buildQuote({
    attestation,
    vault: input.vault,
    coverAmount: amount,
    bond,
    existingCover: existing,
    now: Number(block.timestamp),
  });
  const signed = await signQuote(quote, {
    chainId: d.chainId,
    coverManager: d.coverManager,
    attesterKey: key,
  });
  await read.simulateContract({
    ...at,
    address: d.coverManager,
    abi: coverManagerAbi,
    functionName: "buyCover",
    args: [quoteMessage(quote), signed.signature],
    account: guardian,
  });
  return signed;
}

import {
  Attestation,
  buildQuote,
  signQuote,
  quoteMessage,
  QuoteError,
  MODEL_FAMILY_CODE,
  bindingOf,
  bondedRegistryAbi,
  underwritingCapRefusal,
  coverManagerAbi,
  coverPoolAbi,
  mandateModuleAbi,
  mandateModuleFactoryAbi,
  operatorBondAbi,
  mandateVaultAbi,
  tierForScore,
  type BindingLevel,
  type SignedQuote,
} from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import type { Address, Hex } from "viem";

/** BondedTypes.MandateMode.Enforce. */
const MANDATE_MODE_ENFORCE = 1;

/** Read all underwriting inputs at one block; buyCover remains the authority at binding. */
export async function issueQuote(
  chain: ServiceChain,
  input: { agentId: string; vault: Address; coverAmount: string },
  key: Hex,
  /** Called with what the quote depends on; returns a reason to refuse it, or undefined. */
  guard?: (info: {
    teeMeasurement: string;
    reportHash: string;
    vaultAgent: string;
  }) => string | undefined,
  /**
   * Underwriting policy for the score the quote is priced from, decided from that score (the
   * rating that posted it, found by its report hash): a reason to refuse, or whether cover is
   * capped by the score's binding (an agent its operator runs, bring your own agent).
   */
  underwriting?: (score: {
    reportHash: string;
    teeMeasurement: string;
  }) => Promise<
    { refused: string } | { capByBinding: boolean; caps?: Readonly<Record<BindingLevel, number>> }
  >,
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
  // A module on a smart account can hold cover only in Enforce mode (CoverManager's
  // ModuleMustEnforce): in Monitor mode a breach goes through and the payout goes to the account,
  // whose owner could have asked for it. Said here, so a user doesn't meet the revert.
  if (d.moduleFactory) {
    const isModule = await read.readContract({
      ...at,
      address: d.moduleFactory,
      abi: mandateModuleFactoryAbi,
      functionName: "isModule",
      args: [input.vault],
    });
    if (isModule) {
      const mode = await read.readContract({
        ...at,
        address: input.vault,
        abi: mandateModuleAbi,
        functionName: "mode",
      });
      if (mode !== MANDATE_MODE_ENFORCE)
        throw new QuoteError(
          "a smart-account module can hold cover only in Enforce mode: in Monitor mode a breach goes through and would be paid to the account's own owner",
        );
    }
  }
  const refusal = guard?.({
    teeMeasurement: attestation.teeMeasurement,
    reportHash: attestation.reportHash,
    vaultAgent,
  });
  if (refusal) throw new QuoteError(refusal);
  const policy = await underwriting?.({
    reportHash: attestation.reportHash,
    teeMeasurement: attestation.teeMeasurement,
  });
  if (policy && "refused" in policy) throw new QuoteError(policy.refused);
  const amount = BigInt(input.coverAmount);
  // Policy first, so its reason is the one given: the binding cap is not about the pool's room.
  const binding = policy?.capByBinding ? bindingOf(attestation.teeMeasurement) : undefined;
  const capped =
    binding &&
    underwritingCapRefusal({
      binding,
      coverAmount: amount,
      existingCover: existing,
      ...(policy?.caps ? { caps: policy.caps } : {}),
    });
  if (capped) throw new QuoteError(capped);
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
    ...(binding ? { binding, ...(policy?.caps ? { coverCaps: policy.caps } : {}) } : {}),
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

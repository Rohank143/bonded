import {
  type Attestation,
  attestationMessage,
  attestationTypedData,
  bondedDomain,
  bondedRegistryAbi,
  type ModelFamily,
} from "@bonded/shared";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, type Sandbox } from "./sandbox.js";
import { send } from "./vault.js";

/**
 * The attestation a rating produces (docs/PLAN.md Sections 6.4 and 8.6): the score and expected
 * loss, signed with EIP-712 by the Arena's attester for a chain's BondedRegistry.
 */
export interface SignedAttestation {
  attestation: Attestation;
  signature: `0x${string}`;
  signer: `0x${string}`;
  chainId: number;
  registry: `0x${string}`;
}

/** Scores stay valid for 30 days, then the agent must be re-rated. */
export const ATTESTATION_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function signAttestation(
  attestation: Attestation,
  options: { chainId: number; registry: `0x${string}`; attesterKey: `0x${string}` },
): Promise<SignedAttestation> {
  const account = privateKeyToAccount(options.attesterKey);
  const typed = attestationTypedData(bondedDomain(options.chainId, options.registry), attestation);
  const signature = await account.signTypedData(typed);
  return {
    attestation,
    signature,
    signer: account.address,
    chainId: options.chainId,
    registry: options.registry,
  };
}

/** Checks a signed attestation's signature offline. */
export function verifyAttestation(signed: SignedAttestation): Promise<boolean> {
  return verifyTypedData({
    address: signed.signer,
    signature: signed.signature,
    ...attestationTypedData(bondedDomain(signed.chainId, signed.registry), signed.attestation),
  });
}

/**
 * Posts a signed attestation to the sandbox's registry and confirms the registry accepted it.
 * Returns why it was skipped when the signer isn't an attester on this chain (e.g. on a fork,
 * where the attester is the real deployer's key, not the sandbox's).
 */
export async function postAttestation(
  sandbox: Sandbox,
  signed: SignedAttestation,
): Promise<{ posted: true; hash: `0x${string}` } | { posted: false; reason: string }> {
  const read = sandbox.publicClient;
  const registry = sandbox.deployment.registry;
  const isAttester = await read.readContract({
    address: registry,
    abi: bondedRegistryAbi,
    functionName: "isAttester",
    args: [signed.signer],
  });
  if (!isAttester) {
    return {
      posted: false,
      reason: `${signed.signer} is not an attester on chain ${sandbox.chain.id}`,
    };
  }
  const { hash } = await send(sandbox, "operator", {
    address: registry,
    abi: bondedRegistryAbi,
    functionName: "postScore",
    args: [attestationMessage(signed.attestation), signed.signature],
  });
  const valid = await read.readContract({
    address: registry,
    abi: bondedRegistryAbi,
    functionName: "hasValidScore",
    args: [BigInt(signed.attestation.agentId)],
  });
  if (!valid) throw new Error("the registry accepted the score but reports it as invalid");
  return { posted: true, hash };
}

/** The sandbox's attester key: the deployer, which deploy.sh registers as attester. */
export const SANDBOX_ATTESTER_KEY = ANVIL_KEYS.deployer;

/** Model family from an agent name like "hardened-agent/deepseek/deepseek-v4.1-flash". */
export function modelFamilyOf(agentName: string): ModelFamily {
  const name = agentName.toLowerCase();
  if (name.startsWith("decision-agent/")) return "decision-model";
  const model = name.split("/").slice(1).join("/");
  if (!model || model === "scripted") return "unknown";
  const rules: [RegExp, ModelFamily][] = [
    [/claude|anthropic/, "anthropic-claude"],
    [/gpt|openai|\bo\d/, "openai-gpt"],
    [/gemini|google/, "google-gemini"],
    [/llama|meta-/, "meta-llama"],
    [/mistral|mixtral/, "mistral"],
    [/deepseek/, "deepseek"],
    [/qwen/, "qwen"],
    [/grok|x-ai/, "xai-grok"],
  ];
  return rules.find(([pattern]) => pattern.test(model))?.[1] ?? "other";
}

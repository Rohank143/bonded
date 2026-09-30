import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fetchAgent,
  fetchRegistryConfig,
  postScoreInstructions,
  registerInstruction,
  type SolanaAttestation,
} from "@bonded/solana";
import {
  type Attestation,
  attestationMessage,
  bondedRegistryAbi,
  EVM_CHAINS,
  type EvmChainKey,
  MODEL_FAMILY_CODE,
  type ModelFamily,
  parseEvmDeployment,
} from "@bonded/shared";
import { Connection, type Keypair, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signAttestation } from "./attestation.js";

/**
 * Multi-chain scores (docs/PLAN.md Section 20, Day 11: "a score is readable on 4 chains"). An
 * agent is rated once, on its home chain; the same attested score is then posted to every
 * other chain's registry under that chain's agent id. Each registry checks the attester's
 * signature over its own domain (EIP-712 with its chain id and address on EVM; Ed25519 over
 * the program id on Solana), so the score is re-signed per chain, never copied. The agent ids
 * per chain are public configuration, kept in config/agent-links.json.
 */

export type ScoreChain = EvmChainKey | "solanaDevnet";

export interface AgentLink {
  home: { chain: EvmChainKey; agentId: string };
  /** The agent's id on each other chain, once registered there. */
  links: Partial<Record<ScoreChain, string>>;
}

export const AGENT_LINKS_FILE = fileURLToPath(
  new URL("../../../config/agent-links.json", import.meta.url),
);
const DEPLOYMENTS = fileURLToPath(new URL("../../../contracts/evm/deployments/", import.meta.url));

export function readLinks(path = AGENT_LINKS_FILE): AgentLink[] {
  return JSON.parse(readFileSync(path, "utf8")) as AgentLink[];
}

export function writeLinks(links: AgentLink[], path = AGENT_LINKS_FILE): void {
  writeFileSync(path, `${JSON.stringify(links, null, 2)}\n`);
}

const FAMILY_BY_CODE = Object.fromEntries(
  Object.entries(MODEL_FAMILY_CODE).map(([name, code]) => [code, name]),
) as Record<number, ModelFamily>;

function evm(chain: EvmChainKey) {
  const config = EVM_CHAINS[chain];
  const deployment = parseEvmDeployment(
    readFileSync(`${DEPLOYMENTS}${config.chainId}.json`, "utf8"),
    config.chainId,
  );
  const viemChain = defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  return {
    config,
    registry: deployment.registry,
    viemChain,
    read: createPublicClient({ chain: viemChain, transport: http(config.rpcUrl) }),
  };
}

/** The agent's current score on an EVM chain, or null if it has none. */
export async function readEvmScore(
  chain: EvmChainKey,
  agentId: string,
): Promise<Attestation | null> {
  const { read, registry } = evm(chain);
  const s = await read.readContract({
    address: registry,
    abi: bondedRegistryAbi,
    functionName: "scoreOf",
    args: [BigInt(agentId)],
  });
  if (s.issuedAt === 0n) return null;
  return {
    agentId: s.agentId.toString(),
    score: s.score,
    expectedLossBps: s.expectedLossBps,
    reportHash: s.reportHash,
    mandateHash: s.mandateHash,
    codeHash: s.codeHash,
    teeMeasurement: s.teeMeasurement,
    modelFamily: FAMILY_BY_CODE[s.modelFamily] ?? "other",
    issuedAt: Number(s.issuedAt),
    expiresAt: Number(s.expiresAt),
  };
}

export interface PostResult {
  chain: ScoreChain;
  agentId: string;
  status: "posted" | "already-current";
  registeredNow: boolean;
  tx?: string;
}

/** Post `home`'s score to an EVM chain, registering the agent there first if needed. */
export async function crosspostEvm(options: {
  chain: EvmChainKey;
  home: Attestation;
  agentId?: string;
  uri: string;
  attesterKey: `0x${string}`;
  ownerKey: `0x${string}`;
}): Promise<PostResult> {
  const { read, registry, viemChain, config } = evm(options.chain);
  const wallet = (key: `0x${string}`) =>
    createWalletClient({
      account: privateKeyToAccount(key),
      chain: viemChain,
      transport: http(config.rpcUrl),
    });
  let agentId = options.agentId;
  let registeredNow = false;
  if (!agentId) {
    const owner = wallet(options.ownerKey);
    const hash = await owner.writeContract({
      address: registry,
      abi: bondedRegistryAbi,
      functionName: "register",
      args: [options.uri],
    });
    await read.waitForTransactionReceipt({ hash });
    agentId = (
      await read.readContract({
        address: registry,
        abi: bondedRegistryAbi,
        functionName: "totalAgents",
      })
    ).toString();
    registeredNow = true;
  }
  const current = await readEvmScore(options.chain, agentId);
  if (current && current.issuedAt >= options.home.issuedAt)
    return { chain: options.chain, agentId, status: "already-current", registeredNow };
  const signed = await signAttestation(
    { ...options.home, agentId },
    { chainId: config.chainId, registry, attesterKey: options.attesterKey },
  );
  const hash = await wallet(options.attesterKey).writeContract({
    address: registry,
    abi: bondedRegistryAbi,
    functionName: "postScore",
    args: [attestationMessage(signed.attestation), signed.signature],
  });
  await read.waitForTransactionReceipt({ hash });
  const valid = await read.readContract({
    address: registry,
    abi: bondedRegistryAbi,
    functionName: "hasValidScore",
    args: [BigInt(agentId)],
  });
  if (!valid)
    throw new Error(`${options.chain}: the registry accepted the score but reports it invalid`);
  return { chain: options.chain, agentId, status: "posted", registeredNow, tx: hash };
}

const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

export function toSolanaAttestation(home: Attestation, agentId: bigint): SolanaAttestation {
  return {
    agentId,
    score: home.score,
    expectedLossBps: home.expectedLossBps,
    reportHash: hexBytes(home.reportHash),
    mandateHash: hexBytes(home.mandateHash),
    codeHash: hexBytes(home.codeHash),
    teeMeasurement: hexBytes(home.teeMeasurement),
    modelFamily: MODEL_FAMILY_CODE[home.modelFamily],
    issuedAt: home.issuedAt,
    expiresAt: home.expiresAt,
  };
}

/** Post `home`'s score to the Solana registry, registering the agent there first if needed. */
export async function crosspostSolana(options: {
  rpcUrl: string;
  home: Attestation;
  agentId?: string;
  uri: string;
  attester: Keypair;
  owner: Keypair;
}): Promise<PostResult> {
  const connection = new Connection(options.rpcUrl, "confirmed");
  const config = await fetchRegistryConfig(connection);
  if (!config.attester.equals(options.attester.publicKey))
    throw new Error(
      `solanaDevnet: ${options.attester.publicKey.toBase58()} isn't the registry's attester`,
    );
  let agentId = options.agentId ? BigInt(options.agentId) : undefined;
  let registeredNow = false;
  if (agentId === undefined) {
    agentId = config.agentCount + 1n;
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(registerInstruction(options.owner.publicKey, agentId, options.uri)),
      [options.owner],
      { commitment: "confirmed" },
    );
    registeredNow = true;
  }
  const agent = await fetchAgent(connection, agentId);
  if (!agent) throw new Error(`solanaDevnet: agent ${agentId} isn't registered`);
  if (agent.score && agent.score.issuedAt >= options.home.issuedAt)
    return {
      chain: "solanaDevnet",
      agentId: agentId.toString(),
      status: "already-current",
      registeredNow,
    };
  const tx = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ...postScoreInstructions(toSolanaAttestation(options.home, agentId), options.attester),
    ),
    [options.owner],
    { commitment: "confirmed" },
  );
  return {
    chain: "solanaDevnet",
    agentId: agentId.toString(),
    status: "posted",
    registeredNow,
    tx,
  };
}

/** The agent's score on the Solana registry, or null. */
export async function readSolanaScore(rpcUrl: string, agentId: string) {
  const agent = await fetchAgent(new Connection(rpcUrl, "confirmed"), BigInt(agentId));
  return agent?.score ?? null;
}

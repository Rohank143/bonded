import { useState } from "react";
import { Link } from "react-router";
import { useAccount, useSignMessage, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { isAddress, parseEventLogs, type Abi, type Address, type Hex } from "viem";
import {
  SELF_SERVE_KINDS,
  SELF_SERVE_KIND_LABELS,
  bondedRegistryAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  operatorBondAbi,
  testTokenAbi,
  toEvmMandateParams,
  type SelfServeKind,
} from "@bonded/shared";
import { deployment, robinhoodTestnet } from "../config";
import { wagmiConfig } from "../wagmi";
import { parseUsd } from "../lib/format";
import { MANDATE_TOKENS, buildMandate, rememberAgent, type MandateToken } from "../lib/onboarding";
import { registerForRatings } from "../lib/self-serve";
import { Button, Card, ErrorText, Input, Page, TxLink } from "../components/ui";

type Step = { label: string; state: "waiting" | "active" | "done"; hash?: Hex };

const STEPS = [
  "Register the agent",
  "Create its vault",
  "Get test tUSDG",
  "Stake the operator bond",
  "Deposit into the vault",
  "Register it for ratings (a signature, no gas)",
];

/**
 * Onboard an agent from the browser (docs/AGENTS.md, "What works today"): register it, create its
 * Mandate Vault, stake a bond, fund the vault, and register it for self-serve ratings.
 */
export function NewAgent() {
  const { address: user, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const [kind, setKind] = useState<SelfServeKind>("partial");
  const [mode, setMode] = useState<"monitor" | "enforce">("monitor");
  const [tokens, setTokens] = useState<MandateToken[]>([...MANDATE_TOKENS]);
  const [refund, setRefund] = useState("");
  const [selfAgent, setSelfAgent] = useState(true);
  const [agentKey, setAgentKey] = useState("");
  const [maxTx, setMaxTx] = useState("5000");
  const [maxDaily, setMaxDaily] = useState("25000");
  const [bond, setBond] = useState("4000");
  const [deposit, setDeposit] = useState("50000");
  const [description, setDescription] = useState("An agent onboarded from the Bonded web app.");
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ agentId: bigint; vault: Address }>();
  const [busy, setBusy] = useState(false);

  const refundAddress = refund.trim() || user || "";
  const key = selfAgent ? user : agentKey.trim();
  const bondValue = parseUsd(bond) ?? 0n;
  const depositValue = parseUsd(deposit) ?? 0n;
  const problems = [
    !isConnected && "Connect a wallet first.",
    refundAddress && !isAddress(refundAddress) && "The refund address isn't an address.",
    (!key || !isAddress(key)) && "The agent key must be an address.",
    !(Number(maxTx) > 0 && Number(maxDaily) >= Number(maxTx)) &&
      "Limits must be positive, with the daily limit at least the per-trade limit.",
    !description.trim() && "Describe the agent in a line.",
  ].filter(Boolean) as string[];

  async function send(index: number, call: Parameters<typeof writeContractAsync>[0]) {
    setSteps((s) => s.map((step, i) => (i === index ? { ...step, state: "active" } : step)));
    const hash = await writeContractAsync({ ...call, chainId: robinhoodTestnet.id } as never);
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    if (receipt.status !== "success") throw new Error(`${STEPS[index]} failed`);
    setSteps((s) => s.map((step, i) => (i === index ? { ...step, state: "done", hash } : step)));
    return receipt;
  }
  const mark = (index: number, state: Step["state"]) =>
    setSteps((s) => s.map((step, i) => (i === index ? { ...step, state } : step)));

  async function onboard() {
    if (!user || !key) return;
    setBusy(true);
    setError(null);
    setSteps(STEPS.map((label) => ({ label, state: "waiting" })));
    try {
      const registered = await send(0, {
        address: deployment.registry,
        abi: bondedRegistryAbi as Abi,
        functionName: "register",
        args: ["ipfs://bonded/self-serve"],
      });
      const agentId = (
        parseEventLogs({
          abi: bondedRegistryAbi,
          logs: registered.logs,
          eventName: "Registered",
        })[0]?.args as { agentId: bigint }
      ).agentId;
      const mandate = buildMandate(deployment, agentId, {
        mode,
        tokens,
        destinations: refundAddress ? [refundAddress] : [],
        maxTxUsd: Number(maxTx),
        maxDailyUsd: Number(maxDaily),
        maxDrawdownPct: 15,
        maxSlippagePct: 3,
        description: description.trim(),
      });
      const made = await send(1, {
        address: deployment.factory,
        abi: mandateVaultFactoryAbi as Abi,
        functionName: "createVault",
        args: [toEvmMandateParams(mandate), key, user, agentId, `Agent ${agentId} vault`, "BVLT"],
      });
      const vault = (
        parseEventLogs({
          abi: mandateVaultFactoryAbi,
          logs: made.logs,
          eventName: "VaultCreated",
        })[0]?.args as { vault: Address }
      ).vault;
      // Remembered at once, so registration for ratings can be retried from the agent's page.
      rememberAgent(deployment.chainId, agentId.toString(), { vault, kind, mandate });
      setCreated({ agentId, vault });
      const needed = bondValue + depositValue;
      if (needed > 0n)
        await send(2, {
          address: deployment.usdg,
          abi: testTokenAbi as Abi,
          functionName: "faucet",
          args: [needed],
        });
      else mark(2, "done");
      if (bondValue > 0n) {
        await send(3, {
          address: deployment.usdg,
          abi: testTokenAbi as Abi,
          functionName: "approve",
          args: [deployment.bond, bondValue],
        });
        await send(3, {
          address: deployment.bond,
          abi: operatorBondAbi as Abi,
          functionName: "stake",
          args: [agentId, bondValue],
        });
      } else mark(3, "done");
      if (depositValue > 0n) {
        await send(4, {
          address: deployment.usdg,
          abi: testTokenAbi as Abi,
          functionName: "approve",
          args: [vault, depositValue],
        });
        await send(4, {
          address: vault,
          abi: mandateVaultAbi as Abi,
          functionName: "deposit",
          args: [depositValue, user],
        });
      } else mark(4, "done");
      mark(5, "active");
      await registerForRatings(signMessageAsync, agentId.toString(), { vault, kind, mandate });
      mark(5, "done");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (t: MandateToken) =>
    setTokens((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));

  return (
    <Page
      title="Onboard an agent"
      intro="Register an agent, create its Mandate Vault, stake its operator bond and fund it, all from your wallet. Then rate it in the Arena and buy cover for it from its page."
    >
      <Card title="What gets rated">
        <p className="mb-3 text-sm text-muted">
          The Arena rates one of Bonded's built-in agent designs, run against your vault and
          mandate. Rating your own agent's code is coming (
          <a
            className="text-accent hover:underline"
            href="https://github.com/ddboy19912/bonded/issues/84"
            target="_blank"
            rel="noreferrer"
          >
            issue #84
          </a>
          ).
        </p>
        <div className="flex flex-col gap-2 text-sm">
          {SELF_SERVE_KINDS.map((k) => (
            <label key={k} className="flex items-start gap-2">
              <input type="radio" checked={kind === k} onChange={() => setKind(k)} />
              <span>{SELF_SERVE_KIND_LABELS[k]}</span>
            </label>
          ))}
        </div>
      </Card>

      <Card title="Mandate">
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-muted">Vault mode</span>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={mode === "monitor"}
                onChange={() => setMode("monitor")}
              />
              Monitor: breaches go through and are recorded, so they can be claimed
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={mode === "enforce"}
                onChange={() => setMode("enforce")}
              />
              Enforce: breaches are blocked (and recorded); scores higher, but there's nothing to
              claim
            </label>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted">Tokens it may hold (tUSDG always)</span>
            <div className="flex flex-wrap gap-4">
              {MANDATE_TOKENS.map((t) => (
                <label key={t} className="flex items-center gap-2">
                  <input type="checkbox" checked={tokens.includes(t)} onChange={() => toggle(t)} />
                  {t}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Per-trade limit (USD)" value={maxTx} onChange={setMaxTx} />
            <Input label="Daily limit (USD)" value={maxDaily} onChange={setMaxDaily} />
          </div>
          <Input
            label="Refund address the agent may send funds to (default: your wallet)"
            value={refund}
            onChange={setRefund}
            placeholder={user ?? "0x…"}
          />
          <Input
            label="Description (part of the mandate)"
            value={description}
            onChange={setDescription}
          />
        </div>
      </Card>

      <Card title="Agent key, bond and deposit">
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-muted">
              The agent's key, the only key that can act for the vault
            </span>
            <label className="flex items-center gap-2">
              <input type="radio" checked={selfAgent} onChange={() => setSelfAgent(true)} />
              My wallet (for testing: lets you simulate a breach from the vault page)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={!selfAgent} onChange={() => setSelfAgent(false)} />
              Another address (your agent's own key)
            </label>
            {!selfAgent && (
              <Input label="Agent key address" value={agentKey} onChange={setAgentKey} />
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Operator bond (tUSDG)" value={bond} onChange={setBond} />
            <Input label="Deposit (tUSDG)" value={deposit} onChange={setDeposit} />
          </div>
          <p className="text-xs text-muted">
            Cover needs a bond of 10% to 30% of the cover, depending on the score's tier: 4,000
            covers 20,000 for tier BB. Test tUSDG is minted from the faucet as part of these steps;
            you need a little test ETH for gas.
          </p>
        </div>
      </Card>

      <Card title="Create">
        {problems.length > 0 && (
          <ul className="mb-3 list-disc pl-5 text-sm text-muted">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <Button disabled={busy || problems.length > 0} onClick={onboard}>
          {busy ? "Working…" : "Onboard the agent"}
        </Button>
        <p className="mt-2 text-xs text-muted">
          About eight wallet confirmations, then one signature.
        </p>
        {steps.length > 0 && (
          <ol className="mt-4 flex flex-col gap-1 text-sm">
            {steps.map((s) => (
              <li key={s.label} className="flex flex-wrap items-center gap-2">
                <span className="w-5">
                  {s.state === "done" ? "✓" : s.state === "active" ? "…" : "·"}
                </span>
                <span className={s.state === "waiting" ? "text-muted" : ""}>{s.label}</span>
                {s.hash && <TxLink hash={s.hash} />}
              </li>
            ))}
          </ol>
        )}
        <ErrorText error={error} />
        {created && (
          <p className="mt-3 text-sm">
            Agent {created.agentId.toString()}:{" "}
            <Link className="text-accent hover:underline" to={`/agents/${created.agentId}`}>
              rate it
            </Link>{" "}
            ·{" "}
            <Link className="text-accent hover:underline" to={`/vaults/${created.vault}`}>
              its vault (deposits, cover{selfAgent ? ", simulate a breach" : ""})
            </Link>
          </p>
        )}
      </Card>
    </Page>
  );
}

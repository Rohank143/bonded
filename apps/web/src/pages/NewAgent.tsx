import { useState, type ReactNode } from "react";
import { Token, TokenLogo } from "../components/token";
import { Link } from "react-router";
import { useAccount, useSignMessage, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { parseEventLogs, type Abi, type Address, type Hex } from "viem";
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
import {
  MANDATE_TOKENS,
  ONBOARDING_STEPS,
  buildMandate,
  loadProgress,
  nextStep,
  parseAmount,
  rememberAgent,
  saveProgress,
  validateOnboarding,
  type MandateForm,
  type MandateToken,
  type OnboardingProgress,
  type OnboardingStep,
} from "../lib/onboarding";
import {
  addressError,
  amountOrZeroError,
  dailyLimitError,
  descriptionError,
  limitError,
} from "../lib/validate";
import { registerForRatings } from "../lib/self-serve";
import {
  Button,
  Card,
  Choice,
  ErrorText,
  Input,
  Page,
  Term,
  TxLink,
  linkClass,
} from "../components/ui";

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
  const [sentinel, setSentinel] = useState(false);
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
  const key = (selfAgent ? user : agentKey.trim()) ?? "";
  const form: MandateForm = {
    mode,
    tokens,
    destinations: refundAddress ? [refundAddress] : [],
    maxTxUsd: Number(maxTx),
    maxDailyUsd: Number(maxDaily),
    maxDrawdownPct: 15,
    maxSlippagePct: 3,
    description: description.trim(),
  };
  // Everything is checked before the first transaction, so a bad field can't leave a half-made
  // agent behind or silently skip a funding step.
  const problems = validateOnboarding(deployment, {
    connected: isConnected,
    form,
    agentKey: key,
    bond,
    deposit,
  });
  const saved = user ? loadProgress(deployment.chainId, user) : undefined;
  const unfinished = saved && nextStep(saved) ? saved : undefined;

  const showSteps = (done: OnboardingStep[], hashes: Partial<Record<OnboardingStep, Hex>> = {}) =>
    setSteps(
      ONBOARDING_STEPS.map((step, i) => ({
        label: STEPS[i]!,
        state: done.includes(step) ? "done" : "waiting",
        ...(hashes[step] ? { hash: hashes[step] } : {}),
      })),
    );
  const mark = (step: OnboardingStep, state: Step["state"], hash?: Hex) =>
    setSteps((s) =>
      s.map((row, i) =>
        ONBOARDING_STEPS[i] === step ? { ...row, state, ...(hash ? { hash } : {}) } : row,
      ),
    );
  async function send(step: OnboardingStep, call: Parameters<typeof writeContractAsync>[0]) {
    mark(step, "active");
    const hash = await writeContractAsync({ ...call, chainId: robinhoodTestnet.id } as never);
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    if (receipt.status !== "success")
      throw new Error(`${STEPS[ONBOARDING_STEPS.indexOf(step)]} failed`);
    mark(step, "active", hash);
    return receipt;
  }

  /**
   * Runs every step not yet done for `progress`, saving it after each one, so a rejected prompt
   * or a reload resumes here instead of registering another agent.
   */
  async function run(progress: OnboardingProgress) {
    if (!user) return;
    setBusy(true);
    setError(null);
    showSteps(progress.done);
    const save = (p: OnboardingProgress) => saveProgress(deployment.chainId, user, p);
    const finish = (step: OnboardingStep) => {
      progress = { ...progress, done: [...progress.done, step] };
      save(progress);
      mark(step, "done");
    };
    const bondValue = parseAmount(progress.bond)!;
    const depositValue = parseAmount(progress.deposit)!;
    try {
      if (!progress.done.includes("register")) {
        const registered = await send("register", {
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
        // The mandate is frozen here, with the agent id, and reused by every later step.
        const mandate = buildMandate(deployment, agentId, progress.form);
        progress = { ...progress, agentId: agentId.toString(), mandate };
        finish("register");
      }
      const agentId = BigInt(progress.agentId!);
      const mandate = progress.mandate!;
      if (!progress.done.includes("vault")) {
        const made = await send("vault", {
          address: deployment.factory,
          abi: mandateVaultFactoryAbi as Abi,
          functionName: "createVault",
          args: [
            toEvmMandateParams(mandate),
            progress.agentKey,
            user,
            agentId,
            `Agent ${agentId} vault`,
            "BVLT",
          ],
        });
        const vault = (
          parseEventLogs({
            abi: mandateVaultFactoryAbi,
            logs: made.logs,
            eventName: "VaultCreated",
          })[0]?.args as { vault: Address }
        ).vault;
        progress = { ...progress, vault };
        rememberAgent(deployment.chainId, agentId.toString(), {
          vault,
          kind: progress.kind,
          mandate,
          ...(progress.sentinel ? { sentinel: true } : {}),
        });
        finish("vault");
      }
      const vault = progress.vault as Address;
      setCreated({ agentId, vault });
      if (!progress.done.includes("faucet")) {
        const needed = (progress.done.includes("bond") ? 0n : bondValue) + depositValue;
        if (needed > 0n)
          await send("faucet", {
            address: deployment.usdg,
            abi: testTokenAbi as Abi,
            functionName: "faucet",
            args: [needed],
          });
        finish("faucet");
      }
      if (!progress.done.includes("bond")) {
        if (bondValue > 0n) {
          await send("bond", {
            address: deployment.usdg,
            abi: testTokenAbi as Abi,
            functionName: "approve",
            args: [deployment.bond, bondValue],
          });
          await send("bond", {
            address: deployment.bond,
            abi: operatorBondAbi as Abi,
            functionName: "stake",
            args: [agentId, bondValue],
          });
        }
        finish("bond");
      }
      if (!progress.done.includes("deposit")) {
        if (depositValue > 0n) {
          await send("deposit", {
            address: deployment.usdg,
            abi: testTokenAbi as Abi,
            functionName: "approve",
            args: [vault, depositValue],
          });
          await send("deposit", {
            address: vault,
            abi: mandateVaultAbi as Abi,
            functionName: "deposit",
            args: [depositValue, user],
          });
        }
        finish("deposit");
      }
      if (!progress.done.includes("ratings")) {
        mark("ratings", "active");
        await registerForRatings(signMessageAsync, agentId.toString(), {
          vault,
          kind: progress.kind,
          mandate,
          ...(progress.sentinel ? { sentinel: true } : {}),
        });
        finish("ratings");
      }
      saveProgress(deployment.chainId, user, null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run({
      kind,
      ...(sentinel ? { sentinel: true } : {}),
      form,
      agentKey: key,
      bond: bond.trim() || "0",
      deposit: deposit.trim() || "0",
      done: [],
    });
  const startOver = () => {
    if (user) saveProgress(deployment.chainId, user, null);
    setSteps([]);
    setCreated(undefined);
    setError(null);
  };

  const toggle = (t: MandateToken) =>
    setTokens((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));

  return (
    <Page
      title="Onboard an agent"
      eyebrow="For operators"
      back={{ to: "/agents", label: "All agents" }}
      intro="Register an agent, give it a vault and a bond, and fund it, all from your wallet. Then get it rated and buy cover from its page."
    >
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <StepCard n={1} title="What gets rated">
            <p className="mb-4 text-sm text-muted">
              The Arena rates one of Bonded's built-in agent designs, run against your vault and
              mandate. Rating your own agent's code is coming (
              <a
                className={linkClass}
                href="https://github.com/ddboy19912/bonded/issues/84"
                target="_blank"
                rel="noreferrer"
              >
                issue #84
              </a>
              ).
            </p>
            <div className="grid gap-2">
              {SELF_SERVE_KINDS.map((k) => (
                <Choice
                  key={k}
                  name="kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  title={SELF_SERVE_KIND_LABELS[k]}
                />
              ))}
            </div>
            <div className="mt-4">
              <Choice
                type="checkbox"
                checked={sentinel}
                onChange={() => setSentinel((v) => !v)}
                title="Rate it with Sentinel in front"
              >
                Sentinel checks each trade the agent proposes and stops the ones driven by what it
                read. If it breaches less, it scores higher and cover costs less. Your agent should
                then ask Sentinel before each trade (
                <Link to="/sentinel" className={linkClass}>
                  how
                </Link>
                ).
              </Choice>
            </div>
          </StepCard>

          <StepCard n={2} title={<Term term="mandate">Mandate</Term>}>
            <div className="flex flex-col gap-5 text-sm">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 font-medium">Vault mode</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice
                    name="mode"
                    checked={mode === "monitor"}
                    onChange={() => setMode("monitor")}
                    title="Monitor"
                  >
                    Breaches go through and are recorded, so they can be claimed.
                  </Choice>
                  <Choice
                    name="mode"
                    checked={mode === "enforce"}
                    onChange={() => setMode("enforce")}
                    title="Enforce"
                  >
                    Breaches are blocked (and recorded). Scores higher, but there's nothing to
                    claim.
                  </Choice>
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 font-medium">
                  Tokens it may hold (<Token symbol="tUSDG" /> always)
                </legend>
                <div className="flex flex-wrap gap-2">
                  {MANDATE_TOKENS.map((t) => (
                    <label
                      key={t}
                      className={`flex cursor-pointer items-center gap-2 rounded-full border py-1 pr-3.5 pl-1 font-mono text-xs has-focus-visible:ring-2 has-focus-visible:ring-accent ${tokens.includes(t) ? "border-accent/60 bg-accent-soft text-ink" : "border-line-strong text-muted opacity-60"}`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={tokens.includes(t)}
                        onChange={() => toggle(t)}
                      />
                      <TokenLogo symbol={t} size={22} />
                      {t}
                      {tokens.includes(t) && <span className="text-accent">✓</span>}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Per-trade limit"
                  value={maxTx}
                  onChange={setMaxTx}
                  inputMode="decimal"
                  suffix="USD"
                  error={limitError(maxTx)}
                />
                <Input
                  label="Daily limit"
                  value={maxDaily}
                  onChange={setMaxDaily}
                  inputMode="decimal"
                  suffix="USD"
                  error={dailyLimitError(maxDaily, maxTx)}
                />
              </div>
              <Input
                label="Refund address"
                hint="The one address the agent may send funds to. Defaults to your wallet."
                value={refund}
                onChange={setRefund}
                placeholder={user ?? "0x…"}
                error={addressError(refund, true)}
              />
              <Input
                label="Description"
                hint="Part of the mandate, so it's hashed on chain."
                value={description}
                onChange={setDescription}
                mono={false}
                error={descriptionError(description)}
              />
            </div>
          </StepCard>

          <StepCard n={3} title="Agent key, bond and deposit">
            <div className="flex flex-col gap-5 text-sm">
              <fieldset>
                <legend className="mb-2 font-medium">
                  <Term term="agentKey">The agent's key</Term>, the only key that can act for the
                  vault
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice
                    name="key"
                    checked={selfAgent}
                    onChange={() => setSelfAgent(true)}
                    title="My wallet"
                  >
                    For testing: lets you simulate a breach from the vault page.
                  </Choice>
                  <Choice
                    name="key"
                    checked={!selfAgent}
                    onChange={() => setSelfAgent(false)}
                    title="Another address"
                  >
                    Your agent's own key.
                  </Choice>
                </div>
                {!selfAgent && (
                  <div className="mt-3">
                    <Input
                      label="Agent key address"
                      value={agentKey}
                      onChange={setAgentKey}
                      error={agentKey ? addressError(agentKey) : null}
                    />
                  </div>
                )}
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={<Term term="bond">Operator bond</Term>}
                  value={bond}
                  onChange={setBond}
                  inputMode="decimal"
                  suffix={<Token symbol="tUSDG" />}
                  error={amountOrZeroError(bond)}
                />
                <Input
                  label="Deposit"
                  value={deposit}
                  onChange={setDeposit}
                  inputMode="decimal"
                  suffix={<Token symbol="tUSDG" />}
                  error={amountOrZeroError(deposit)}
                />
              </div>
              <p className="text-xs text-muted">
                Cover needs a bond of 10% to 30% of the cover, depending on the score's tier: 4,000
                covers 20,000 for tier BB. Test <Token symbol="tUSDG" /> is minted from the faucet
                as part of these steps; you need a little test ETH for gas.
              </p>
            </div>
          </StepCard>
        </div>

        <div className="min-w-0 lg:sticky lg:top-24">
          <StepCard n={4} title="Create">
            {unfinished && !busy && (
              <div className="mb-4 flex flex-col gap-3 rounded-lg border border-warn/30 bg-warn-soft p-4 text-sm">
                <p>
                  You have an unfinished onboarding
                  {unfinished.agentId ? ` of agent ${unfinished.agentId}` : ""}: next step,{" "}
                  {STEPS[ONBOARDING_STEPS.indexOf(nextStep(unfinished)!)]?.toLowerCase()}.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => run(unfinished)}>
                    Resume onboarding
                  </Button>
                  <Button size="sm" kind="secondary" onClick={startOver}>
                    Start a new agent instead
                  </Button>
                </div>
              </div>
            )}
            {problems.length > 0 && (
              <ul className="mb-4 flex flex-col gap-1.5 text-sm text-muted">
                {problems.map((p) => (
                  <li key={p} className="flex gap-2">
                    <span className="text-warn" aria-hidden>
                      •
                    </span>
                    {p}
                  </li>
                ))}
              </ul>
            )}
            <Button
              size="lg"
              disabled={problems.length > 0 || Boolean(unfinished)}
              loading={busy}
              onClick={start}
            >
              {busy ? "Working…" : "Onboard the agent"}
            </Button>
            <p className="mt-2 text-xs text-muted">
              About eight wallet confirmations, then one signature.
            </p>
            {steps.length > 0 && (
              <ol className="mt-5 flex flex-col gap-2.5 border-t border-line pt-5 text-sm">
                {steps.map((s) => (
                  <li key={s.label} className="flex flex-wrap items-center gap-2.5">
                    <span
                      className={`flex size-5 items-center justify-center rounded-full text-[11px] ${
                        s.state === "done"
                          ? "bg-safe text-paper"
                          : s.state === "active"
                            ? "bg-brand text-white"
                            : "bg-sunken text-muted"
                      }`}
                      aria-hidden
                    >
                      {s.state === "done" ? "✓" : s.state === "active" ? "…" : ""}
                    </span>
                    <span className={s.state === "waiting" ? "text-muted" : "font-medium"}>
                      {s.label}
                    </span>
                    {s.hash && <TxLink hash={s.hash} />}
                  </li>
                ))}
              </ol>
            )}
            <ErrorText error={error} />
            {created && (
              <div className="mt-4 rounded-lg border border-safe/30 bg-safe-soft p-4 text-sm">
                <p className="font-medium">Agent {created.agentId.toString()} is set up.</p>
                <p className="mt-1">
                  <Link className={linkClass} to={`/agents/${created.agentId}`}>
                    Rate it
                  </Link>{" "}
                  ·{" "}
                  <Link className={linkClass} to={`/vaults/${created.vault}`}>
                    Its vault (deposits, cover{selfAgent ? ", simulate a breach" : ""})
                  </Link>
                </p>
              </div>
            )}
          </StepCard>
        </div>
      </div>
    </Page>
  );
}

/** A numbered section of the onboarding form. */
function StepCard({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-7 items-center justify-center btn-brand rounded-full text-sm font-semibold text-on-brand">
            {n}
          </span>
          {title}
        </span>
      }
    >
      {children}
    </Card>
  );
}

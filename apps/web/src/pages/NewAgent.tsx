import { useEffect, useRef, useState, type ReactNode } from "react";
import { Token, TokenLogo } from "../components/token";
import { Link, useLocation, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignMessage, useWriteContract } from "wagmi";
import {
  getCapabilities,
  getGasPrice,
  getPublicClient,
  readContract,
  sendCalls,
  waitForCallsStatus,
  waitForTransactionReceipt,
} from "wagmi/actions";
import { isAddress, parseEventLogs, type Address, type Hex, type Log } from "viem";
import {
  REMOTE_KIND,
  SELF_SERVE_KINDS,
  SELF_SERVE_KIND_LABELS,
  bondedRegistryAbi,
  mandateCommitment,
  mandateModuleAbi,
  mandateModuleFactoryAbi,
  mandateVaultFactoryAbi,
  prepareModuleInstall,
  toEvmMandateParams,
  type ModuleAccountType,
  type Protection,
  type RemoteAgentSpec,
  type RemoteMode,
  type SelfServeAgentKind,
} from "@bondedhq/shared";
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
import { AllowanceWarning } from "../components/module-cover";
import {
  ACCOUNT_TYPE_LABELS,
  MODULE_COVER_NOTE,
  installSteps,
  type ModuleCall,
} from "../lib/module";
import { DOCS_BYOA, TEST_AGENT } from "../lib/routes";
import { codeHashError, composeHashError, normaliseCodeHash, teeUrlError } from "../lib/byoa";
import { byoaApi, type Connection } from "../lib/byoa-api";
import { agentUrlError, codeSourceLabel, loadSession } from "../lib/connect";
import { ModeChoice } from "../components/connection-setup";
import { FrameworkQuestions, useFramework } from "../components/framework-questions";
import { WalletHelp } from "../components/wallet-help";
import { connectionFor, hostingFor } from "../lib/frameworks";
import {
  CALL_STEP,
  confirmationCount,
  confirmationsText,
  gasNeeded,
  onboardingPlan,
  supportsAtomicBatch,
  type OnboardingCall,
} from "../lib/wallet-help";
import {
  encoded,
  onboardingCall,
  simulateOnboardingGas,
  type CallContext,
  type ContractCall,
  type SimClient,
} from "../lib/onboarding-gas";
import {
  BOND_EXPLAINED,
  PRESET_LABELS,
  applyPreset,
  basisLine,
  bondTable,
  recommendedBond,
  type PresetChoice,
} from "../lib/bond-cover";
import { NewAgentConnection } from "../components/connect-agent";
import { prefillFrom, type OfficialPrefill } from "../components/preview-report";
import {
  Button,
  Callout,
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
/** An onboarding call that is a transaction (finding a module is a read). */
type TxCall = Exclude<OnboardingCall, "findModule">;

const STEPS = [
  "Register the agent",
  "Create its vault",
  "Get test tUSDG",
  "Stake the operator bond",
  "Deposit into the vault",
  "Register it for ratings (a signature, no gas)",
];
/** The same steps when a module on the owner's smart account protects the funds. */
const MODULE_STEPS = [
  "Register the agent",
  "Find its module on your smart account",
  "Get test tUSDG",
  "Stake the operator bond",
  "Deposit (none: the funds stay in your account)",
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
  const [kind, setKind] = useState<SelfServeAgentKind>("partial");
  const [sentinel, setSentinel] = useState(false);
  // The owner's own agent: how it acts, the code it runs, and its TEE if it has one.
  const [remoteMode, setRemoteMode] = useState<RemoteMode>("tools");
  const [codeHash, setCodeHash] = useState("");
  const [teeUrl, setTeeUrl] = useState("");
  const [composeHash, setComposeHash] = useState("");
  // How it will connect: its URL (verified once it's registered) or the runner.
  const [connection, setConnection] = useState<Connection>("url");
  const [agentUrl, setAgentUrl] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [framework, setFramework] = useFramework();
  // "Make it official" from a preview: its choices fill the form in, once.
  const location = useLocation();
  const [params] = useSearchParams();
  const fromState = (location.state as { prefill?: OfficialPrefill } | null)?.prefill;
  const previewId = fromState?.previewId ?? params.get("preview") ?? undefined;
  const session = loadSession(deployment.chainId, user);
  const fetched = useQuery({
    queryKey: ["preview", previewId, session?.session],
    queryFn: () => byoaApi.preview(session!.session, previewId!),
    enabled: Boolean(previewId && !fromState && session),
    retry: false,
  });
  const prefill = fromState ?? (fetched.data ? prefillFrom(fetched.data) : undefined);
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!prefill || applied.current === prefill.previewId) return;
    applied.current = prefill.previewId;
    setKind(REMOTE_KIND);
    setRemoteMode(prefill.mode);
    setConnection(prefill.connection);
    if (prefill.mode === "chain") setAdvanced(true);
    if (prefill.agentUrl) setAgentUrl(prefill.agentUrl);
    if (prefill.codeHash?.source === "declared") {
      setCodeHash(prefill.codeHash.value);
      setAdvanced(true);
    }
  }, [prefill]);
  // Where the funds are protected: a new Bonded vault, or a module on a smart account in use.
  const [protection, setProtection] = useState<Protection>("vault");
  const [account, setAccount] = useState("");
  const [accountType, setAccountType] = useState<ModuleAccountType>("safe7579");
  const [install, setInstall] = useState<{ module: Address; calls: ModuleCall[] }>();
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
  // The mandate the agent's own preview suggests: what it actually traded, with headroom.
  const suggested = useQuery({
    queryKey: ["suggested-mandate", previewId, session?.session],
    queryFn: () => byoaApi.suggestedMandate({ kind: "preview", id: previewId! }, session!.session),
    enabled: Boolean(previewId && session),
    retry: false,
  });
  const [preset, setPreset] = useState<PresetChoice>("custom");
  const choosePreset = (id: PresetChoice) => {
    setPreset(id);
    const p = suggested.data?.presets.find((x) => x.id === id);
    if (!p) return;
    const f = applyPreset(p);
    setMode(f.mode);
    setTokens(f.tokens);
    setMaxTx(f.maxTx);
    setMaxDaily(f.maxDaily);
  };
  const presetApplied = useRef(false);
  useEffect(() => {
    if (presetApplied.current || !suggested.data?.presets.length) return;
    presetApplied.current = true;
    const recommended = suggested.data.recommended ?? "conservative";
    choosePreset(
      suggested.data.presets.some((p) => p.id === recommended)
        ? recommended
        : suggested.data.presets[0]!.id,
    );
    // Once, when the suggestion arrives.
  }, [suggested.data]);
  // Editing a field by hand makes the mandate custom.
  const custom =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setPreset("custom");
      set(v);
    };
  const [wantedCover, setWantedCover] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{
    agentId: bigint;
    vault: Address;
    connect?: OnboardingProgress["connect"];
    mode?: RemoteMode;
  }>();
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
  const own = kind === REMOTE_KIND;
  const remoteErrors = own
    ? [
        codeHash.trim() ? codeHashError(codeHash) : null,
        connection === "url" ? agentUrlError(agentUrl) : null,
        ...(remoteMode === "chain"
          ? [
              teeUrlError(teeUrl),
              composeHashError(composeHash, teeUrl),
              teeUrl.trim() && connection === "url"
                ? "A TEE-bound agent connects through its runner, which forwards its TEE's evidence: choose the runner."
                : null,
              teeUrl.trim() && !codeHash.trim()
                ? "With a TEE, enter the code hash your TEE reports (under Advanced)."
                : null,
            ]
          : []),
      ]
    : [];
  const remote: RemoteAgentSpec | undefined = own
    ? {
        ...(codeHash.trim() ? { codeHash: normaliseCodeHash(codeHash) } : {}),
        mode: remoteMode,
        ...(connection === "url" ? { connection: "url" as const } : {}),
        ...(teeUrl.trim() && remoteMode === "chain"
          ? {
              tee: {
                url: teeUrl.trim(),
                composeHash: composeHash.trim().startsWith("0x")
                  ? composeHash.trim()
                  : `0x${composeHash.trim()}`,
              },
            }
          : {}),
      }
    : undefined;
  const problems = [
    ...validateOnboarding(deployment, {
      connected: isConnected,
      form,
      agentKey: key,
      bond,
      deposit,
    }),
    ...remoteErrors.filter((e): e is string => Boolean(e)),
    ...(protection === "module" && !deployment.moduleFactory
      ? ["Smart-account protection isn't deployed on this chain yet."]
      : []),
    ...(protection === "module" && mode !== "enforce"
      ? ["A module on a smart account must use Enforce mode: in Monitor mode it can't hold cover."]
      : []),
    ...(protection === "module" && !isAddress(account.trim())
      ? ["Enter your smart account's address."]
      : []),
  ];
  const onModule = protection === "module";
  // What the owner will be asked to approve, counted from the steps that will run.
  const bondUnits = parseAmount(bond) ?? 0n;
  const depositUnits = onModule ? 0n : (parseAmount(deposit) ?? 0n);
  // Wallets that can batch atomically (EIP-5792) confirm each group of transactions once.
  const capabilities = useQuery({
    queryKey: ["wallet-capabilities", user],
    queryFn: () => getCapabilities(wagmiConfig, { account: user! }),
    enabled: Boolean(user),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const batched = supportsAtomicBatch(capabilities.data, robinhoodTestnet.id);
  const plan = onboardingPlan({
    done: [],
    bond: bondUnits,
    deposit: depositUnits,
    module: onModule,
  });
  const confirmations = confirmationCount(plan, batched);
  const unbatched = confirmationCount(plan, false);
  const confirmationsLine = `${confirmationsText(confirmations)}${
    batched && unbatched > confirmations
      ? ` (your wallet sends them in batches, instead of ${unbatched})`
      : ""
  }${onModule ? ", the module's install sent from your smart account," : ","} then one signature${kind === REMOTE_KIND ? ". Then you connect it and check the connection, here" : ""}.`;
  // How much gas that is: the onboarding's own transactions, simulated on the chain as it is.
  const simForm = JSON.stringify({ form, bond, deposit, key, onModule });
  const gas = useQuery({
    queryKey: ["onboarding-gas", user, simForm],
    enabled: Boolean(user && isAddress(key)),
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const client = getPublicClient(wagmiConfig, { chainId: robinhoodTestnet.id });
      if (!client || !user) return null;
      const [used, price] = await Promise.all([
        simulateOnboardingGas(client as unknown as SimClient, {
          deployment,
          user,
          agentKey: key as Address,
          bond: bondUnits,
          deposit: depositUnits,
          module: onModule,
          mandateFor: (id) => buildMandate(deployment, id, form),
        }),
        getGasPrice(wagmiConfig, { chainId: robinhoodTestnet.id }).catch(() => undefined),
      ]);
      return gasNeeded({ gasUsed: used, gasPrice: price }) ?? null;
    },
  });
  const stepLabels = onModule ? MODULE_STEPS : STEPS;
  // The owner's own agent, registered: connect it and check it here, before its first rating.
  const connectNow = Boolean(
    created?.mode && steps.length > 0 && steps.every((s) => s.state === "done"),
  );
  const saved = user ? loadProgress(deployment.chainId, user) : undefined;
  const unfinished = saved && nextStep(saved) ? saved : undefined;

  const labelsFor = (p: { protection?: Protection }) =>
    p.protection === "module" ? MODULE_STEPS : STEPS;
  const showSteps = (done: OnboardingStep[], labels: string[]) =>
    setSteps(
      ONBOARDING_STEPS.map((step, i) => ({
        label: labels[i]!,
        state: done.includes(step) ? "done" : "waiting",
      })),
    );
  const mark = (step: OnboardingStep, state: Step["state"], hash?: Hex) =>
    setSteps((s) =>
      s.map((row, i) =>
        ONBOARDING_STEPS[i] === step ? { ...row, state, ...(hash ? { hash } : {}) } : row,
      ),
    );
  async function send(step: OnboardingStep, call: ContractCall): Promise<Log[]> {
    mark(step, "active");
    const hash = await writeContractAsync({ ...call, chainId: robinhoodTestnet.id } as never);
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    if (receipt.status !== "success")
      throw new Error(`${stepLabels[ONBOARDING_STEPS.indexOf(step)]} failed`);
    mark(step, "active", hash);
    return receipt.logs;
  }

  /**
   * Sends a group of transactions: as one atomic batch when the wallet can (EIP-5792), else one
   * by one. A wallet that turns the batch down for any reason but the user's own "no" gets the
   * same transactions one by one. `settle` records what each confirmed transaction made (the
   * agent id, the vault) before the next one is asked for: one by one, a later prompt the user
   * turns down must not lose what an earlier one made. Only an atomic batch settles as a group.
   */
  async function sendGroup(
    kinds: TxCall[],
    ctx: () => CallContext,
    settle: (kinds: TxCall[], logs: Log[]) => void,
    track: (batch: OnboardingProgress["batch"]) => void,
  ) {
    if (batched && kinds.length > 1) {
      for (const k of kinds) mark(CALL_STEP[k], "active");
      let id: string | undefined;
      try {
        ({ id } = await sendCalls(wagmiConfig, {
          calls: kinds.map((k) => encoded(onboardingCall(k, ctx()))),
          chainId: robinhoodTestnet.id,
          forceAtomic: true,
        }));
      } catch (e) {
        const rejected =
          (e as { code?: number })?.code === 4001 ||
          /reject|denied|cancel/i.test(String((e as Error)?.message));
        if (rejected) throw e;
        // The wallet can't batch after all: the same transactions, one by one, below.
      }
      if (id) {
        // Saved before waiting: a timeout or a reload follows this batch, it isn't sent again.
        track({ id, calls: kinds });
        await followBatch(id, kinds, settle, track);
        return;
      }
    }
    for (const k of kinds) settle([k], await send(CALL_STEP[k], onboardingCall(k, ctx())));
  }

  /** Waits for a batch the wallet was sent (`wallet_getCallsStatus`), then settles it. */
  async function followBatch(
    id: string,
    kinds: TxCall[],
    settle: (kinds: TxCall[], logs: Log[]) => void,
    track: (batch: OnboardingProgress["batch"]) => void,
  ) {
    let result: Awaited<ReturnType<typeof waitForCallsStatus>>;
    try {
      result = await waitForCallsStatus(wagmiConfig, { id });
    } catch (e) {
      const code =
        (e as { code?: number })?.code ?? (e as { cause?: { code?: number } })?.cause?.code;
      // EIP-5792's "unknown bundle id": this wallet has no such batch, so it can't be followed.
      if (code === 5730) {
        track(undefined);
        throw new Error(
          "Your wallet doesn't know the batch it was sent any more. Check its activity: if the batch didn't go through, resume to send it again.",
          { cause: e },
        );
      }
      throw new Error(
        "Your wallet's batch hasn't confirmed yet. Resume to keep following the same batch: it won't be sent again.",
        { cause: e },
      );
    }
    if (result.status !== "success") {
      track(undefined);
      throw new Error("The batch of transactions failed, so none of them went through.");
    }
    const receipts = result.receipts ?? [];
    const hash = receipts.at(-1)?.transactionHash;
    for (const k of kinds) mark(CALL_STEP[k], "active", hash);
    settle(
      kinds,
      receipts.flatMap((r) => r.logs as Log[]),
    );
    track(undefined);
  }

  /**
   * Runs every step not yet done for `progress`, saving it after each confirmed transaction (or
   * atomic batch), so a rejected prompt or a reload resumes here instead of registering another
   * agent.
   */
  async function run(progress: OnboardingProgress) {
    if (!user) return;
    setBusy(true);
    setError(null);
    showSteps(progress.done, labelsFor(progress));
    setInstall(undefined);
    const save = (p: OnboardingProgress) => saveProgress(deployment.chainId, user, p);
    const finish = (step: OnboardingStep) => {
      if (progress.done.includes(step)) return;
      progress = { ...progress, done: [...progress.done, step] };
      save(progress);
      mark(step, "done");
    };
    const bondValue = parseAmount(progress.bond)!;
    // A module guards funds already in the smart account: nothing to deposit.
    const onModulePath = progress.protection === "module";
    const depositValue = onModulePath ? 0n : parseAmount(progress.deposit)!;
    const ctx = (): CallContext => ({
      deployment,
      user,
      agentKey: progress.agentKey as Address,
      bond: bondValue,
      deposit: depositValue,
      faucet: (progress.done.includes("bond") ? 0n : bondValue) + depositValue,
      ...(progress.agentId ? { agentId: BigInt(progress.agentId) } : {}),
      ...(progress.mandate ? { mandate: progress.mandate } : {}),
      ...(progress.vault ? { vault: progress.vault as Address } : {}),
    });
    const remember = (vault: Address) => {
      rememberAgent(deployment.chainId, progress.agentId!, {
        vault,
        kind: progress.kind,
        mandate: progress.mandate!,
        ...(onModulePath ? { protection: "module" as const } : {}),
        ...(progress.sentinel ? { sentinel: true } : {}),
        ...(progress.remote ? { remote: progress.remote } : {}),
      });
      setCreated({
        agentId: BigInt(progress.agentId!),
        vault,
        ...(progress.connect ? { connect: progress.connect } : {}),
        ...(progress.remote ? { mode: progress.remote.mode } : {}),
      });
    };
    if (progress.vault) remember(progress.vault as Address);
    /** What confirmed transactions made, saved at once (by `finish`). */
    const settle = (kinds: TxCall[], logs: Log[]) => {
      if (kinds.includes("register")) {
        const agentId = (
          parseEventLogs({ abi: bondedRegistryAbi, logs, eventName: "Registered" })[0]?.args as {
            agentId: bigint;
          }
        ).agentId;
        // The mandate is frozen here, with the agent id, and reused by every later step.
        const mandate = buildMandate(deployment, agentId, progress.form);
        progress = { ...progress, agentId: agentId.toString(), mandate };
        finish("register");
      }
      if (kinds.includes("createVault")) {
        const vault = (
          parseEventLogs({ abi: mandateVaultFactoryAbi, logs, eventName: "VaultCreated" })[0]
            ?.args as { vault: Address }
        ).vault;
        progress = { ...progress, vault };
        remember(vault);
        finish("vault");
      }
      if (kinds.includes("faucet")) finish("faucet");
      if (kinds.includes("stake")) finish("bond");
      if (kinds.includes("deposit")) finish("deposit");
    };
    /** The pending batch, saved with the progress (or cleared once it has settled). */
    const track = (batch: OnboardingProgress["batch"]) => {
      progress = { ...progress, batch };
      if (!batch) delete progress.batch;
      save(progress);
    };
    try {
      // A batch sent before a timeout or a reload: follow it, don't send it again.
      if (progress.batch) {
        const pending = progress.batch;
        for (const k of pending.calls) mark(CALL_STEP[k], "active");
        await followBatch(pending.id, pending.calls, settle, track);
      }
      const groups = onboardingPlan({
        done: progress.done,
        bond: bondValue,
        deposit: depositValue,
        module: onModulePath,
      });
      // Steps with nothing to send (no bond, no deposit) are done straight away.
      const planned = new Set(groups.flat().map((c) => CALL_STEP[c]));
      for (const step of ["faucet", "bond", "deposit"] as const)
        if (!planned.has(step)) finish(step);
      for (const group of groups) {
        if (group.includes("findModule")) await findModule();
        const kinds = group.filter((c): c is TxCall => c !== "findModule");
        if (!kinds.length) continue;
        await sendGroup(kinds, ctx, settle, track);
      }
      if (!progress.done.includes("ratings")) {
        mark("ratings", "active");
        await registerForRatings(signMessageAsync, progress.agentId!, {
          vault: progress.vault!,
          kind: progress.kind,
          mandate: progress.mandate!,
          ...(progress.sentinel ? { sentinel: true } : {}),
          ...(progress.remote ? { remote: progress.remote } : {}),
          ...(onModulePath ? { protection: "module" as const } : {}),
          ...(progress.connect?.previewId ? { previewId: progress.connect.previewId } : {}),
        });
        finish("ratings");
      }
      saveProgress(deployment.chainId, user, null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }

    /**
     * The smart account creates and installs its module itself; this step finds it, and checks
     * it is this agent's and enforces this mandate (its commitment).
     */
    async function findModule() {
      mark("vault", "active");
      const agentId = BigInt(progress.agentId!);
      const mandate = progress.mandate!;
      const factory = deployment.moduleFactory!;
      const owner = progress.account as Address;
      const found = await readContract(wagmiConfig, {
        address: factory,
        abi: mandateModuleFactoryAbi,
        functionName: "moduleOf",
        args: [owner],
        chainId: robinhoodTestnet.id,
      });
      const commitment = mandateCommitment(toEvmMandateParams(mandate));
      const fits =
        found !== "0x0000000000000000000000000000000000000000" &&
        (
          await Promise.all([
            readContract(wagmiConfig, {
              address: found,
              abi: mandateModuleAbi,
              functionName: "mandateHash",
              chainId: robinhoodTestnet.id,
            }),
            readContract(wagmiConfig, {
              address: found,
              abi: mandateModuleAbi,
              functionName: "agentId",
              chainId: robinhoodTestnet.id,
            }),
          ])
        ).every((v, i) =>
          i === 0 ? String(v).toLowerCase() === commitment.toLowerCase() : v === agentId,
        );
      if (!fits) {
        const client = getPublicClient(wagmiConfig, { chainId: robinhoodTestnet.id });
        if (!client) throw new Error("can't reach the chain to plan the module's install");
        const type = progress.accountType ?? "safe7579";
        const plan = await prepareModuleInstall(client, {
          moduleFactory: factory,
          account: owner,
          params: toEvmMandateParams(mandate),
          agent: progress.agentKey as Address,
          guardian: user!,
          agentId,
          accountType: type,
        });
        setInstall({ module: plan.module, calls: installSteps(plan, type) });
        throw new Error(
          "Your smart account has no module for this agent yet. Send the calls below from it, then resume onboarding.",
        );
      }
      progress = { ...progress, vault: found };
      remember(found);
      finish("vault");
    }
  }

  const start = () =>
    run({
      kind,
      ...(sentinel && !own ? { sentinel: true } : {}),
      ...(remote ? { remote } : {}),
      ...(own
        ? {
            connect: {
              connection,
              ...(connection === "url" ? { agentUrl: agentUrl.trim() } : {}),
              ...(previewId ? { previewId } : {}),
            },
          }
        : {}),
      ...(onModule ? { protection: "module" as const, account: account.trim(), accountType } : {}),
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
              One of Bonded's built-in agent designs, run against your vault and mandate, or your
              own agent, running where it runs and reached at its URL or through a small runner (
              <a className={linkClass} href={DOCS_BYOA}>
                how
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
              <Choice
                name="kind"
                checked={own}
                onChange={() => setKind(REMOTE_KIND)}
                title="My own agent: any framework or language, where it already runs"
              >
                Connect it at its URL or with a small runner, right after onboarding, and check the
                connection before its first rating.
              </Choice>
            </div>
            {own ? (
              <div className="mt-5 flex flex-col gap-5 text-sm">
                {prefill ? (
                  <Callout tone="safe" title="Filled in from your preview">
                    Its mode and connection are set as you tested them. The official rating runs
                    again from scratch, attested on chain; your preview stays linked to it.
                  </Callout>
                ) : (
                  <p className="text-muted">
                    Not ready to commit a vault and a bond?{" "}
                    <Link className={linkClass} to={TEST_AGENT}>
                      Test your agent first
                    </Link>
                    : a free preview rating, no tokens needed.
                  </p>
                )}
                <FrameworkQuestions
                  name="onboard"
                  framework={framework}
                  hosting={hostingFor(connection)}
                  onFramework={setFramework}
                  onHosting={(h) => setConnection(connectionFor(h))}
                />
                {connection === "url" ? (
                  <Input
                    label="Your agent's URL"
                    hint="Public https. Bonded verifies it right after onboarding, when the agent exists, and gives you its secret then."
                    value={agentUrl}
                    onChange={setAgentUrl}
                    placeholder="https://my-agent.example.com/bonded"
                    error={agentUrl ? agentUrlError(agentUrl) : null}
                  />
                ) : (
                  <p className="text-xs text-muted">
                    Right after onboarding you get the runner's command, with its token filled in.
                  </p>
                )}
                <details
                  open={advanced}
                  onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}
                  className="rounded-2xl border border-line-strong p-4"
                >
                  <summary className="cursor-pointer font-medium">Advanced (optional)</summary>
                  <div className="mt-4 flex flex-col gap-4">
                    <ModeChoice mode={remoteMode} onMode={setRemoteMode} name="onboard-mode" />
                    <Input
                      label="Code hash"
                      hint={
                        connection === "url"
                          ? "Leave it empty: it fills itself in from the version your Agent URL reports. Enter one (an image digest sha256:… or a commit, as 0x and 64 hex digits) only to pin a build."
                          : "Leave it empty: the runner fills it in from your agent's git commit or Docker image. Enter one (sha256:… or 0x and 64 hex digits) only to pin a build."
                      }
                      value={codeHash}
                      onChange={setCodeHash}
                      placeholder="Filled in automatically"
                      error={codeHash ? codeHashError(codeHash) : null}
                    />
                    {prefill?.codeHash && prefill.codeHash.source !== "declared" && (
                      <p className="text-xs text-muted">
                        In your preview it came from {codeSourceLabel(prefill.codeHash)}. It will be
                        reported again the same way.
                      </p>
                    )}
                    {remoteMode === "chain" ? (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Input
                          label="TEE URL"
                          hint="If it runs in a Phala dstack TEE: every episode must then prove the code."
                          value={teeUrl}
                          onChange={setTeeUrl}
                          placeholder="https://…"
                          error={teeUrlError(teeUrl)}
                        />
                        <Input
                          label="Compose hash"
                          hint="Published for that deployment. Needed with a TEE URL."
                          value={composeHash}
                          onChange={setComposeHash}
                          placeholder="0x…"
                          error={
                            composeHash || teeUrl ? composeHashError(composeHash, teeUrl) : null
                          }
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-muted">
                        A TEE can bind only a chain-mode agent: in tool mode the tool calls come
                        from outside the TEE, so it would prove nothing about how the agent acts.
                      </p>
                    )}
                    <p className="text-xs text-muted">
                      Without a TEE the score's binding is declared, and cover is capped lower
                      (underwriting policy, not the score). With one (chain mode only), every
                      episode must prove it, the vault's agent key must be the TEE's own key for
                      cover, and the compose hash is what's bound: the compose file decides what
                      runs in the TEE, so publish it for review.
                    </p>
                  </div>
                </details>
              </div>
            ) : (
              <div className="mt-4">
                <Choice
                  type="checkbox"
                  checked={sentinel}
                  onChange={() => setSentinel((v) => !v)}
                  title="Rate it with Sentinel in front"
                >
                  Sentinel checks each trade the agent proposes and stops the ones driven by what it
                  read. If it breaches less, it scores higher and cover costs less. Your agent
                  should then ask Sentinel before each trade (
                  <Link to="/sentinel" className={linkClass}>
                    how
                  </Link>
                  ).
                </Choice>
              </div>
            )}
          </StepCard>

          <StepCard n={2} title={<Term term="mandate">Mandate</Term>}>
            <div className="flex flex-col gap-5 text-sm">
              {suggested.data && suggested.data.presets.length > 0 && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 font-medium">Start from what your agent did</legend>
                  <p className="mb-1 text-xs text-muted">
                    {basisLine(suggested.data.basis)
                      ? `From ${basisLine(suggested.data.basis)}: `
                      : "From your preview: "}
                    it traded{" "}
                    {suggested.data.tokens.length ? suggested.data.tokens.join(", ") : "no tokens"}
                    {suggested.data.largestTradeUsd != null
                      ? `, and its largest trade was ${suggested.data.largestTradeUsd.toLocaleString("en-US")} USD`
                      : ""}
                    {suggested.data.contracts.length
                      ? `, through ${suggested.data.contracts.map((c) => c.label ?? c.address).join(", ")}`
                      : ""}
                    .
                  </p>
                  {suggested.data.notes?.length ? (
                    <ul className="mb-1 list-disc pl-5 text-xs text-soft">
                      {suggested.data.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(["conservative", "active", "custom"] as const)
                      .filter(
                        (id) => id === "custom" || suggested.data!.presets.some((p) => p.id === id),
                      )
                      .map((id) => {
                        const p = suggested.data!.presets.find((x) => x.id === id);
                        return (
                          <Choice
                            key={id}
                            name="preset"
                            checked={preset === id}
                            onChange={() => choosePreset(id)}
                            title={p?.label ?? PRESET_LABELS[id]}
                          >
                            {p
                              ? (p.line ??
                                `${p.mode === "enforce" ? "Enforce" : "Monitor"}, up to ${p.maxTxUsd.toLocaleString("en-US")} USD a trade and ${p.maxDailyUsd.toLocaleString("en-US")} a day`)
                              : "Set every field yourself."}
                          </Choice>
                        );
                      })}
                  </div>
                </fieldset>
              )}
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 font-medium">
                  {onModule ? "Module mode" : "Vault mode"}
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice
                    name="mode"
                    checked={mode === "monitor"}
                    onChange={() => custom(setMode)("monitor")}
                    title="Monitor"
                    disabled={onModule}
                  >
                    {onModule
                      ? "Not for a smart account: a module can hold cover only in Enforce mode."
                      : "Breaches go through and are recorded, so they can be claimed."}
                  </Choice>
                  <Choice
                    name="mode"
                    checked={mode === "enforce"}
                    onChange={() => custom(setMode)("enforce")}
                    title="Enforce"
                  >
                    {onModule
                      ? "Breaches are blocked (and recorded). The only mode a smart account's module can hold cover in."
                      : "Breaches are blocked (and recorded). Scores higher, but there's nothing to claim."}
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
                        onChange={() => (setPreset("custom"), toggle(t))}
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
                  onChange={custom(setMaxTx)}
                  inputMode="decimal"
                  suffix="USD"
                  error={limitError(maxTx)}
                />
                <Input
                  label="Daily limit"
                  value={maxDaily}
                  onChange={custom(setMaxDaily)}
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

          <StepCard n={3} title="Where the funds are, agent key and bond">
            <div className="flex flex-col gap-5 text-sm">
              <fieldset>
                <legend className="mb-2 font-medium">What protects the funds</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice
                    name="protection"
                    checked={!onModule}
                    onChange={() => setProtection("vault")}
                    title="Create a Bonded vault"
                  >
                    A new Mandate Vault holds the funds; depositors put money in it.
                  </Choice>
                  <Choice
                    name="protection"
                    checked={onModule}
                    onChange={() => {
                      setProtection("module");
                      // Only an Enforce-mode module can hold cover.
                      setMode("enforce");
                    }}
                    title="Protect the smart account I already use (ERC-7579 / Safe)"
                  >
                    {deployment.moduleFactory
                      ? "A module on your account enforces the mandate; the funds stay where they are."
                      : "Not deployed on this chain yet."}
                  </Choice>
                </div>
                {onModule && (
                  <div className="mt-3 flex flex-col gap-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(["safe7579", "erc7579"] as const).map((t) => (
                        <Choice
                          key={t}
                          name="account-type"
                          checked={accountType === t}
                          onChange={() => setAccountType(t)}
                          title={ACCOUNT_TYPE_LABELS[t]}
                        />
                      ))}
                    </div>
                    <Input
                      label="Smart account address"
                      hint="Your Safe (with Safe7579) or other ERC-7579 account. It creates and installs the module itself; the page gives you the calls."
                      value={account}
                      onChange={setAccount}
                      placeholder="0x…"
                      error={account ? addressError(account) : null}
                    />
                    <p className="text-xs text-muted">{MODULE_COVER_NOTE}</p>
                    <AllowanceWarning
                      account={isAddress(account.trim()) ? (account.trim() as Address) : undefined}
                      targets={[deployment.router]}
                      assets={[
                        deployment.usdg,
                        ...tokens.map(
                          (t) =>
                            ({
                              tTSLA: deployment.tsla,
                              tAMZN: deployment.amzn,
                              tNVDA: deployment.nvda,
                            })[t],
                        ),
                      ]}
                    />
                  </div>
                )}
              </fieldset>
              <fieldset>
                <legend className="mb-2 font-medium">
                  <Term term="agentKey">The agent's key</Term>, the only key that can act{" "}
                  {onModule ? "through the module on your smart account" : "for the vault"}
                </legend>
                {onModule && (
                  <p className="mb-2 text-xs text-muted">
                    It must not be an owner, a validator or an ERC-1271 signer of the smart account:
                    that would let the agent act as the account itself, around the module.
                  </p>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice
                    name="key"
                    checked={selfAgent}
                    onChange={() => setSelfAgent(true)}
                    title="My wallet"
                  >
                    {onModule
                      ? "For testing: you act as the agent yourself, through the module. Not if your wallet owns the account."
                      : "For testing: lets you simulate a breach from the vault page."}
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
                {!onModule && (
                  <Input
                    label="Deposit"
                    value={deposit}
                    onChange={setDeposit}
                    inputMode="decimal"
                    suffix={<Token symbol="tUSDG" />}
                    error={amountOrZeroError(deposit)}
                  />
                )}
              </div>
              <BondAdvice
                wantedCover={wantedCover}
                onWantedCover={setWantedCover}
                deposit={onModule ? "" : deposit}
                score={fetched.data?.rating?.score ?? prefill?.score ?? null}
                onUse={(b) => setBond(String(b))}
              />
            </div>
          </StepCard>
          {connectNow && (
            <StepCard n={5} title="Connect it and check the connection">
              <NewAgentConnection
                agentId={created!.agentId.toString()}
                mode={created!.mode!}
                framework={framework}
                {...(created!.connect?.connection
                  ? { initialConnection: created!.connect.connection }
                  : {})}
                {...(created!.connect?.agentUrl ? { initialUrl: created!.connect.agentUrl } : {})}
              />
              <p className="mt-5 border-t border-line pt-4 text-sm text-muted">
                Once the check passes,{" "}
                <Link className={linkClass} to={`/agents/${created!.agentId}`}>
                  rate it from its page
                </Link>
                . The page shows the estimate first, then the rating's progress.
              </p>
            </StepCard>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-24">
          <WalletHelp gasNeeded={gas.data ?? undefined} />
          <StepCard n={4} title="Create">
            {unfinished && !busy && (
              <div className="mb-4 flex flex-col gap-3 rounded-lg border border-warn/30 bg-warn-soft p-4 text-sm">
                <p>
                  You have an unfinished onboarding
                  {unfinished.agentId ? ` of agent ${unfinished.agentId}` : ""}
                  {unfinished.batch ? ", with a batch your wallet was sent still to confirm" : ""}:
                  next step,{" "}
                  {labelsFor(unfinished)[
                    ONBOARDING_STEPS.indexOf(nextStep(unfinished)!)
                  ]?.toLowerCase()}
                  .
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
            <p className="mt-2 text-xs text-muted">{confirmationsLine}</p>
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
            {install && (
              <div className="mt-4 flex flex-col gap-3 rounded-lg border border-line-strong p-4 text-sm">
                <p className="font-medium">Send these from your smart account, in order</p>
                <p className="text-xs text-muted">
                  The module will be at <span className="font-mono">{install.module}</span>.{" "}
                  {install.calls.length > 1
                    ? "In the Safe, add the three calls to one batch in the transaction builder."
                    : "Send it from your account's own app."}
                </p>
                <ol className="flex flex-col gap-3">
                  {install.calls.map((call) => (
                    <li key={call.label} className="flex flex-col gap-1">
                      <span className="text-xs font-semibold text-soft">{call.label}</span>
                      <span className="font-mono text-xs break-all text-muted">To {call.to}</span>
                      <pre className="max-h-28 overflow-auto rounded-lg bg-black/40 p-2.5 font-mono text-[11px] break-all whitespace-pre-wrap text-soft">
                        {call.data}
                      </pre>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {created && (
              <div className="mt-4 rounded-lg border border-safe/30 bg-safe-soft p-4 text-sm">
                <p className="font-medium">Agent {created.agentId.toString()} is set up.</p>
                <p className="mt-1">
                  {connectNow ? (
                    <span>Next: connect it and check the connection, below</span>
                  ) : (
                    <Link className={linkClass} to={`/agents/${created.agentId}`}>
                      {own ? "Connect and rate it" : "Rate it"}
                    </Link>
                  )}{" "}
                  ·{" "}
                  {onModule ? (
                    <span>Buy cover for its module from the agent's page</span>
                  ) : (
                    <Link className={linkClass} to={`/vaults/${created.vault}`}>
                      Its vault (deposits, cover{selfAgent ? ", simulate a breach" : ""})
                    </Link>
                  )}
                </p>
              </div>
            )}
          </StepCard>
        </div>
      </div>
    </Page>
  );
}

/**
 * The bond in plain words: what it is, when it's lost, and the bond the cover you want needs, by
 * tier (the same minimum-bond rule a quote enforces).
 */
function BondAdvice({
  wantedCover,
  onWantedCover,
  deposit,
  score,
  onUse,
}: {
  wantedCover: string;
  onWantedCover: (v: string) => void;
  deposit: string;
  score: number | null;
  onUse: (bond: number) => void;
}) {
  const typed = Number(wantedCover.replace(/,/g, ""));
  const fallback = Number(deposit.replace(/,/g, ""));
  const cover = wantedCover.trim() ? typed : fallback;
  const valid = Number.isFinite(cover) && cover > 0;
  const rec = valid ? recommendedBond(cover, score) : undefined;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line-strong p-4 text-sm">
      <p className="font-medium">What the bond is for</p>
      <p className="text-muted">{BOND_EXPLAINED}</p>
      <Input
        label="Cover you want"
        hint={
          wantedCover.trim()
            ? undefined
            : "Starts at your deposit: cover pays for what the vault holds."
        }
        value={wantedCover}
        onChange={onWantedCover}
        placeholder={deposit || "20000"}
        inputMode="decimal"
        suffix={<Token symbol="tUSDG" />}
      />
      {valid && (
        <>
          <table className="w-full text-xs">
            <caption className="sr-only">Smallest bond for this cover, by tier</caption>
            <thead className="text-left text-muted">
              <tr>
                <th className="pb-1 font-medium">Score's tier</th>
                <th className="pb-1 text-right font-medium">Smallest bond</th>
              </tr>
            </thead>
            <tbody>
              {bondTable(cover).map((r) => (
                <tr key={r.tiers} className="border-t border-white/[0.06]">
                  <td className="py-1.5">
                    {r.tiers} ({r.minBondPct}% of the cover)
                  </td>
                  <td className="py-1.5 text-right font-mono">{r.bond.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rec && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted">
                Recommended:{" "}
                <span className="font-mono text-ink">{rec.bond.toLocaleString("en-US")}</span>,
                because {rec.why}.
              </p>
              <Button size="sm" kind="secondary" onClick={() => onUse(rec.bond)}>
                Use this bond
              </Button>
            </div>
          )}
        </>
      )}
      <p className="text-xs text-muted">
        Test <Token symbol="tUSDG" /> for the bond and the deposit is minted from the faucet as part
        of these steps.
      </p>
    </div>
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

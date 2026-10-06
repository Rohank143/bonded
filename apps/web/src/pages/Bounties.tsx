import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { getAbiItem, type Hex } from "viem";
import { ATTACK_CLASSES, BOUNTY_SPEC_EXAMPLE, bountyBoardAbi, testTokenAbi } from "@bonded/shared";
import { deployment, faucets, isLocal, networkName } from "../config";
import { api, type BountyRecord } from "../lib/api";
import { checkSpec, commitmentIfReady, isSalt, newSalt, specUriOf } from "../lib/bounty";
import { short, usd } from "../lib/format";
import { ConnectButton, useSend } from "../components/wallet";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  Loading,
  Page,
  TxLink,
  linkClass,
} from "../components/ui";

const STATUS_TONE: Record<BountyRecord["status"], "safe" | "breach" | "neutral"> = {
  accepted: "safe",
  rejected: "breach",
  validating: "neutral",
  failed: "breach",
};

/** The submission id of this hunter's latest commit with this commitment, from the board's events. */
function useCommitId(commitment: Hex | undefined) {
  const client = usePublicClient();
  const { address } = useAccount();
  return useQuery({
    queryKey: ["bounty-commit", commitment, address],
    enabled: Boolean(client && commitment && address),
    queryFn: async () => {
      const logs = await client!.getLogs({
        address: deployment.bountyBoard,
        event: getAbiItem({ abi: bountyBoardAbi, name: "Committed" }),
        args: { hunter: address },
        fromBlock: BigInt(deployment.deployedAtBlock),
        toBlock: "latest",
        strict: true,
      });
      const mine = logs.filter((l) => l.args.commitment === commitment);
      return mine.at(-1)?.args.id;
    },
  });
}

const REPO = "https://github.com/ddboy19912/bonded/blob/main";

/** The hunter's guide (docs/BOUNTIES.md), step by step, on the page where the steps happen. */
function Guide() {
  const steps: [string, ReactNode][] = [
    [
      "Get set up",
      <>
        Connect a browser wallet on {networkName}. Submitting costs only gas, no tUSDG.
        {!isLocal && (
          <>
            {" "}
            Test ETH comes from a public faucet:{" "}
            {faucets.map((f, i) => (
              <a key={f} href={f} className={linkClass} target="_blank" rel="noreferrer">
                {i ? ", " : ""}
                {new URL(f).hostname}
              </a>
            ))}
            .
          </>
        )}
      </>,
    ],
    [
      "Write the attack",
      <>
        Start from the example. Its id must start with the class (<code>A6-...</code>) and use one
        of the class's surfaces. The <code>payloadTemplate</code> is the text planted on that
        surface: use <code>{"{{attacker}}"}</code> for an address you control, and{" "}
        <code>{"{{amount}}"}</code>, <code>{"{{token}}"}</code>, <code>{"{{vault}}"}</code>,{" "}
        <code>{"{{depositor}}"}</code> or <code>{"{{lookalike}}"}</code> where you need them. Don't
        set a <code>goal</code>: the Arena gives every run its own task.
      </>,
    ],
    [
      "Make it land",
      <>
        The Arena runs it 3 times against two scripted reference agents. It must breach the
        undefended one in 2 of 3 runs; beating the defended one earns the top reward. You can{" "}
        <a
          href={`${REPO}/docs/BOUNTIES.md#try-it-locally-first`}
          className={linkClass}
          target="_blank"
          rel="noreferrer"
        >
          try it locally first
        </a>
        .
      </>,
    ],
    [
      "Commit",
      "The page checks your spec first; once committed it can't change. Save the salt: you need it to reveal.",
    ],
    ["Reveal, then send for validation", "One click each, from the same wallet."],
    [
      "Watch the result",
      "Validation takes a few minutes. The result shows below with its reason, and a reward goes straight to your wallet.",
    ],
  ];
  return (
    <Card title="How to submit an attack">
      <ol className="flex flex-col gap-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[28px_1fr] gap-3 text-sm">
            <span className="flex size-7 items-center justify-center rounded-full border border-line-strong font-mono text-xs text-accent">
              {i + 1}
            </span>
            <span className="leading-relaxed text-muted [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-soft">
              <strong className="block text-ink">{title}</strong>
              {text}
            </span>
          </li>
        ))}
      </ol>
      <details className="mt-5 rounded-2xl border border-line p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Attack classes and their surfaces
        </summary>
        <div className="mt-3 flex flex-col">
          {Object.entries(ATTACK_CLASSES).map(([id, c]) => (
            <div
              key={id}
              className="grid grid-cols-[40px_minmax(0,1fr)] gap-2 border-t border-line py-2 text-xs"
            >
              <span className="font-mono text-muted">{id}</span>
              <span>
                {c.name}
                <span className="block font-mono text-muted">{c.surfaces.join(", ")}</span>
              </span>
            </div>
          ))}
        </div>
      </details>
    </Card>
  );
}

function Submit() {
  const { address } = useAccount();
  const [yaml, setYaml] = useState("");
  const [salt, setSalt] = useState<string>(() => newSalt());
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const spec = useQuery({
    queryKey: ["spec-uri", yaml],
    enabled: yaml.trim().length > 0,
    queryFn: () => specUriOf(yaml),
  });
  const check = useMemo(() => checkSpec(yaml), [yaml]);
  // Never encode a half-typed salt: viem throws, which would take the page down.
  const saltOk = isSalt(salt);
  const commitment = commitmentIfReady(address, spec.data, salt);
  const committed = useCommitId(commitment);
  const id = committed.data;
  const onChain = useReadContract({
    address: deployment.bountyBoard,
    abi: bountyBoardAbi,
    functionName: "getSubmission",
    args: id === undefined ? undefined : [id],
    query: { enabled: id !== undefined },
  });
  const status = onChain.data?.status;
  const { send, busy, view } = useSend();

  async function validate() {
    setError(null);
    setResult(null);
    try {
      const r = await api.revealBounty(id!.toString(), yaml);
      setResult(r.created ? "Sent: the Arena is validating it." : `Already sent: ${r.status}.`);
    } catch (e) {
      setError(e);
    }
  }

  const stage = id === undefined ? 1 : status === 1 ? 2 : status === 2 ? 3 : 4;
  return (
    <Card
      title="Submit an attack"
      description="Committing first timestamps your attack without revealing it, so nobody can copy it before you reveal."
    >
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="flex items-center justify-between font-medium text-soft">
          Attack spec (YAML)
          {!yaml.trim() && (
            <Button kind="ghost" size="sm" onClick={() => setYaml(BOUNTY_SPEC_EXAMPLE)}>
              Insert the example
            </Button>
          )}
        </span>
        <textarea
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          rows={13}
          spellCheck={false}
          className={`rounded-2xl border bg-black/30 p-4 font-mono text-xs leading-relaxed text-ink outline-none focus:border-accent focus:ring-3 focus:ring-accent/15 ${check && "error" in check ? "border-breach" : "border-line-strong"}`}
        />
      </label>
      {check && "spec" in check && (
        <p className="mt-2 text-xs text-safe">
          ✓ Passes the API's checks: {check.spec.class} via {check.spec.surfaces.join(", ")}.
        </p>
      )}
      {check && "error" in check && (
        <p className="mt-2 text-xs text-breach">
          Fix this before committing: {check.error}. A committed spec can't be edited.
        </p>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input
          label="Salt (save it)"
          value={salt}
          onChange={setSalt}
          error={saltOk ? null : "The salt must be 0x and 64 hex digits."}
        />
        <div className="flex min-w-0 flex-col gap-1.5 text-sm">
          <span className="font-medium text-soft">Spec URI</span>
          <span className="font-mono text-xs break-all text-muted">{spec.data ?? "—"}</span>
        </div>
      </div>

      {!address ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <ConnectButton />
          <span className="text-sm text-muted">Connect a wallet to submit.</span>
        </div>
      ) : (
        <div className="mt-5 grid gap-2 border-t border-line pt-5 sm:grid-cols-3">
          <Button
            kind={stage === 1 ? "primary" : "secondary"}
            disabled={!commitment || !(check && "spec" in check) || busy || id !== undefined}
            onClick={() =>
              void send([
                {
                  label: "Commit",
                  address: deployment.bountyBoard,
                  abi: bountyBoardAbi,
                  functionName: "commit",
                  args: [commitment!],
                },
              ])
            }
          >
            1. Commit
          </Button>
          <Button
            kind={stage === 2 ? "primary" : "secondary"}
            disabled={busy || !saltOk || id === undefined || status !== 1}
            onClick={() =>
              void send([
                {
                  label: "Reveal",
                  address: deployment.bountyBoard,
                  abi: bountyBoardAbi,
                  functionName: "reveal",
                  args: [id!, spec.data!, salt as Hex],
                },
              ])
            }
          >
            2. Reveal
          </Button>
          <Button
            kind={stage === 3 ? "primary" : "secondary"}
            disabled={busy || status !== 2}
            onClick={() => void validate()}
          >
            3. Validate
          </Button>
        </div>
      )}
      {id !== undefined && (
        <p className="mt-3 text-sm text-muted">
          Submission {id.toString()} · on chain:{" "}
          {["none", "committed", "revealed", "accepted", "rejected"][status ?? 0]}
        </p>
      )}
      <div className="mt-2">{view}</div>
      {result && <p className="mt-2 text-sm">{result}</p>}
      <ErrorText error={error} />
    </Card>
  );
}

export function Bounties() {
  const list = useQuery({ queryKey: ["bounties"], queryFn: api.bounties, refetchInterval: 15_000 });
  const pool = useReadContract({
    address: deployment.usdg,
    abi: testTokenAbi,
    functionName: "balanceOf",
    args: [deployment.bountyBoard],
  });
  return (
    <Page
      eyebrow="For attack researchers"
      title="Bounties"
      intro="Find an attack our library misses and get paid. The Arena tests every submission against reference agents, and the reward follows a fixed rule. Accepted attacks join the library, and every agent is re-rated against them."
    >
      <section className="grid gap-4 md:grid-cols-3">
        <div className="panel bg-[radial-gradient(ellipse_at_0%_0%,rgb(29_78_216/.22),transparent_60%)] p-6">
          <p className="eyebrow">Bounty pool</p>
          <p className="mt-2 font-serif text-5xl leading-none tabular-nums">
            {pool.data === undefined ? "…" : `$${usd(pool.data, 0)}`}
          </p>
          <p className="mt-1.5 text-xs text-muted">tUSDG, funded by 5% of every premium</p>
        </div>
        <div className="panel p-6">
          <p className="eyebrow">Beat the defended agent</p>
          <p className="mt-2 font-serif text-5xl leading-none">$2,000</p>
          <p className="mt-1.5 text-xs text-muted">the top reward</p>
        </div>
        <div className="panel p-6">
          <p className="eyebrow">Open a new class and surface</p>
          <p className="mt-2 font-serif text-5xl leading-none">$500</p>
          <p className="mt-1.5 text-xs text-muted">against the undefended agent</p>
        </div>
      </section>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Guide />
        <Submit />
      </div>
      <Card
        title="Submissions"
        actions={<span className="text-xs text-muted">Payloads stay private.</span>}
      >
        {list.isPending && !list.error && <Loading what="bounties" />}
        <ErrorText error={list.error} />
        {list.data?.length === 0 && (
          <EmptyState title="No submissions yet">
            Be the first to find an attack we miss.
          </EmptyState>
        )}
        <ul className="flex flex-col gap-3">
          {list.data?.map((b) => (
            <li key={b.submissionId} className="rounded-2xl border border-line p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <span className="font-mono text-muted">#{b.submissionId}</span>{" "}
                  <span className="font-semibold">{b.title}</span>{" "}
                  <span className="text-muted">
                    · {b.attackClass} via {b.surfaces.join(", ")}
                  </span>
                </span>
                <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-muted">
                <span>Hunter {short(b.hunter)}</span>
                {b.reward && b.reward !== "0" && (
                  <span className="text-safe">Reward ${usd(BigInt(b.reward))}</span>
                )}
                {b.reason && <span>{b.reason}</span>}
                {b.txHash && <TxLink hash={b.txHash} />}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}

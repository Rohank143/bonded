import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { getAbiItem, type Hex } from "viem";
import { bountyBoardAbi, testTokenAbi } from "@bonded/shared";
import { deployment } from "../config";
import { api, type BountyRecord } from "../lib/api";
import { commitmentIfReady, isSalt, newSalt, specUriOf } from "../lib/bounty";
import { short, usd } from "../lib/format";
import { useSend } from "../components/wallet";
import { Badge, Button, Card, ErrorText, Input, Loading, Page, TxLink } from "../components/ui";

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

  return (
    <Card title="Submit an attack">
      <p className="text-sm text-muted">
        Write the attack in the library's YAML format (see <code>attacks/</code> in the repository).
        Committing first timestamps it without revealing it, so nobody can copy it before you
        reveal. Keep the salt: you need it to reveal.
      </p>
      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="text-muted">Attack spec (YAML)</span>
        <textarea
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          rows={10}
          spellCheck={false}
          className="rounded-md border border-line bg-transparent p-2 font-mono text-xs outline-none focus:border-accent"
        />
      </label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Input label="Salt (save it)" value={salt} onChange={setSalt} />
          {!saltOk && (
            <span className="text-xs text-breach">The salt must be 0x and 64 hex digits.</span>
          )}
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Spec URI</span>
          <span className="break-all font-mono text-xs">{spec.data ?? "—"}</span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={!address || !commitment || busy || id !== undefined}
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
          2. Reveal on chain
        </Button>
        <Button disabled={busy || status !== 2} onClick={() => void validate()}>
          3. Send for validation
        </Button>
        {id !== undefined && (
          <span className="text-sm text-muted">
            Submission {id.toString()} · status on chain:{" "}
            {["none", "committed", "revealed", "accepted", "rejected"][status ?? 0]}
          </span>
        )}
      </div>
      {!address && <p className="mt-2 text-sm text-muted">Connect a wallet to submit.</p>}
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
      title="Bounties"
      intro="Find an attack the library misses and get paid from the bounty pool, which 5% of every premium funds. The Arena checks each submission against reference agents in its sandbox and the attester pays by a fixed rule: 2,000 tUSDG if it beats the defended agent, 500 tUSDG if it opens a new class and surface. Accepted attacks join the library, and every agent is re-rated against them."
    >
      <Card title="Bounty pool">
        <p className="text-2xl tabular-nums">
          {pool.data === undefined ? "—" : `$${usd(pool.data)}`}
        </p>
      </Card>
      <Submit />
      <Card title="Submissions">
        {list.isLoading && <Loading what="bounties" />}
        <ErrorText error={list.error} />
        {list.data?.length === 0 && <p className="text-sm text-muted">No submissions yet.</p>}
        <ul className="flex flex-col gap-3">
          {list.data?.map((b) => (
            <li key={b.submissionId} className="rounded-md border border-line p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  #{b.submissionId} · <span className="font-medium">{b.title}</span> ·{" "}
                  {b.attackClass} via {b.surfaces.join(", ")}
                </span>
                <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted">
                <span>Hunter {short(b.hunter)}</span>
                {b.reward && b.reward !== "0" && <span>Reward ${usd(BigInt(b.reward))}</span>}
                {b.reason && <span>{b.reason}</span>}
                {b.txHash && <TxLink hash={b.txHash} />}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Payloads stay private; see the disclosure policy in the repository.
        </p>
      </Card>
    </Page>
  );
}

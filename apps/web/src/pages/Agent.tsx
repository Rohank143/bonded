import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import { bondedRegistryAbi, operatorBondAbi, tierForScore } from "@bonded/shared";
import { apiUrl, deployment } from "../config";
import { ApiError, api } from "../lib/api";
import { liveCheckView, teeView } from "../lib/tee";
import { isRpcUnavailable } from "../lib/errors";
import { apiLookups, isRegistered } from "../lib/agent";
import { OwnerTools } from "../components/owner-tools";
import { bps, usd, when } from "../lib/format";
import { tierMeaning } from "../lib/glossary";
import {
  AddressLink,
  Badge,
  Card,
  Details,
  EmptyState,
  ErrorText,
  LinkButton,
  Loading,
  Page,
  Stat,
  Table,
  Term,
  TierBadge,
  TxLink,
  Unavailable,
  linkClass,
  tierTone,
} from "../components/ui";

export function Agent() {
  const id = useParams().id ?? "";
  const valid = /^\d+$/.test(id);
  const agentId = valid ? BigInt(id) : 0n;
  const reads = useReadContracts({
    contracts: [
      {
        address: deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "scoreOf",
        args: [agentId],
      },
      {
        address: deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "agentOwner",
        args: [agentId],
      },
      { address: deployment.bond, abi: operatorBondAbi, functionName: "bondOf", args: [agentId] },
      {
        address: deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "hasValidScore",
        args: [agentId],
      },
    ],
    query: { enabled: valid },
  });
  const [onchain, owner, bond, fresh] = reads.data ?? [];
  const a = onchain?.result;
  const lookups = apiLookups(a);
  const rated = lookups.rated;
  const score = useQuery({
    queryKey: ["score", id],
    queryFn: () => api.score(id),
    enabled: valid && lookups.score,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const run = useQuery({
    queryKey: ["run", score.data?.runId],
    queryFn: () => api.run(score.data!.runId),
    enabled: Boolean(score.data?.runId),
  });

  const liveCheck = useQuery({
    queryKey: ["tee", id],
    queryFn: () => api.tee(id),
    enabled: valid && lookups.tee,
    refetchInterval: 60_000,
    retry: false,
  });

  const back = { to: "/agents", label: "All agents" };
  if (!valid)
    return (
      <Page title="Agent" back={back}>
        <EmptyState title="That isn't an agent ID">Agent IDs are whole numbers.</EmptyState>
      </Page>
    );
  if (reads.isLoading)
    return (
      <Page title={`Agent ${id}`} back={back}>
        <Card>
          <Loading what={`agent ${id}`} lines={5} />
        </Card>
      </Page>
    );
  const readError = reads.error ?? [onchain, owner, bond, fresh].find((r) => r?.error)?.error;
  if (reads.isError || isRpcUnavailable(readError))
    return (
      <Page title={`Agent ${id}`} back={back}>
        <Unavailable error={readError} onRetry={() => void reads.refetch()} />
      </Page>
    );
  if (owner?.error || !isRegistered(owner?.result))
    return (
      <Page title={`Agent ${id}`} back={back}>
        <EmptyState
          title={`No agent ${id} on this chain`}
          action={<LinkButton to="/agents">See all agents</LinkButton>}
        />
      </Page>
    );
  const report = run.data?.report;
  const tee = teeView(a?.teeMeasurement, report);
  const tier = rated && a ? tierForScore(a.score).tier : undefined;
  return (
    <Page
      title={`Agent ${id}`}
      eyebrow="Agent profile"
      back={back}
      intro="The score is the latest attestation in BondedRegistry. Cover is priced from it."
    >
      <Card>
        {rated && a ? (
          <div className="grid gap-8 lg:grid-cols-[auto_1fr] lg:items-center">
            <div className="flex items-center gap-5">
              <ScoreRing score={a.score} />
              <div>
                <p className="text-xs font-medium text-muted">Bonded Score</p>
                <p className="mt-1 flex items-center gap-2">
                  <TierBadge score={a.score} />
                  {fresh?.result ? (
                    <Badge tone="safe" dot>
                      valid
                    </Badge>
                  ) : (
                    <Badge tone="warn" dot>
                      expired
                    </Badge>
                  )}
                </p>
                <p className="mt-2 max-w-56 text-xs text-muted">{tierMeaning(tier!)}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 lg:border-l lg:border-line lg:pl-8">
              <Stat
                label={<Term term="expectedLoss">Expected loss</Term>}
                value={bps(a.expectedLossBps)}
                hint="per year, of cover"
              />
              <Stat
                label={<Term term="bond">Operator bond</Term>}
                value={bond?.result !== undefined ? `$${usd(bond.result, 0)}` : "…"}
                hint="pays first on a claim"
              />
              <Stat label="Expires" value={<span className="text-lg">{when(a.expiresAt)}</span>} />
              <Stat
                label={<Term term="tee">Key custody</Term>}
                value={
                  tee.inTee ? (
                    <Badge tone="safe">TEE</Badge>
                  ) : (
                    <Badge tone="neutral">Operator</Badge>
                  )
                }
                hint={
                  tee.inTee ? "key generated inside Intel TDX" : "key held on the operator's server"
                }
              />
            </div>
          </div>
        ) : (
          <EmptyState title="Not rated yet">
            Its owner can ask for a rating from this page once it's registered for ratings.
          </EmptyState>
        )}
        <Details>
          <dt>Owner</dt>
          <dd>{owner?.result ? <AddressLink address={owner.result} /> : "…"}</dd>
          {rated && a && (
            <>
              <dt>Issued</dt>
              <dd>{when(a.issuedAt)}</dd>
              <dt>
                <Term term="reportHash">Report hash</Term>
              </dt>
              <dd className="font-mono text-xs break-all">{a.reportHash}</dd>
              <dt>
                <Term term="mandate">Mandate hash</Term>
              </dt>
              <dd className="font-mono text-xs break-all">{a.mandateHash}</dd>
              {tee.measurement && (
                <>
                  <dt>
                    <Term term="teeMeasurement">TEE measurement</Term>
                  </dt>
                  <dd className="font-mono text-xs break-all">{tee.measurement}</dd>
                </>
              )}
              {tee.measurement && (
                <>
                  <dt>TEE live check</dt>
                  <dd>
                    {(() => {
                      const view = liveCheckView(
                        liveCheck.data?.status,
                        liveCheck.data?.blockingStatus,
                      );
                      return (
                        <>
                          <Badge tone={view.tone}>{view.label}</Badge>{" "}
                          <span className="text-xs text-muted">
                            {view.hint}
                            {liveCheck.data?.verifiedAt
                              ? `; last verified ${when(Date.parse(liveCheck.data.verifiedAt) / 1000)}`
                              : ""}
                          </span>
                        </>
                      );
                    })()}
                  </dd>
                </>
              )}
              {tee.keys && (
                <>
                  <dt>TEE session keys</dt>
                  <dd className="font-mono text-xs break-all">
                    {tee.keys.evm} (EVM)
                    <br />
                    {tee.keys.solana} (Solana)
                  </dd>
                </>
              )}
            </>
          )}
          {score.data && (
            <>
              <dt>Posted in</dt>
              <dd>
                <TxLink hash={score.data.tx_hash} />
              </dd>
              <dt>Full report</dt>
              <dd>
                <a
                  className={linkClass}
                  href={`${apiUrl}/arena/runs/${score.data.runId}/report`}
                  target="_blank"
                  rel="noreferrer"
                >
                  JSON (hashes to the report hash above)
                </a>
              </dd>
            </>
          )}
        </Details>
        {score.error && !(score.error instanceof ApiError && score.error.status === 404) && (
          <ErrorText error={score.error} />
        )}
      </Card>

      <OwnerTools agentId={id} owner={owner?.result} />

      {report && (
        <Card
          title="Attack classes"
          description={
            <>
              {report.episodes.attacks} attacks and {report.episodes.controls} controls,{" "}
              {report.mandateMode} mode,{" "}
              {report.forked ? "on a fork of the live chain" : "on a local chain"}.{" "}
              {report.unpublished?.episodes
                ? `${report.unpublished.episodes} of the attack episodes ran ${report.unpublished.attacks} unpublished attacks (held out, or accepted bounties) that the operator couldn't study in advance.`
                : "Published attacks only: an in-library result, not a held-out evaluation."}
            </>
          }
        >
          <Table>
            <thead>
              <tr>
                <th>Class</th>
                <th className="text-right">Episodes</th>
                <th className="text-right">Breaches</th>
                <th className="w-2/5 pl-6">Held</th>
              </tr>
            </thead>
            <tbody>
              {report.classes.map((c) => {
                const held = c.episodes ? (c.episodes - c.breaches) / c.episodes : 1;
                return (
                  <tr key={c.class}>
                    <td>
                      <span className="mr-2 inline-block w-8 font-mono text-xs text-muted">
                        {c.class}
                      </span>
                      {c.name}
                    </td>
                    <td className="text-right tabular-nums">{c.episodes}</td>
                    <td
                      className={`text-right tabular-nums ${c.breaches ? "font-semibold text-breach" : ""}`}
                    >
                      {c.breaches}
                    </td>
                    <td className="pl-6">
                      <div className="flex items-center gap-3">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-breach/25">
                          <div
                            className="h-2 rounded-full bg-safe"
                            style={{ width: `${held * 100}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs text-muted tabular-nums">
                          {Math.round(held * 100)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}

/** The score as a ring that fills to it, coloured by tier. */
function ScoreRing({ score }: { score: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const colour = { safe: "text-safe", warn: "text-warn", breach: "text-breach" }[
    tierTone(score) as "safe" | "warn" | "breach"
  ];
  return (
    <div className="relative size-28 shrink-0">
      <svg viewBox="0 0 100 100" className="size-28 -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="8" className="stroke-sunken" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          className={`stroke-current ${colour}`}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-semibold tracking-tight tabular-nums">{score}</span>
        <span className="text-[10px] font-medium text-muted">of 100</span>
      </span>
    </div>
  );
}

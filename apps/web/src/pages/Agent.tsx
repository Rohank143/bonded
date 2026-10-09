import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import { bondedRegistryAbi, operatorBondAbi, tierForScore } from "@bondedhq/shared";
import { apiUrl, deployment } from "../config";
import { ApiError, api } from "../lib/api";
import { liveCheckView, teeView } from "../lib/tee";
import { isRpcUnavailable } from "../lib/errors";
import { apiLookups, isRegistered } from "../lib/agent";
import { OwnerTools } from "../components/owner-tools";
import { bps, usd, when } from "../lib/format";
import {
  AddressLink,
  Badge,
  Card,
  ErrorText,
  Grid,
  Loading,
  Page,
  Stat,
  TxLink,
  Unavailable,
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

  if (!valid) return <Page title="Agent">Agent IDs are whole numbers.</Page>;
  if (reads.isLoading) return <Loading what={`agent ${id}`} />;
  const readError = reads.error ?? [onchain, owner, bond, fresh].find((r) => r?.error)?.error;
  if (reads.isError || isRpcUnavailable(readError))
    return (
      <Page title={`Agent ${id}`}>
        <Unavailable error={readError} onRetry={() => void reads.refetch()} />
      </Page>
    );
  if (owner?.error || !isRegistered(owner?.result))
    return (
      <Page title={`Agent ${id}`}>
        <p className="text-sm text-muted">
          No agent {id} is registered on this chain. See the{" "}
          <Link to="/agents" className="text-accent hover:underline">
            agents directory
          </Link>{" "}
          for registered agents.
        </p>
      </Page>
    );
  const report = run.data?.report;
  const tee = teeView(a?.teeMeasurement, report);
  return (
    <Page
      title={`Agent ${id}`}
      intro="The score is the latest attestation in BondedRegistry. Cover is priced from it."
    >
      <Link to="/agents" className="w-fit text-sm text-accent hover:underline">
        ← Back to agents
      </Link>
      <Card title="Bonded Score">
        {rated && a ? (
          <Grid>
            <Stat label="Score" value={a.score} hint={`tier ${tierForScore(a.score).tier}`} />
            <Stat label="Expected loss" value={bps(a.expectedLossBps)} hint="per year, of cover" />
            <Stat
              label="Operator bond"
              value={bond?.result !== undefined ? `$${usd(bond.result, 0)}` : "…"}
              hint="pays first on a claim"
            />
            <Stat
              label="Status"
              value={
                fresh?.result ? (
                  <Badge tone="safe">valid</Badge>
                ) : (
                  <Badge tone="breach">expired</Badge>
                )
              }
              hint={`expires ${when(a.expiresAt)}`}
            />
            <Stat
              label="Key custody"
              value={
                tee.inTee ? <Badge tone="safe">TEE</Badge> : <Badge tone="neutral">Operator</Badge>
              }
              hint={
                tee.inTee ? "key generated inside Intel TDX" : "key held on the operator's server"
              }
            />
          </Grid>
        ) : (
          <p className="text-sm text-muted">Not rated yet.</p>
        )}
        <dl className="mt-4 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">Owner</dt>
          <dd>{owner?.result ? <AddressLink address={owner.result} /> : "…"}</dd>
          {rated && a && (
            <>
              <dt className="text-muted">Issued</dt>
              <dd>{when(a.issuedAt)}</dd>
              <dt className="text-muted">Report hash</dt>
              <dd className="break-all font-mono text-xs">{a.reportHash}</dd>
              <dt className="text-muted">Mandate hash</dt>
              <dd className="break-all font-mono text-xs">{a.mandateHash}</dd>
              {tee.measurement && (
                <>
                  <dt className="text-muted">TEE measurement</dt>
                  <dd className="break-all font-mono text-xs">{tee.measurement}</dd>
                </>
              )}
              {tee.measurement && (
                <>
                  <dt className="text-muted">TEE live check</dt>
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
                  <dt className="text-muted">TEE session keys</dt>
                  <dd className="break-all font-mono text-xs">
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
              <dt className="text-muted">Posted in</dt>
              <dd>
                <TxLink hash={score.data.tx_hash} />
              </dd>
              <dt className="text-muted">Full report</dt>
              <dd>
                <a
                  className="text-accent hover:underline"
                  href={`${apiUrl}/arena/runs/${score.data.runId}/report`}
                  target="_blank"
                  rel="noreferrer"
                >
                  JSON (hashes to the report hash above)
                </a>
              </dd>
            </>
          )}
        </dl>
        {score.error && !(score.error instanceof ApiError && score.error.status === 404) && (
          <ErrorText error={score.error} />
        )}
      </Card>

      <OwnerTools agentId={id} owner={owner?.result} />

      {report && (
        <Card title="Attack classes">
          <p className="mb-3 text-sm text-muted">
            {report.episodes.attacks} attacks and {report.episodes.controls} controls,{" "}
            {report.mandateMode} mode,{" "}
            {report.forked ? "on a fork of the live chain" : "on a local chain"}. Fixed seeds: an
            in-library result, not a held-out evaluation.
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 font-normal">Class</th>
                <th className="font-normal">Episodes</th>
                <th className="font-normal">Breaches</th>
                <th className="w-1/3 font-normal">Held</th>
              </tr>
            </thead>
            <tbody>
              {report.classes.map((c) => {
                const held = c.episodes ? (c.episodes - c.breaches) / c.episodes : 1;
                return (
                  <tr key={c.class} className="border-t border-line">
                    <td className="py-1.5">
                      <span className="font-mono">{c.class}</span> {c.name}
                    </td>
                    <td className="tabular-nums">{c.episodes}</td>
                    <td className={c.breaches ? "tabular-nums text-breach" : "tabular-nums"}>
                      {c.breaches}
                    </td>
                    <td>
                      <div className="h-2 rounded bg-breach/30">
                        <div className="h-2 rounded bg-safe" style={{ width: `${held * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}

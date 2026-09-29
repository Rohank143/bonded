import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import {
  bondedRegistryAbi,
  coverManagerAbi,
  coverPoolAbi,
  mandateVaultFactoryAbi,
} from "@bonded/shared";
import { deployment } from "../config";
import { api } from "../lib/api";
import { useClaims } from "../lib/chain";
import { usd } from "../lib/format";
import { Card, Grid, Page, Stat } from "../components/ui";

export function Landing() {
  const reads = useReadContracts({
    contracts: [
      { address: deployment.registry, abi: bondedRegistryAbi, functionName: "totalAgents" },
      { address: deployment.factory, abi: mandateVaultFactoryAbi, functionName: "vaultCount" },
      { address: deployment.pool, abi: coverPoolAbi, functionName: "totalAssets" },
      { address: deployment.coverManager, abi: coverManagerAbi, functionName: "totalActiveCover" },
    ],
    query: { refetchInterval: 15_000 },
  });
  const claims = useClaims();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const [agents, vaults, tvl, cover] = reads.data ?? [];
  const paid = claims.data?.reduce((sum, c) => sum + c.payout, 0n) ?? 0n;
  const show = (r: { result?: unknown } | undefined, f: (v: bigint) => string) =>
    r?.result === undefined ? "…" : f(r.result as bigint);
  return (
    <Page
      title="Insurance for AI trading agents"
      intro="Bonded red-teams an agent in the Arena, publishes a safety score on chain, prices cover from that score, and pays automatically when the agent breaks its mandate. Payouts are decided by the vault's on-chain breach log, never by an AI."
    >
      <Card title="Live on Robinhood Chain testnet">
        <Grid>
          <Stat label="Agents registered" value={show(agents, String)} />
          <Stat label="Mandate vaults" value={show(vaults, String)} />
          <Stat label="Cover pool" value={show(tvl, (v) => `$${usd(v, 0)}`)} hint="tUSDG" />
          <Stat label="Active cover" value={show(cover, (v) => `$${usd(v, 0)}`)} />
          <Stat label="Claims paid" value={claims.data ? String(claims.data.length) : "…"} />
          <Stat label="Paid out" value={claims.data ? `$${usd(paid, 0)}` : "…"} />
          <Stat
            label="Services"
            value={health.isError ? "down" : health.data?.ok ? "online" : "…"}
            hint={health.data ? `chain ${health.data.chainId}` : undefined}
          />
        </Grid>
      </Card>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["/arena", "Arena", "Watch attacks run against an agent, live."],
          ["/vaults", "Vaults", "Deposit, see cover and the breach log, buy cover."],
          ["/underwrite", "Underwrite", "Back the pool that pays claims and earn premiums."],
          ["/claims", "Claims", "Every automatic payout, with where the money came from."],
          ["/agents/2", "Agent 2", "The Gate 1 agent: score, tier, report."],
        ].map(([to, name, text]) => (
          <Link key={to} to={to!} className="rounded-lg border border-line p-4 hover:border-accent">
            <div className="font-semibold">{name}</div>
            <div className="text-sm text-muted">{text}</div>
          </Link>
        ))}
      </div>
    </Page>
  );
}

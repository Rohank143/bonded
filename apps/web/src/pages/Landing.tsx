import type { ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import {
  bondedRegistryAbi,
  coverManagerAbi,
  coverPoolAbi,
  mandateVaultFactoryAbi,
} from "@bondedhq/shared";
import { deployment, isLocal, networkName } from "../config";
import { api } from "../lib/api";
import { useClaims, waterfall } from "../lib/chain";
import { short, usd } from "../lib/format";
import { Card, LinkButton, Skeleton, TierBadge, TxLink, linkClass } from "../components/ui";

const STEPS = [
  {
    title: "Attack it in the Arena",
    text: "We plant prompt injections, poisoned token data and fake instructions in everything the agent reads, then watch what it does with real contracts on a private fork.",
  },
  {
    title: "Score it on chain",
    text: "The results become a Bonded Score from 0 to 100, signed and posted to the registry with a hash of the full report anyone can check.",
  },
  {
    title: "Price the cover",
    text: "Depositors can buy cover for the agent's vault. Safer agents pay less, and the operator stakes a bond that pays first.",
  },
  {
    title: "Pay automatically",
    text: "If the agent breaks its mandate, the vault records the breach and the contracts pay the claim. No forms, no adjuster, no AI deciding.",
  },
];

const AUDIENCES = [
  {
    to: "/agents/new",
    who: "Agent operators",
    text: "Get your agent rated, give it a vault and a bond, and let depositors trust it with money.",
    cta: "Onboard an agent",
  },
  {
    to: "/vaults",
    who: "Depositors",
    text: "Put funds behind a rated agent and buy cover, so a tricked agent doesn't cost you.",
    cta: "Browse vaults",
  },
  {
    to: "/underwrite",
    who: "Underwriters",
    text: "Back the pool that pays claims, and earn 80% of every premium.",
    cta: "Underwrite cover",
  },
  {
    to: "/bounties",
    who: "Attack researchers",
    text: "Find an attack our library misses and get paid when it lands.",
    cta: "Hunt bounties",
  },
];

export function Landing() {
  return (
    <div className="flex flex-col gap-16 sm:gap-20">
      <Hero />
      <HowItWorks />
      <Audiences />
      <Proof />
    </div>
  );
}

function Hero() {
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
  const [agents, vaults, tvl, cover] = reads.data ?? [];
  const paid = claims.data?.reduce((sum, c) => sum + c.payout, 0n) ?? 0n;
  // "unavailable" rather than a spinner that never ends when the chain or the API can't be read.
  const show = (r: { result?: unknown; error?: unknown } | undefined, f: (v: bigint) => string) =>
    r?.result !== undefined
      ? f(r.result as bigint)
      : reads.isError || r?.error
        ? "unavailable"
        : undefined;
  const fromClaims = (f: (c: NonNullable<typeof claims.data>) => string) =>
    claims.data ? f(claims.data) : claims.isError ? "unavailable" : undefined;
  return (
    <section className="relative isolate overflow-hidden rounded-3xl bg-[#0f1419] px-6 py-12 text-[#f7f6f2] ring-1 ring-white/5 sm:px-12 sm:py-16 lg:px-16">
      <div
        className="pointer-events-none absolute -bottom-40 -left-20 -z-10 size-[28rem] rounded-full bg-[#1d4ed8] opacity-25 blur-[120px]"
        aria-hidden
      />
      <div className="grid items-center gap-12 lg:grid-cols-[1.25fr_1fr]">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/8 px-3 py-1 text-xs font-medium text-white/80 ring-1 ring-white/10">
            <span className="size-1.5 rounded-full bg-[#4cc38a]" aria-hidden />
            Live on {networkName}
          </p>
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-[-0.035em] sm:text-6xl">
            Don't cage your agent.
            <br />
            <span className="text-[#7b9bff]">Bond it.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/70">
            Bonded attacks AI trading agents before they touch your money, publishes a safety score
            on chain, and pays you back automatically if one is tricked into breaking its rules.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton to="/leaderboard" size="lg">
              See how agents score
            </LinkButton>
            <Link
              to="/agents/new"
              className="inline-flex h-12 items-center rounded-lg px-5 font-medium text-white ring-1 ring-white/20 transition-colors hover:bg-white/10"
            >
              Onboard an agent
            </Link>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-white/10 ring-1 ring-white/10">
          <HeroStat label="Agents registered" value={show(agents, String)} />
          <HeroStat label="Mandate vaults" value={show(vaults, String)} />
          <HeroStat label="Cover pool" value={show(tvl, (v) => `$${usd(v, 0)}`)} />
          <HeroStat label="Active cover" value={show(cover, (v) => `$${usd(v, 0)}`)} />
          <HeroStat label="Claims paid" value={fromClaims((c) => String(c.length))} />
          <HeroStat label="Paid out" value={fromClaims(() => `$${usd(paid, 0)}`)} />
        </dl>
      </div>
    </section>
  );
}

function HeroStat({ label, value }: { label: string; value?: string }) {
  return (
    <div className="bg-[#0f1419]/95 p-5">
      <dt className="text-xs font-medium text-white/55">{label}</dt>
      <dd className="mt-1.5 truncate text-2xl font-semibold tracking-tight tabular-nums">
        {value ?? <span className="block h-7 w-20 animate-pulse rounded bg-white/10" />}
      </dd>
    </div>
  );
}

function SectionHead({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-8 max-w-2xl">
      <p className="mb-2 text-xs font-semibold tracking-[0.12em] text-accent uppercase">
        {eyebrow}
      </p>
      <h2 className="text-3xl font-semibold tracking-tight">{title}</h2>
      {children && <p className="mt-3 text-base text-muted">{children}</p>}
    </div>
  );
}

function HowItWorks() {
  return (
    <section>
      <SectionHead eyebrow="How it works" title="From red team to payout, in four steps">
        Every step is on chain or reproducible. AI helps find the attacks; it never decides who gets
        paid.
      </SectionHead>
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            className="relative rounded-(--radius-card) border border-line bg-surface p-6 shadow-(--shadow-card)"
          >
            <span className="mb-5 inline-flex size-9 items-center justify-center rounded-lg bg-brand text-sm font-semibold text-on-brand tabular-nums">
              {i + 1}
            </span>
            <h3 className="text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{s.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Audiences() {
  return (
    <section>
      <SectionHead eyebrow="Who it's for" title="Pick your side of the bond" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {AUDIENCES.map((a) => (
          <Link
            key={a.to}
            to={a.to}
            className="group flex flex-col rounded-(--radius-card) border border-line bg-surface p-6 shadow-(--shadow-card) transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-(--shadow-raised)"
          >
            <h3 className="text-lg font-semibold">{a.who}</h3>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{a.text}</p>
            <span className="mt-5 text-sm font-medium text-accent">
              {a.cta}{" "}
              <span
                aria-hidden
                className="inline-block transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Proof() {
  const board = useQuery({ queryKey: ["leaderboard"], queryFn: api.leaderboard });
  const claims = useClaims();
  const top = board.data
    ? [...board.data.entries].sort((a, b) => b.score - a.score).slice(0, 3)
    : undefined;
  const latest = claims.data?.[0];
  const w = latest ? waterfall(latest) : undefined;
  return (
    <section>
      <SectionHead eyebrow="Live proof" title="Real scores, real payouts" />
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card
          title="Top of the leaderboard"
          actions={
            <Link to="/leaderboard" className={`text-sm ${linkClass}`}>
              Full leaderboard →
            </Link>
          }
        >
          {!top ? (
            board.isError ? (
              <p className="text-sm text-muted">The leaderboard is unavailable right now.</p>
            ) : (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            )
          ) : (
            <ol className="flex flex-col divide-y divide-line">
              {top.map((e, i) => (
                <li key={e.slug} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                  <span className="w-5 text-sm text-muted tabular-nums">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{e.name}</p>
                    <p className="truncate text-xs text-muted">
                      {e.framework}
                      {e.model ? ` · ${e.model}` : ""}
                    </p>
                  </div>
                  <span className="text-xl font-semibold tabular-nums">{e.score}</span>
                  <TierBadge score={e.score} />
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card
          title="Latest claim paid"
          actions={
            <Link to="/claims" className={`text-sm ${linkClass}`}>
              All claims →
            </Link>
          }
        >
          {!claims.data ? (
            claims.isError ? (
              <p className="text-sm text-muted">Claims are unavailable right now.</p>
            ) : (
              <Skeleton className="h-24" />
            )
          ) : !latest || !w ? (
            <p className="text-sm text-muted">
              No claims yet. When a covered agent breaks its mandate, the payout shows up here.
            </p>
          ) : (
            <div>
              <p className="text-4xl font-semibold tracking-tight tabular-nums">
                ${usd(w.toVault, 0)}
              </p>
              <p className="mt-1 text-sm text-muted">
                paid to vault{" "}
                <Link to={`/vaults/${latest.vault}`} className={`font-mono ${linkClass}`}>
                  {short(latest.vault)}
                </Link>{" "}
                with no one filing a form.
              </p>
              <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm">
                <div>
                  <dt className="text-muted">From the operator's bond</dt>
                  <dd className="font-medium tabular-nums">${usd(w.fromBond, 0)}</dd>
                </div>
                <div>
                  <dt className="text-muted">From the pool</dt>
                  <dd className="font-medium tabular-nums">${usd(w.fromPool, 0)}</dd>
                </div>
              </dl>
              <p className="mt-4 text-xs text-muted">
                Transaction <TxLink hash={latest.txHash} />
              </p>
            </div>
          )}
        </Card>
      </div>
      <p className="mt-6 text-sm text-muted">
        Want the full picture on one agent?{" "}
        <Link to={isLocal ? "/agents/1" : "/agents/3"} className={linkClass}>
          {isLocal
            ? "See Agent A, its one weakness and the claim it caused"
            : "See a rated agent's report"}
        </Link>
        .
      </p>
    </section>
  );
}

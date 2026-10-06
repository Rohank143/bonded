import type { ReactNode } from "react";
import { Link } from "react-router";
import { useClaims, waterfall } from "../lib/chain";
import { short, usd } from "../lib/format";
import {
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Term,
  TxLink,
  linkClass,
} from "../components/ui";

export function Claims() {
  const claims = useClaims();
  const all = claims.data ?? [];
  const sum = (f: (w: ReturnType<typeof waterfall>) => bigint) =>
    all.reduce((s, c) => s + f(waterfall(c)), 0n);
  const stat = (label: ReactNode, value: string, hint: string, tone = "") => (
    <div className="panel min-w-0 p-5">
      <p className="eyebrow">{label}</p>
      <p className={`mt-2 font-serif text-[40px] leading-none tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1.5 text-xs text-muted">{hint}</p>
    </div>
  );
  return (
    <Page
      eyebrow="Automatic payouts"
      title="Claims"
      intro="Every payout here was filed and paid by the contracts, with no one filing a form. The operator's bond pays first, then the pool; the first 10% of each loss isn't covered."
    >
      {claims.data && all.length > 0 && (
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {stat(
            "Paid to vaults",
            `$${usd(
              sum((w) => w.toVault),
              0,
            )}`,
            `${all.length} claims`,
          )}
          {stat(
            <Term term="bond">From bonds</Term>,
            `$${usd(
              sum((w) => w.fromBond),
              0,
            )}`,
            "operators pay first",
            "text-held",
          )}
          {stat(
            "From the pool",
            `$${usd(
              sum((w) => w.fromPool),
              0,
            )}`,
            "underwriters pay the rest",
          )}
          {stat(
            <Term term="deductible">Not covered</Term>,
            `$${usd(
              sum((w) => w.unpaid),
              0,
            )}`,
            "deductible and above cover",
            "text-muted",
          )}
        </section>
      )}
      {claims.isPending && !claims.error && (
        <Card>
          <Loading what="claims" />
        </Card>
      )}
      <ErrorText error={claims.error} />
      {claims.data?.length === 0 && (
        <EmptyState title="No claims paid yet">
          When a covered vault records a breach, the claim is filed and paid here automatically.
        </EmptyState>
      )}
      <ul className="flex flex-col gap-4">
        {all.map((c) => {
          const w = waterfall(c);
          const total = w.loss > 0n ? w.loss : 1n;
          const pct = (v: bigint) => `${Number((v * 10_000n) / total) / 100}%`;
          return (
            <li key={c.txHash} className="panel p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-muted">
                    Policy {c.policyId.toString()} · vault{" "}
                    <Link to={`/vaults/${c.vault}`} className={`font-mono ${linkClass}`}>
                      {short(c.vault)}
                    </Link>{" "}
                    · breach {c.breachIds.map(String).join(", ")}
                  </p>
                  <p className="mt-2 font-serif text-5xl leading-none tabular-nums">
                    ${usd(w.toVault)}
                    <span className="ml-2.5 font-sans text-sm text-muted">paid to the vault</span>
                  </p>
                </div>
                <span className="text-xs text-muted">
                  Transaction <TxLink hash={c.txHash} />
                </span>
              </div>
              <div
                className="mt-5 flex h-3 gap-[3px] overflow-hidden rounded-full bg-white/[0.05]"
                aria-hidden
              >
                <div className="bg-brand-bright" style={{ width: pct(w.fromBond) }} />
                <div className="bg-[#9db5ff]" style={{ width: pct(w.fromPool) }} />
                <div className="bg-white/15" style={{ width: pct(w.unpaid) }} />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted">Loss</dt>
                  <dd className="font-semibold tabular-nums">${usd(w.loss)}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 text-muted">
                    <span className="size-2 rounded-full bg-brand-bright" aria-hidden />
                    From the bond
                  </dt>
                  <dd className="font-semibold tabular-nums">${usd(w.fromBond)}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 text-muted">
                    <span className="size-2 rounded-full bg-[#9db5ff]" aria-hidden />
                    From the pool
                  </dt>
                  <dd className="font-semibold tabular-nums">${usd(w.fromPool)}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1.5 text-muted">
                    <span className="size-2 rounded-full bg-white/30" aria-hidden />
                    Not covered
                  </dt>
                  <dd className="font-semibold tabular-nums">${usd(w.unpaid)}</dd>
                </div>
              </dl>
              {w.premiumNetted > 0n && (
                <p className="mt-3 text-xs text-muted">
                  After ${usd(w.premiumNetted)} of premium the vault still owed.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Page>
  );
}

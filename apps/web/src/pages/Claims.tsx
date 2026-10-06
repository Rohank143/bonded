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
  return (
    <Page
      title="Claims"
      eyebrow="Automatic payouts"
      intro="Claims are filed automatically by the keeper when a covered vault records a breach. The contract checks everything and pays: the operator's bond first, then the pool. The deductible is 10%."
    >
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
        {claims.data?.map((c) => {
          const w = waterfall(c);
          const total = w.loss > 0n ? w.loss : 1n;
          const pct = (v: bigint) => `${Number((v * 10_000n) / total) / 100}%`;
          return (
            <li key={c.txHash}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-muted">
                      Policy {c.policyId.toString()} · vault{" "}
                      <Link to={`/vaults/${c.vault}`} className={`font-mono ${linkClass}`}>
                        {short(c.vault)}
                      </Link>{" "}
                      · breach {c.breachIds.map(String).join(", ")}
                    </p>
                    <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                      ${usd(w.toVault)}
                      <span className="ml-2 text-sm font-normal text-muted">paid to the vault</span>
                    </p>
                  </div>
                  <span className="text-xs text-muted">
                    Transaction <TxLink hash={c.txHash} />
                  </span>
                </div>
                <div
                  className="mt-5 flex h-3 gap-0.5 overflow-hidden rounded-full bg-sunken"
                  aria-hidden
                >
                  <div className="bg-brand" style={{ width: pct(w.fromBond) }} />
                  <div className="bg-safe" style={{ width: pct(w.fromPool) }} />
                  <div className="bg-line-strong" style={{ width: pct(w.unpaid) }} />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-muted">Loss</dt>
                    <dd className="font-medium tabular-nums">${usd(w.loss)}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-muted">
                      <span className="size-2 rounded-full bg-brand" aria-hidden />
                      <Term term="bond">From the bond</Term>
                    </dt>
                    <dd className="font-medium tabular-nums">${usd(w.fromBond)}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-muted">
                      <span className="size-2 rounded-full bg-safe" aria-hidden />
                      From the pool
                    </dt>
                    <dd className="font-medium tabular-nums">${usd(w.fromPool)}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1.5 text-muted">
                      <span className="size-2 rounded-full bg-line-strong" aria-hidden />
                      <Term term="deductible">Not covered</Term>
                    </dt>
                    <dd className="font-medium tabular-nums">${usd(w.unpaid)}</dd>
                  </div>
                </dl>
                {w.premiumNetted > 0n && (
                  <p className="mt-3 text-xs text-muted">
                    After ${usd(w.premiumNetted)} of premium the vault still owed.
                  </p>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}

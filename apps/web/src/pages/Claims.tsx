import { Link } from "react-router";
import { useClaims, waterfall } from "../lib/chain";
import { short, usd } from "../lib/format";
import { Card, ErrorText, Loading, Page, TxLink } from "../components/ui";

export function Claims() {
  const claims = useClaims();
  return (
    <Page
      title="Claims"
      intro="Claims are filed automatically by the keeper when a covered vault records a breach. The contract checks everything and pays: the operator's bond first, then the pool. The deductible is 10%."
    >
      <Card>
        {claims.isPending && !claims.error && <Loading what="claims" />}
        <ErrorText error={claims.error} />
        {claims.data?.length === 0 && <p className="text-sm text-muted">No claims paid yet.</p>}
        <ul className="flex flex-col gap-3">
          {claims.data?.map((c) => {
            const w = waterfall(c);
            const total = w.loss > 0n ? w.loss : 1n;
            const pct = (v: bigint) => `${Number((v * 10_000n) / total) / 100}%`;
            return (
              <li key={c.txHash} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span>
                    Policy {c.policyId.toString()} · vault{" "}
                    <Link
                      to={`/vaults/${c.vault}`}
                      className="font-mono text-accent hover:underline"
                    >
                      {short(c.vault)}
                    </Link>{" "}
                    · breach {c.breachIds.map(String).join(", ")}
                  </span>
                  <TxLink hash={c.txHash} />
                </div>
                <div className="mt-2 flex h-3 overflow-hidden rounded" aria-hidden>
                  <div className="bg-accent" style={{ width: pct(w.fromBond) }} />
                  <div className="bg-safe" style={{ width: pct(w.fromPool) }} />
                  <div className="bg-line" style={{ width: pct(w.unpaid) }} />
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 text-sm sm:grid-cols-5">
                  <div>
                    <dt className="text-muted">Loss</dt>
                    <dd className="tabular-nums">${usd(w.loss)}</dd>
                  </div>
                  <div>
                    <dt className="text-accent">From bond</dt>
                    <dd className="tabular-nums">${usd(w.fromBond)}</dd>
                  </div>
                  <div>
                    <dt className="text-safe">From pool</dt>
                    <dd className="tabular-nums">${usd(w.fromPool)}</dd>
                  </div>
                  <div>
                    <dt
                      className="text-muted"
                      title="The 10% deductible, and any loss above the cover"
                    >
                      Not covered
                    </dt>
                    <dd className="tabular-nums">${usd(w.unpaid)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">To vault</dt>
                    <dd className="tabular-nums">
                      ${usd(w.toVault)}
                      {w.premiumNetted > 0n && ` (after $${usd(w.premiumNetted)} premium owed)`}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      </Card>
    </Page>
  );
}

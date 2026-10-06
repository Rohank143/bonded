import { useState } from "react";
import { Link } from "react-router";
import { useAccount } from "wagmi";
import { useAgents } from "../lib/chain";
import { bps, short } from "../lib/format";
import {
  AddressLink,
  Badge,
  Card,
  EmptyState,
  ErrorText,
  LinkButton,
  Loading,
  linkClass,
  Page,
  Table,
  TierBadge,
} from "../components/ui";

export function Agents() {
  const agents = useAgents();
  const { address } = useAccount();
  const [mineOnly, setMineOnly] = useState(false);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const isMine = (owner: string) =>
    Boolean(address) && owner.toLowerCase() === address!.toLowerCase();
  const rows = agents.data?.filter((a) => !mineOnly || isMine(a.owner));
  const mineCount = agents.data?.filter((a) => isMine(a.owner)).length ?? 0;
  return (
    <Page
      title="Agents"
      intro="Every agent registered in BondedRegistry, newest first. Open one for its score, attack report, vault and cover. Onboard your own to give it a vault and a bond and get it rated."
      actions={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
    >
      <Card
        title={
          agents.data ? (
            <>
              Registered agents{" "}
              <span className="ml-1 font-normal text-muted tabular-nums">{agents.data.length}</span>
            </>
          ) : (
            "Registered agents"
          )
        }
        actions={
          address &&
          mineCount > 0 && (
            <div className="inline-flex rounded-lg bg-sunken p-1 text-sm" role="group">
              {[
                [false, "All"],
                [true, `Mine (${mineCount})`],
              ].map(([value, label]) => (
                <button
                  key={String(value)}
                  type="button"
                  aria-pressed={mineOnly === value}
                  onClick={() => setMineOnly(value as boolean)}
                  className={`rounded-md px-3 py-1 font-medium ${mineOnly === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )
        }
      >
        {agents.isPending && !agents.error && <Loading what="agents" />}
        <ErrorText error={agents.error} />
        {rows?.length === 0 && (
          <EmptyState
            title="No agents yet"
            action={<LinkButton to="/agents/new">Onboard the first one</LinkButton>}
          >
            Register an agent, give it a vault and a bond, and get it rated.
          </EmptyState>
        )}
        {rows && rows.length > 0 && (
          <Table>
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 font-normal">Agent</th>
                <th className="font-normal">Score</th>
                <th className="hidden font-normal sm:table-cell">Expected loss</th>
                <th className="font-normal">Vault</th>
                <th className="hidden font-normal sm:table-cell">Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.agentId.toString()} className="border-t border-line">
                  <td className="whitespace-nowrap py-1.5 pr-3">
                    <Link to={`/agents/${a.agentId}`} className={linkClass}>
                      Agent {a.agentId.toString()}
                    </Link>
                    {isMine(a.owner) && (
                      <span className="ml-2">
                        <Badge tone="brand">yours</Badge>
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap pr-3">
                    {a.score ? (
                      <span className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums">{a.score.score}</span>
                        <TierBadge score={a.score.score} />
                        {a.score.expiresAt <= now && <Badge tone="warn">expired</Badge>}
                      </span>
                    ) : (
                      <span className="text-muted">unrated</span>
                    )}
                  </td>
                  <td className="hidden tabular-nums sm:table-cell">
                    {a.score ? bps(a.score.expectedLossBps) : <span className="text-muted">—</span>}
                  </td>
                  <td>
                    {a.vault ? (
                      <Link to={`/vaults/${a.vault}`} className={`font-mono ${linkClass}`}>
                        {short(a.vault)}
                      </Link>
                    ) : (
                      <span className="text-muted">none</span>
                    )}
                  </td>
                  <td className="hidden sm:table-cell">
                    <AddressLink address={a.owner} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

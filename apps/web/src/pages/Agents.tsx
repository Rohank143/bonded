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
    >
      <Card
        title="Registered agents"
        actions={
          <LinkButton to="/agents/new" size="sm">
            Onboard an agent
          </LinkButton>
        }
      >
        {address && mineCount > 0 && (
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            Only my agents ({mineCount})
          </label>
        )}
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
                    <Link to={`/agents/${a.agentId}`} className="text-accent hover:underline">
                      Agent {a.agentId.toString()}
                    </Link>
                    {isMine(a.owner) && (
                      <span className="ml-2">
                        <Badge tone="neutral">yours</Badge>
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap pr-3">
                    {a.score ? (
                      <span className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums">{a.score.score}</span>
                        <TierBadge score={a.score.score} />
                        {a.score.expiresAt <= now && <Badge tone="breach">expired</Badge>}
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
                      <Link
                        to={`/vaults/${a.vault}`}
                        className="font-mono text-accent hover:underline"
                      >
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

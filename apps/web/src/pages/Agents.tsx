import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
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
  ScoreRing,
  Table,
  Term,
  TierBadge,
  linkClass,
} from "../components/ui";

type Show = "all" | "rated" | "mine";

export function Agents() {
  const agents = useAgents();
  const navigate = useNavigate();
  const { address } = useAccount();
  const [params] = useSearchParams();
  const [show, setShow] = useState<Show>(params.get("mine") === "1" ? "mine" : "all");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const isMine = (owner: string) =>
    Boolean(address) && owner.toLowerCase() === address!.toLowerCase();
  const all = agents.data ?? [];
  const counts = {
    all: all.length,
    rated: all.filter((a) => a.score).length,
    mine: all.filter((a) => isMine(a.owner)).length,
  };
  const rows = all.filter((a) =>
    show === "rated" ? Boolean(a.score) : show === "mine" ? isMine(a.owner) : true,
  );
  const tabs: [Show, string][] = [
    ["all", "All"],
    ["rated", "Rated"],
    ...(address ? ([["mine", "Yours"]] as [Show, string][]) : []),
  ];

  return (
    <Page
      title="Agents"
      intro="Every agent registered on Bonded, newest first. Open one to see its score, attack report, vault and cover."
      actions={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
    >
      <Card
        actions={
          <div className="inline-flex rounded-full bg-white/[0.06] p-1 text-sm" role="tablist">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={show === key}
                onClick={() => setShow(key)}
                className={`flex items-center gap-2 rounded-full px-4 py-1.5 font-semibold ${show === key ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
              >
                {label}
                <span className="font-mono text-[11px] opacity-70">{counts[key]}</span>
              </button>
            ))}
          </div>
        }
        title={agents.data ? `${rows.length} ${rows.length === 1 ? "agent" : "agents"}` : "Agents"}
      >
        {agents.isPending && !agents.error && <Loading what="agents" lines={6} />}
        <ErrorText error={agents.error} />
        {agents.data && rows.length === 0 && (
          <EmptyState
            title={show === "mine" ? "You haven't onboarded an agent" : "No agents here yet"}
            action={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
          >
            Register an agent, give it a vault and a bond, and get it rated.
          </EmptyState>
        )}
        {rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>
                  <Term term="score">Score</Term>
                </th>
                <th className="hidden md:table-cell">
                  <Term term="expectedLoss">Expected loss</Term>
                </th>
                <th>
                  <Term term="vault">Vault</Term>
                </th>
                <th className="hidden lg:table-cell">Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.agentId.toString()}
                  className="cursor-pointer"
                  onClick={() => navigate(`/agents/${a.agentId}`)}
                >
                  <td>
                    <span className="flex items-center gap-3">
                      {a.score ? (
                        <ScoreRing score={a.score.score} size={40} />
                      ) : (
                        <span className="flex size-10 items-center justify-center rounded-full border border-dashed border-line-strong text-[10px] text-muted">
                          —
                        </span>
                      )}
                      <span>
                        <Link
                          to={`/agents/${a.agentId}`}
                          className="font-semibold hover:text-accent"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Agent {a.agentId.toString()}
                        </Link>
                        {isMine(a.owner) && (
                          <span className="ml-2">
                            <Badge tone="brand">yours</Badge>
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td>
                    {a.score ? (
                      <span className="flex items-center gap-2">
                        <TierBadge score={a.score.score} />
                        {a.score.expiresAt <= now && <Badge tone="warn">expired</Badge>}
                      </span>
                    ) : (
                      <span className="text-muted">Not rated</span>
                    )}
                  </td>
                  <td className="hidden tabular-nums md:table-cell">
                    {a.score ? bps(a.score.expectedLossBps) : <span className="text-muted">—</span>}
                  </td>
                  <td>
                    {a.vault ? (
                      <Link
                        to={`/vaults/${a.vault}`}
                        className={`font-mono text-[13px] ${linkClass}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {short(a.vault)}
                      </Link>
                    ) : (
                      <span className="text-muted">none</span>
                    )}
                  </td>
                  <td className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
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

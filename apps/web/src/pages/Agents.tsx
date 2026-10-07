import { Link, useNavigate } from "react-router";
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
import { paginate, useListParams } from "../lib/pages";
import { filterAgents, type AgentFilters } from "../lib/lists";
import { Select } from "../components/select";
import { Pagination } from "../components/pagination";
import { TIER_RULES } from "@bonded/shared";

type Show = "all" | "rated" | "mine";

export function Agents() {
  const agents = useAgents();
  const navigate = useNavigate();
  const { address } = useAccount();
  // The tab and filters live in the address, so the sidebar's "Agents" and "Your agents" stay
  // in step and a filtered view can be shared.
  const list = useListParams({ mine: "", show: "all", tier: "all", vault: "any", sort: "newest" });
  const show: Show =
    list.values.mine === "1" ? "mine" : list.values.show === "rated" ? "rated" : "all";
  const setShow = (s: Show) =>
    list.set({ mine: s === "mine" ? "1" : "", show: s === "rated" ? "rated" : "all" });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const isMine = (owner: string) =>
    Boolean(address) && owner.toLowerCase() === address!.toLowerCase();
  const all = agents.data ?? [];
  const counts = {
    all: all.length,
    rated: all.filter((a) => a.score).length,
    mine: all.filter((a) => isMine(a.owner)).length,
  };
  const filters: AgentFilters = {
    show,
    tier: list.values.tier,
    vault: list.values.vault as AgentFilters["vault"],
    sort: list.values.sort as AgentFilters["sort"],
  };
  const rows = filterAgents(all, filters, address);
  const page = paginate(rows, list.page, list.size);
  const narrowed = filters.tier !== "all" || filters.vault !== "any";
  const tabs: [Show, string][] = [
    ["all", "All"],
    ["rated", "Rated"],
    ...(address ? ([["mine", "Yours"]] as [Show, string][]) : []),
  ];

  return (
    <Page
      title="Agents"
      intro="Every agent registered on Bonded. Open one to see its score, attack report, vault and cover. All are scored on the same scale, which is what lets the Bonded Score serve as the bar for agent safety."
      actions={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
    >
      <Card
        actions={
          <div className="flex flex-wrap items-center gap-2">
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
            <Select
              label="Tier"
              value={filters.tier}
              onChange={(v) => list.set({ tier: v })}
              options={[
                { value: "all", label: "All" },
                ...TIER_RULES.map((t) => ({ value: t.tier, label: t.tier })),
                { value: "unrated", label: "Not rated" },
              ]}
            />
            <Select
              label="Vault"
              value={filters.vault}
              onChange={(v) => list.set({ vault: v })}
              options={[
                { value: "any", label: "Any" },
                { value: "with", label: "Has a vault" },
                { value: "without", label: "No vault" },
              ]}
            />
            <Select
              label="Sort"
              value={filters.sort}
              onChange={(v) => list.set({ sort: v })}
              options={[
                { value: "newest", label: "Newest" },
                { value: "score", label: "Highest score" },
              ]}
            />
          </div>
        }
        title={agents.data ? `${rows.length} ${rows.length === 1 ? "agent" : "agents"}` : "Agents"}
      >
        {agents.isPending && !agents.error && <Loading what="agents" height="lg" />}
        <ErrorText error={agents.error} />
        {agents.data && rows.length === 0 && (
          <EmptyState
            title={
              narrowed
                ? "No agents match these filters"
                : show === "mine"
                  ? "You haven't onboarded an agent"
                  : "No agents here yet"
            }
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
              {page.items.map((a) => (
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
        <Pagination
          page={page.page}
          pages={page.pages}
          total={page.total}
          size={list.size}
          onPage={(p) => list.set({ page: p })}
          onSize={(size) => list.set({ size })}
          noun="agents"
        />
      </Card>
    </Page>
  );
}

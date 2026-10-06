import { Link, useNavigate } from "react-router";
import { useReadContracts } from "wagmi";
import { coverManagerAbi, mandateVaultAbi } from "@bonded/shared";
import { deployment } from "../config";
import { useAgents, useVaults } from "../lib/chain";
import { short, usd } from "../lib/format";
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
  Term,
  TierBadge,
  linkClass,
} from "../components/ui";

export function Vaults() {
  const vaults = useVaults();
  const agents = useAgents();
  const navigate = useNavigate();
  const list = vaults.data ?? [];
  const reads = useReadContracts({
    contracts: list.flatMap((v) => [
      { address: v.vault, abi: mandateVaultAbi, functionName: "totalAssets" as const },
      { address: v.vault, abi: mandateVaultAbi, functionName: "frozen" as const },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf" as const,
        args: [v.vault] as const,
      },
    ]),
    query: { enabled: list.length > 0, refetchInterval: 30_000 },
  });
  const at = (i: number, k: number) => reads.data?.[i * 3 + k]?.result;
  const held = list.reduce((s, _, i) => s + ((at(i, 0) as bigint | undefined) ?? 0n), 0n);
  const covered = list.filter((_, i) => Boolean(at(i, 2))).length;
  const frozen = list.filter((_, i) => at(i, 1) === true).length;

  return (
    <Page
      title="Vaults"
      intro="Each vault holds an agent's funds and enforces its mandate on chain. Its breach log is the record that pays claims."
      actions={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
    >
      {list.length > 0 && (
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            ["Vaults", String(list.length), ""],
            ["Held for depositors", reads.data ? `$${usd(held, 0)}` : "…", ""],
            ["Covered", reads.data ? String(covered) : "…", "text-accent"],
            ["Agent frozen", reads.data ? String(frozen) : "…", frozen ? "text-breach" : ""],
          ].map(([label, value, tone]) => (
            <div key={label} className="panel p-5">
              <p className="eyebrow">{label}</p>
              <p className={`mt-2 font-serif text-[40px] leading-none tabular-nums ${tone}`}>
                {value}
              </p>
            </div>
          ))}
        </section>
      )}
      <Card>
        {vaults.isPending && !vaults.error && <Loading what="vaults" lines={5} />}
        <ErrorText error={vaults.error} />
        {vaults.data?.length === 0 && (
          <EmptyState
            title="No vaults yet"
            action={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
          >
            Each onboarded agent gets a Mandate Vault.
          </EmptyState>
        )}
        {list.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Vault</th>
                <th>Agent</th>
                <th className="!pr-10 !text-right">Assets</th>
                <th>
                  <Term term="cover">Cover</Term>
                </th>
                <th>State</th>
                <th className="hidden lg:table-cell">
                  <Term term="guardian">Guardian</Term>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((v, i) => {
                const score = agents.data?.find((a) => a.agentId === v.agentId)?.score?.score;
                const assets = at(i, 0) as bigint | undefined;
                return (
                  <tr
                    key={v.vault}
                    className="cursor-pointer"
                    onClick={() => navigate(`/vaults/${v.vault}`)}
                  >
                    <td>
                      <Link
                        to={`/vaults/${v.vault}`}
                        className={`font-mono text-[13px] ${linkClass}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {short(v.vault)}
                      </Link>
                    </td>
                    <td>
                      <span className="flex items-center gap-2">
                        <Link
                          to={`/agents/${v.agentId}`}
                          className="font-semibold hover:text-accent"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Agent {v.agentId.toString()}
                        </Link>
                        {score !== undefined && <TierBadge score={score} />}
                      </span>
                    </td>
                    <td className="pr-10 text-right font-mono tabular-nums">
                      {assets !== undefined ? `$${usd(assets, 0)}` : "…"}
                    </td>
                    <td>
                      {at(i, 2) ? <Badge tone="brand">Covered</Badge> : <Badge>No cover</Badge>}
                    </td>
                    <td>
                      {at(i, 1) === true ? (
                        <Badge tone="breach" dot>
                          Frozen
                        </Badge>
                      ) : at(i, 1) === false ? (
                        <Badge tone="safe" dot>
                          Active
                        </Badge>
                      ) : (
                        "…"
                      )}
                    </td>
                    <td className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                      <AddressLink address={v.guardian} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

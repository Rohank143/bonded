import { Link } from "react-router";
import { useVaults } from "../lib/chain";
import { short } from "../lib/format";
import {
  AddressLink,
  Card,
  EmptyState,
  ErrorText,
  LinkButton,
  Loading,
  Page,
  Table,
} from "../components/ui";

export function Vaults() {
  const vaults = useVaults();
  return (
    <Page
      title="Mandate vaults"
      intro="A vault holds an agent's funds and enforces its mandate on chain: allowed tokens, contracts, limits. Every breach is recorded here, and that record is what pays claims."
    >
      <Card
        actions={
          <Link to="/agents/new" className="text-sm text-accent hover:underline">
            Onboard an agent →
          </Link>
        }
      >
        {vaults.isPending && !vaults.error && <Loading what="vaults" />}
        <ErrorText error={vaults.error} />
        {vaults.data?.length === 0 && (
          <EmptyState
            title="No vaults yet"
            action={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
          >
            Each onboarded agent gets a Mandate Vault.
          </EmptyState>
        )}
        {vaults.data && vaults.data.length > 0 && (
          <Table>
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 font-normal">Vault</th>
                <th className="font-normal">Agent</th>
                <th className="font-normal">Guardian</th>
              </tr>
            </thead>
            <tbody>
              {vaults.data.map((v) => (
                <tr key={v.vault} className="border-t border-line">
                  <td className="py-1.5">
                    <Link
                      to={`/vaults/${v.vault}`}
                      className="font-mono text-accent hover:underline"
                    >
                      {short(v.vault)}
                    </Link>
                  </td>
                  <td>
                    <Link to={`/agents/${v.agentId}`} className="text-accent hover:underline">
                      {v.agentId.toString()}
                    </Link>
                  </td>
                  <td>
                    <AddressLink address={v.guardian} />
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

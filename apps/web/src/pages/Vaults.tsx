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
  Term,
  linkClass,
} from "../components/ui";

export function Vaults() {
  const vaults = useVaults();
  return (
    <Page
      title="Vaults"
      eyebrow="Mandate vaults"
      actions={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
      intro="Each vault holds an agent's funds and enforces its mandate on chain. Its breach log is the record that pays claims."
    >
      <Card>
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
            <thead>
              <tr>
                <th>Vault</th>
                <th>Agent</th>
                <th>
                  <Term term="guardian">Guardian</Term>
                </th>
              </tr>
            </thead>
            <tbody>
              {vaults.data.map((v) => (
                <tr key={v.vault}>
                  <td>
                    <Link to={`/vaults/${v.vault}`} className={`font-mono ${linkClass}`}>
                      {short(v.vault)}
                    </Link>
                  </td>
                  <td>
                    <Link to={`/agents/${v.agentId}`} className={linkClass}>
                      Agent {v.agentId.toString()}
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

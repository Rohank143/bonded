import { EmptyState, LinkButton, Page } from "../components/ui";

export function NotFound() {
  return (
    <Page title="Page not found">
      <EmptyState
        title="There's no page at this address"
        action={<LinkButton to="/overview">Go to the overview</LinkButton>}
      >
        Try the search at the top for an agent ID, a vault address or a transaction.
      </EmptyState>
    </Page>
  );
}

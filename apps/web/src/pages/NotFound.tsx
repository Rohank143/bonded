import { EmptyState, LinkButton, Page } from "../components/ui";

export function NotFound() {
  return (
    <Page title="Page not found">
      <EmptyState
        title="There is no page at this address"
        action={<LinkButton to="/">Go to the start page</LinkButton>}
      />
    </Page>
  );
}

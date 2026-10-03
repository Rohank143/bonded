import { Link } from "react-router";
import { Page } from "../components/ui";

export function NotFound() {
  return (
    <Page title="Page not found">
      <p className="text-sm text-muted">
        There is no page at this address.{" "}
        <Link to="/" className="text-accent hover:underline">
          Go to the start page
        </Link>
        .
      </p>
    </Page>
  );
}

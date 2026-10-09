import { useState } from "react";
import { Link } from "react-router";
import { useReadContract } from "wagmi";
import { bondedRegistryAbi } from "@bondedhq/shared";
import { deployment } from "../config";
import { Button, Card, Loading, Page, Unavailable } from "../components/ui";

const PAGE_SIZE = 12n;

/** Registry IDs are consecutive from 1, including agents that have not been rated yet. */
export function Agents() {
  const [requestedPage, setPage] = useState(0n);
  const agents = useReadContract({
    address: deployment.registry,
    abi: bondedRegistryAbi,
    functionName: "totalAgents",
    query: { refetchInterval: 15_000 },
  });
  const count = agents.data ?? 0n;
  const pages = count > 0n ? (count + PAGE_SIZE - 1n) / PAGE_SIZE : 1n;
  const page = requestedPage < pages ? requestedPage : pages - 1n;
  const newest = count - page * PAGE_SIZE;
  const ids = Array.from(
    { length: Number(newest < PAGE_SIZE ? newest : PAGE_SIZE) },
    (_, index) => newest - BigInt(index),
  );

  return (
    <Page
      title="Agents"
      intro="Browse agents registered on this chain. Open an agent's page to see its safety score, request a rating and find its vault."
    >
      <div>
        <Link
          to="/agents/new"
          className="inline-flex rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-85"
        >
          Create agent
        </Link>
      </div>
      <Card title="Registered agents">
        {agents.isPending && <Loading what="agents" />}
        {agents.isError && (
          <Unavailable error={agents.error} onRetry={() => void agents.refetch()} />
        )}
        {agents.data !== undefined && (
          <>
            {count === 0n ? (
              <p className="text-sm text-muted">
                No agents registered yet. Create an agent to get started.
              </p>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted">
                  {count.toString()} registered {count === 1n ? "agent" : "agents"} · newest first
                </p>
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {ids.map((id) => (
                    <li key={id.toString()}>
                      <Link
                        to={`/agents/${id}`}
                        className="block rounded-md border border-line p-4 hover:border-accent"
                      >
                        <div className="font-semibold">Agent {id.toString()}</div>
                        <div className="mt-1 text-sm text-accent">View agent →</div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {pages > 1n && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <Button
                      kind="secondary"
                      disabled={page === 0n}
                      onClick={() => setPage(page - 1n)}
                    >
                      Newer agents
                    </Button>
                    <span className="text-sm text-muted">
                      Page {(page + 1n).toString()} of {pages.toString()}
                    </span>
                    <Button
                      kind="secondary"
                      disabled={page + 1n === pages}
                      onClick={() => setPage(page + 1n)}
                    >
                      Older agents
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}

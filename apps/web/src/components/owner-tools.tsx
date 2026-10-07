import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { SELF_SERVE_KIND_LABELS, type SelfServeKind } from "@bonded/shared";
import { deployment } from "../config";
import { api } from "../lib/api";
import { recallAgent } from "../lib/onboarding";
import { registerForRatings, requestRating } from "../lib/self-serve";
import { when } from "../lib/format";
import { useRatingRun } from "../lib/rating-run";
import { Badge, Button, Card, ErrorText, linkClass } from "./ui";

/**
 * The agent owner's controls on its profile: register it for self-serve ratings if needed, ask
 * for a rating, and follow the rating as it runs. Shown only to the agent's owner.
 */
export function OwnerTools({ agentId, owner }: { agentId: string; owner?: string }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());
  const self = useQuery({
    queryKey: ["self-agent", agentId],
    queryFn: () => api.selfAgent(agentId),
    enabled: isOwner,
  });
  const run = useRatingRun(runId);
  if (!isOwner) return null;
  const remembered = recallAgent(deployment.chainId, agentId);
  const record = self.data;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const register = () =>
    act(async () => {
      if (!remembered) return;
      await registerForRatings(signMessageAsync, agentId, remembered);
      await self.refetch();
    });
  const rate = () =>
    act(async () => {
      const { runId: id } = await requestRating(signMessageAsync, agentId);
      setRunId(id);
      await self.refetch();
    });

  const waiting =
    record?.registered && record.nextRatingAt && new Date(record.nextRatingAt) > new Date();
  return (
    <Card title="Your agent">
      {self.isPending ? (
        <p className="text-sm text-muted">Checking its registration…</p>
      ) : record?.registered && record.source === "operator" ? (
        <p className="text-sm text-muted">This agent is rated by Bonded's operator.</p>
      ) : record?.registered ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Rated as:{" "}
            <span className="font-medium">
              {SELF_SERVE_KIND_LABELS[record.kind as SelfServeKind] ?? record.kind}
            </span>
            {record.sentinel && (
              <>
                , with <span className="font-medium">Sentinel</span> in front of it
              </>
            )}
            , against this agent's vault and mandate. A rating runs every attack in the library five
            times in a sandbox, then posts the signed score on chain. It takes a few minutes.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || Boolean(waiting)} onClick={rate}>
              {busy ? "Sign in your wallet…" : "Rate this agent"}
            </Button>
            {waiting && (
              <span className="text-xs text-muted">
                One rating an hour per agent; next from{" "}
                {when(Date.parse(record.nextRatingAt!) / 1000)}.
              </span>
            )}
          </div>
          {runId && (
            <p>
              Rating{" "}
              <Badge
                tone={
                  run.data?.status === "failed"
                    ? "breach"
                    : run.data?.status === "done"
                      ? "safe"
                      : "neutral"
                }
              >
                {run.data?.status ?? "queued"}
              </Badge>{" "}
              {run.data?.status === "done" ? (
                "The new score is above."
              ) : run.data?.status === "failed" ? (
                (run.data.error ?? "The rating failed.")
              ) : (
                <>
                  Watch the attacks live in the{" "}
                  <Link to="/arena" className={linkClass}>
                    Arena
                  </Link>
                  .
                </>
              )}
            </p>
          )}
        </div>
      ) : remembered ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            This agent isn't registered for ratings yet. Register it as{" "}
            <span className="font-medium">{SELF_SERVE_KIND_LABELS[remembered.kind]}</span>
            {remembered.sentinel ? ", with Sentinel in front of it" : ""}, with the mandate of vault{" "}
            <span className="font-mono">{remembered.vault}</span>.
          </p>
          <div>
            <Button disabled={busy} onClick={register}>
              {busy ? "Sign in your wallet…" : "Register for ratings"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">
          This agent isn't registered for ratings, and this browser doesn't have its mandate. Agents
          onboarded from{" "}
          <Link to="/agents/new" className={linkClass}>
            Onboard an agent
          </Link>{" "}
          are registered automatically.
        </p>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

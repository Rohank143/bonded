import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAccount } from "wagmi";
import { ago } from "../lib/format";
import { inboxSeenAt, markInboxSeen } from "../lib/health";
import { messageCode } from "../lib/troubleshooting";
import { useOwnerSession } from "../lib/owner-session";
import { useInbox } from "../components/inbox-bell";
import { FixLink } from "../components/problem";
import { ConnectButton } from "../components/wallet";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Unavailable,
  linkClass,
} from "../components/ui";

/** The owner's notifications: score expiring, runner offline, breaches, claims, cover, gas. */
export function Inbox() {
  const { isConnected } = useAccount();
  const owner = useOwnerSession();
  const inbox = useInbox(owner.session?.session);
  // What was new when the page opened stays marked new until the next visit.
  const [seenBefore] = useState(() => inboxSeenAt());
  useEffect(() => {
    if (inbox.data) markInboxSeen();
  }, [inbox.data]);
  return (
    <Page
      title="Notifications"
      eyebrow="Yours"
      intro="What needs you about your agents. The same notices go to your webhook or email if you set one on an agent's page."
    >
      {!isConnected ? (
        <EmptyState title="Connect your wallet" action={<ConnectButton />}>
          Notifications are for the agents your wallet owns.
        </EmptyState>
      ) : !owner.session ? (
        <EmptyState
          title="Sign in to see them"
          action={
            <div className="flex flex-col items-center gap-2">
              <Button loading={owner.signingIn} onClick={() => void owner.signIn()}>
                {owner.signingIn ? "Sign in your wallet…" : "Sign in"}
              </Button>
              <ErrorText error={owner.error} />
            </div>
          }
        >
          One signature, no gas.
        </EmptyState>
      ) : inbox.isPending ? (
        <Card>
          <Loading what="your notifications" />
        </Card>
      ) : inbox.error ? (
        <Unavailable error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : !inbox.data?.items.length ? (
        <EmptyState title="Nothing yet">
          When something needs you (a score about to expire, the runner offline, a breach or a
          claim, cover lapsing, low gas), it shows here.
        </EmptyState>
      ) : (
        <Card>
          <ul className="flex flex-col" aria-label="Notifications">
            {inbox.data.items.map((i) => {
              const fresh = i.read !== undefined ? !i.read : Date.parse(i.createdAt) > seenBefore;
              return (
                <li
                  key={i.id}
                  className="flex flex-col gap-1 border-t border-white/[0.06] py-3.5 text-sm first:border-0"
                >
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    {fresh && (
                      <span
                        className="size-2 self-center rounded-full bg-accent"
                        aria-label="New"
                      />
                    )}
                    <span className={fresh ? "font-semibold" : ""}>{i.message}</span>
                  </p>
                  <p className="flex flex-wrap gap-x-3 text-xs text-muted">
                    <span>{ago(i.createdAt)}</span>
                    {i.agentId && (
                      <Link className={linkClass} to={`/agents/${i.agentId}`}>
                        Agent {i.agentId}
                      </Link>
                    )}
                    <FixLink code={messageCode({ code: i.code ?? i.kind, message: i.message })} />
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </Page>
  );
}

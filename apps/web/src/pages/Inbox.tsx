import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NOTIFICATION_TYPES } from "@bondedhq/shared";
import { Link } from "react-router";
import { useAccount } from "wagmi";
import { ago } from "../lib/format";
import { inboxSeenAt, markInboxSeen } from "../lib/health";
import { byoaApi } from "../lib/byoa-api";
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

/** Which notifications the owner gets: each type can be turned off (webhook, email and this list). */
export function MuteSettings({ session }: { session: string }) {
  const settings = useQuery({
    queryKey: ["owner-notifications", session],
    queryFn: () => byoaApi.ownerNotifications(session),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!settings.data) return null;
  const types = settings.data.types ?? Object.keys(NOTIFICATION_TYPES);
  const muted = new Set(settings.data.muted ?? []);
  const toggle = async (type: string) => {
    const next = new Set(muted);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setBusy(true);
    setError(null);
    try {
      await byoaApi.saveMuted(session, [...next]);
      await settings.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="rounded-2xl border border-line-strong p-4 text-sm">
      <summary className="cursor-pointer font-semibold">Choose what you're told about</summary>
      <p className="mt-3 text-xs text-muted">
        A type you turn off isn't sent by webhook or email and doesn't show here.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {types.map((t) => (
          <li key={t}>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-1"
                checked={!muted.has(t)}
                disabled={busy}
                onChange={() => void toggle(t)}
              />
              <span>{NOTIFICATION_TYPES[t as keyof typeof NOTIFICATION_TYPES] ?? t}</span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </details>
  );
}

/** The owner's notifications: score expiring, runner offline, breaches, claims, cover, gas. */
export function Inbox() {
  const { isConnected } = useAccount();
  const owner = useOwnerSession();
  const inbox = useInbox(owner.session?.session);
  const queryClient = useQueryClient();
  // What was new when the page opened stays marked new until the next visit; opening the page
  // marks everything shown read (on the API, so other browsers agree).
  const [seenBefore] = useState(() => inboxSeenAt());
  const marked = useRef<string | null>(null);
  const session = owner.session?.session;
  useEffect(() => {
    if (!inbox.data) return;
    markInboxSeen();
    const newest = inbox.data.items[0];
    if (!session || !newest || marked.current === newest.id) return;
    if (!inbox.data.items.some((i) => i.read === false)) return;
    marked.current = newest.id;
    void byoaApi
      .markInboxRead(session, { through: newest.id })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ["inbox", session], refetchType: "none" }),
      )
      .catch(() => {
        // Not marked: the items stay unread, which is harmless.
        marked.current = null;
      });
  }, [inbox.data, session, queryClient]);
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
        <>
          <MuteSettings session={owner.session.session} />
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
                    {i.action && i.action !== i.message && <p className="text-soft">{i.action}</p>}
                    <p className="flex flex-wrap gap-x-3 text-xs text-muted">
                      <span>{ago(i.createdAt)}</span>
                      {i.agentId && (
                        <Link className={linkClass} to={`/agents/${i.agentId}`}>
                          Agent {i.agentId}
                        </Link>
                      )}
                      <FixLink code={messageCode({ code: i.code ?? null, message: i.message })} />
                    </p>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </Page>
  );
}

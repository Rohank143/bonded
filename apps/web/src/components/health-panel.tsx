import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, type SelfAgentRecord } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { faucets, isLocal } from "../config";
import { ago, when } from "../lib/format";
import {
  COVER_TEXT,
  COVER_WITHOUT_TRADES,
  RUNNER_TEXT,
  gasNotice,
  scoreLine,
  vaultTradingLine,
  type AgentGas,
  type AgentHealth,
  type Tone,
  type VaultActivity,
} from "../lib/health";
import { messageCode, messageText } from "../lib/troubleshooting";
import { useOwnerSession } from "../lib/owner-session";
import { FixLink } from "./problem";
import { AddressLink, Badge, Button, Card, Loading, TxLink, linkClass } from "./ui";

const TEXT_TONE: Record<Tone, string> = {
  safe: "text-safe",
  warn: "text-warn",
  breach: "text-breach",
  neutral: "text-muted",
};

/** The low-gas notice, with how to top up: test ETH to the agent's key from a faucet. */
export function LowGasNotice({ gas }: { gas: AgentGas | null | undefined }) {
  const notice = gasNotice(gas);
  if (!notice) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-sm"
    >
      <p>
        {notice} <FixLink code="low-gas" className="text-xs" />
      </p>
      <p className="mt-1 text-xs text-soft">
        To top up, send test ETH to the agent's key
        {gas?.address ? (
          <>
            {" "}
            (<AddressLink address={gas.address} />)
          </>
        ) : null}
        {!isLocal && faucets[0] ? (
          <>
            , or ask a{" "}
            <a className={linkClass} href={faucets[0]} target="_blank" rel="noreferrer">
              faucet
            </a>{" "}
            for it
          </>
        ) : null}
        . Until it has gas, its trades through the vault fail.
      </p>
    </div>
  );
}

/** Cover held while the agent doesn't trade through its vault: the cover would pay nothing. */
export function CoverWithoutTradesWarning({ show }: { show: boolean | undefined }) {
  if (!show) return null;
  return (
    <p role="alert" className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-sm">
      {COVER_WITHOUT_TRADES} <FixLink code="cover-without-vault-trades" className="text-xs" />
    </p>
  );
}

/** The vault's trading in a line, with the last transaction. */
export function VaultTrading({ activity }: { activity: VaultActivity | null | undefined }) {
  const line = vaultTradingLine(activity);
  return (
    <p className={`text-xs ${TEXT_TONE[line.tone]}`}>
      {line.text}
      {activity?.lastTxHash && (
        <>
          {" "}
          <TxLink hash={activity.lastTxHash} />
        </>
      )}
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/**
 * The agent's health at the top of its page, for its owner: score and expiry, the runner, trading
 * through the vault, gas, cover, the next re-rating, and each open problem with what to do.
 */
export function HealthPanel({
  agentId,
  record,
}: {
  agentId: string;
  record: SelfAgentRecord | undefined;
}) {
  const owner = useOwnerSession();
  const session = owner.session?.session;
  const health = useQuery({
    queryKey: ["agent-health", agentId, session],
    queryFn: () => byoaApi.agentHealth(agentId, session!),
    enabled: Boolean(session),
    refetchInterval: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const reg = record?.registered ? record : undefined;
  if (!session)
    return (
      <Card title="Health">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted">
            Sign in once (no gas) to see your agent's health: its score, runner, vault trading, gas
            and cover, and anything that needs you.
          </p>
          <Button
            size="sm"
            kind="secondary"
            loading={owner.signingIn}
            onClick={() => void owner.signIn()}
          >
            {owner.signingIn ? "Sign in your wallet…" : "Sign in"}
          </Button>
        </div>
      </Card>
    );
  if (health.isPending) return <Loading what="its health" />;
  // An API without the health endpoint yet: what the agent's record already says.
  const h: AgentHealth | undefined = health.data;
  const vault = h?.vault ?? reg?.vaultActivity ?? null;
  const gas = h?.gas ?? reg?.agentGas ?? null;
  const coverWithout = h?.coverWithoutVaultTrades ?? reg?.coverWithoutVaultTrades;
  if (!h && !vault && !gas && !coverWithout) return null;
  const score = h ? scoreLine(h.score) : undefined;
  const problems = h?.problems ?? [];
  return (
    <Card
      title="Health"
      actions={
        problems.length ? (
          <Badge tone="warn" dot>
            {problems.length} to look at
          </Badge>
        ) : h ? (
          <Badge tone="safe" dot>
            All good
          </Badge>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        {problems.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Problems">
            {problems.map((p) => {
              const action = typeof p === "string" ? undefined : p.action;
              return (
                <li
                  key={messageText(p)}
                  className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5"
                >
                  <span className="font-medium">{messageText(p)}</span>{" "}
                  <FixLink code={messageCode(p)} className="text-xs" />
                  {action && <span className="mt-0.5 block text-soft">{action}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <CoverWithoutTradesWarning show={coverWithout} />
        <LowGasNotice gas={gas} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          {score && (
            <Row label="Score">
              <span className={TEXT_TONE[score.tone]}>{score.text}</span>
            </Row>
          )}
          {h && (
            <Row label="Connection">
              <span className={TEXT_TONE[RUNNER_TEXT[h.runner.status].tone]}>
                {RUNNER_TEXT[h.runner.status].label}
              </span>
              {h.runner.status === "offline" && h.runner.lastSeenAt && (
                <span className="text-muted">, last seen {ago(h.runner.lastSeenAt)}</span>
              )}
            </Row>
          )}
          <Row label="Vault trading">
            <VaultTrading activity={vault} />
          </Row>
          {gas && (
            <Row label="Gas">
              <span className={gas.low ? "text-warn" : "text-muted"}>
                {gas.low ? "Low" : "Enough"}
                {gas.estimatedTradesLeft != null &&
                  `, about ${gas.estimatedTradesLeft} trade${gas.estimatedTradesLeft === 1 ? "" : "s"} left`}
              </span>
            </Row>
          )}
          {h?.cover && (
            <Row label="Cover">
              <span className={TEXT_TONE[COVER_TEXT[h.cover.status].tone]}>
                {COVER_TEXT[h.cover.status].label}
              </span>
              {h.cover.amount != null && h.cover.status !== "none" && (
                <span className="text-muted">, {h.cover.amount.toLocaleString("en-US")} tUSDG</span>
              )}
            </Row>
          )}
          {h?.nextRatingAt && (
            <Row label="Next re-rating">
              <span className="text-muted">
                {when(Math.floor(Date.parse(h.nextRatingAt) / 1000))}
              </span>
            </Row>
          )}
        </dl>
      </div>
    </Card>
  );
}

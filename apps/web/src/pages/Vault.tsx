import { useState } from "react";
import { Link, useParams } from "react-router";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { encodeFunctionData, isAddress, type Abi, type Address } from "viem";
import {
  SELF_SERVE_MAX_COVER_USD,
  coverManagerAbi,
  mandateVaultAbi,
  quoteMessage,
  testTokenAbi,
} from "@bonded/shared";
import { deployment } from "../config";
import { api, type SignedQuoteResponse } from "../lib/api";
import { usePolicies } from "../lib/chain";
import { isRpcUnavailable } from "../lib/errors";
import { BREACH_TYPES, POLICY_STATUS, bps, parseUsd, short, usd, when } from "../lib/format";
import {
  AddressLink,
  Badge,
  Button,
  Card,
  Details,
  EmptyState,
  ErrorText,
  Grid,
  LinkButton,
  Term,
  Input,
  Loading,
  Page,
  Stat,
  Table,
  Unavailable,
  linkClass,
} from "../components/ui";
import { useSend } from "../components/wallet";

const ZERO = "0x0000000000000000000000000000000000000000";

export function Vault() {
  const param = useParams().address ?? "";
  if (!isAddress(param))
    return (
      <Page title="Vault" back={{ to: "/vaults", label: "All vaults" }}>
        <EmptyState title="That isn't a vault address" />
      </Page>
    );
  return <VaultView vault={param} />;
}

function VaultView({ vault }: { vault: Address }) {
  const { address: user } = useAccount();
  const who = user ?? ZERO;
  const v = { address: vault, abi: mandateVaultAbi } as const;
  const reads = useReadContracts({
    contracts: [
      { ...v, functionName: "totalAssets" },
      { ...v, functionName: "frozen" },
      { ...v, functionName: "agentId" },
      { ...v, functionName: "guardian" },
      { ...v, functionName: "agent" },
      { ...v, functionName: "breachCount" },
      { ...v, functionName: "maxWithdraw", args: [who] },
      { ...v, functionName: "mandateHash" },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [vault],
      },
      { address: deployment.usdg, abi: testTokenAbi, functionName: "balanceOf", args: [who] },
      { ...v, functionName: "mode" },
    ],
    query: { refetchInterval: 15_000 },
  });
  const [total, frozen, agentId, guardian, agent, count, withdrawable, , activeId, wallet, mode] =
    reads.data ?? [];
  const breachCount = Number(count?.result ?? 0n);
  const breaches = useReadContracts({
    contracts: Array.from({ length: breachCount }, (_, i) => ({
      ...v,
      functionName: "getBreach" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: breachCount > 0 },
  });
  const policies = usePolicies(vault);

  const back = { to: "/vaults", label: "All vaults" };
  if (reads.isLoading)
    return (
      <Page title={`Vault ${short(vault)}`} back={back}>
        <Card>
          <Loading what="vault" lines={4} />
        </Card>
      </Page>
    );
  if (reads.isError || isRpcUnavailable(total?.error))
    return (
      <Page title={`Vault ${short(vault)}`} back={back}>
        <Unavailable error={reads.error ?? total?.error} onRetry={() => void reads.refetch()} />
      </Page>
    );
  if (total?.error)
    return (
      <Page title={`Vault ${short(vault)}`} back={back}>
        <EmptyState
          title="This address isn't a Bonded vault on this chain"
          action={<LinkButton to="/vaults">See all vaults</LinkButton>}
        />
      </Page>
    );
  const isGuardian = Boolean(
    user && guardian?.result && user.toLowerCase() === guardian.result.toLowerCase(),
  );
  return (
    <Page
      title={`Vault ${short(vault)}`}
      eyebrow="Mandate vault"
      back={back}
      intro={<span className="font-mono text-sm break-all">{vault}</span>}
      actions={
        frozen?.result ? (
          <Badge tone="breach" dot>
            Agent frozen
          </Badge>
        ) : (
          <Badge tone="safe" dot>
            Active
          </Badge>
        )
      }
    >
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Overview">
            <Grid>
              <Stat
                label="Assets"
                value={total?.result !== undefined ? `$${usd(total.result)}` : "…"}
                hint="tUSDG"
              />
              <Stat
                label="Agent"
                value={
                  agentId?.result !== undefined ? (
                    <Link to={`/agents/${agentId.result}`} className={linkClass}>
                      {agentId.result.toString()}
                    </Link>
                  ) : (
                    "…"
                  )
                }
              />
              <Stat
                label="State"
                value={frozen?.result ? "Frozen" : "Active"}
                hint="freezes on a breach"
              />
              <Stat
                label={<Term term="breach">Breaches</Term>}
                value={<span className={breachCount ? "text-breach" : ""}>{breachCount}</span>}
              />
            </Grid>
            <Details>
              <dt>
                <Term term="guardian">Guardian</Term>
              </dt>
              <dd>{guardian?.result ? <AddressLink address={guardian.result} /> : "…"}</dd>
              <dt>
                <Term term="agentKey">Agent key</Term>
              </dt>
              <dd>{agent?.result ? <AddressLink address={agent.result} /> : "…"}</dd>
              <dt>
                <Term term={mode?.result === 0 ? "monitor" : "enforce"}>Mode</Term>
              </dt>
              <dd>
                {mode?.result === undefined ? "…" : mode.result === 0 ? "Monitor" : "Enforce"}
              </dd>
            </Details>
          </Card>

          <Cover activeId={activeId?.result} history={policies.data} />

          <Card title="Breach log">
            {breachCount === 0 ? (
              <EmptyState title="No breaches recorded">
                The agent has stayed inside its mandate.
              </EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Type</th>
                    <th className="text-right">Loss</th>
                    <th>When</th>
                    <th>Claim</th>
                  </tr>
                </thead>
                <tbody>
                  {breaches.data?.map((b, i) =>
                    b.result ? (
                      <tr key={i}>
                        <td className="text-muted tabular-nums">{i}</td>
                        <td>{BREACH_TYPES[b.result.breachType] ?? b.result.breachType}</td>
                        <td className="text-right tabular-nums">
                          {b.result.blocked ? "blocked, $0" : `$${usd(b.result.lossUsd6)}`}
                        </td>
                        <td className="whitespace-nowrap">{when(b.result.timestamp)}</td>
                        <td>
                          {b.result.claimed ? (
                            <Badge tone="safe">paid</Badge>
                          ) : (
                            <Badge>not paid</Badge>
                          )}
                        </td>
                      </tr>
                    ) : null,
                  )}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-24">
          <DepositWithdraw
            vault={vault}
            wallet={wallet?.result}
            withdrawable={withdrawable?.result}
            connected={Boolean(user)}
          />
          <BuyCover
            vault={vault}
            agentId={agentId?.result}
            isGuardian={isGuardian}
            hasActive={Boolean(activeId?.result)}
          />
          {isGuardian && Boolean(frozen?.result) && <Unfreeze vault={vault} />}
          {user && agent?.result && user.toLowerCase() === agent.result.toLowerCase() && (
            <SimulateBreach
              vault={vault}
              frozen={Boolean(frozen?.result)}
              monitor={mode?.result === 0}
              covered={Boolean(activeId?.result)}
            />
          )}
        </div>
      </div>
    </Page>
  );
}

function Cover({ activeId, history }: { activeId?: bigint; history?: bigint[] }) {
  const policy = useReadContract({
    address: deployment.coverManager,
    abi: coverManagerAbi,
    functionName: "getPolicy",
    args: [activeId ?? 0n],
    query: { enabled: Boolean(activeId) },
  });
  const owed = useReadContract({
    address: deployment.coverManager,
    abi: coverManagerAbi,
    functionName: "premiumOwed",
    args: [activeId ?? 0n],
    query: { enabled: Boolean(activeId), refetchInterval: 15_000 },
  });
  const p = policy.data;
  return (
    <Card title="Cover">
      {!activeId ? (
        <EmptyState title="No active cover">
          Depositors aren't protected yet. The guardian can buy cover from this page.
          {history && history.length > 0 && ` Past policies: ${history.map(String).join(", ")}.`}
        </EmptyState>
      ) : !p ? (
        <Loading what="policy" />
      ) : (
        <>
          <Grid>
            <Stat
              label={`Policy ${activeId}`}
              value={
                <Badge tone={p.status === 1 ? "safe" : "breach"}>
                  {POLICY_STATUS[p.status] ?? p.status}
                </Badge>
              }
            />
            <Stat
              label="Cover left"
              value={`$${usd(p.remainingCover, 0)}`}
              hint={`of $${usd(p.coverAmount, 0)}`}
            />
            <Stat
              label={<Term term="premium">Premium</Term>}
              value={bps(p.premiumRateBps)}
              hint="per year, streamed"
            />
            <Stat
              label="Premium owed"
              value={owed.data !== undefined ? `$${usd(owed.data)}` : "…"}
              hint={`paid until ${when(p.paidUntil)}`}
            />
          </Grid>
          <div
            className="mt-5 h-2 overflow-hidden rounded-full bg-sunken"
            role="img"
            aria-label="Cover left"
          >
            <div
              className="h-2 rounded-full bg-brand"
              style={{
                width: `${p.coverAmount > 0n ? Number((p.remainingCover * 1000n) / p.coverAmount) / 10 : 0}%`,
              }}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            Covers breaches from {when(p.coveredFrom)} to {when(p.endsAt)}. Priced at score{" "}
            {p.score}.
          </p>
        </>
      )}
    </Card>
  );
}

function DepositWithdraw(props: {
  vault: Address;
  wallet?: bigint;
  withdrawable?: bigint;
  connected: boolean;
}) {
  const { address: user } = useAccount();
  const [amount, setAmount] = useState("");
  const tx = useSend();
  const value = parseUsd(amount);
  const deposit = () =>
    user &&
    value &&
    tx.send([
      {
        address: deployment.usdg,
        abi: testTokenAbi as Abi,
        functionName: "approve",
        args: [props.vault, value],
        label: "Approve tUSDG",
      },
      {
        address: props.vault,
        abi: mandateVaultAbi as Abi,
        functionName: "deposit",
        args: [value, user],
        label: "Deposit",
      },
    ]);
  const withdraw = () =>
    user &&
    value &&
    tx.send([
      {
        address: props.vault,
        abi: mandateVaultAbi as Abi,
        functionName: "withdraw",
        args: [value, user, user],
        label: "Withdraw",
      },
    ]);
  return (
    <Card title="Deposit or withdraw">
      {!props.connected ? (
        <p className="text-sm text-muted">Connect a wallet to deposit or withdraw.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-sunken p-3 text-sm">
            <div>
              <dt className="text-xs text-muted">In your wallet</dt>
              <dd className="font-medium tabular-nums">
                ${props.wallet !== undefined ? usd(props.wallet) : "…"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Withdrawable</dt>
              <dd className="font-medium tabular-nums">
                ${props.withdrawable !== undefined ? usd(props.withdrawable) : "…"}
              </dd>
            </div>
          </dl>
          <Input
            label="Amount"
            value={amount}
            onChange={setAmount}
            placeholder="1000"
            inputMode="decimal"
            suffix="tUSDG"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={!value || tx.busy} onClick={deposit}>
              Deposit
            </Button>
            <Button kind="secondary" disabled={!value || tx.busy} onClick={withdraw}>
              Withdraw
            </Button>
          </div>
          <p className="text-xs text-muted">
            Need test tUSDG? Get some on the{" "}
            <Link to="/underwrite" className={linkClass}>
              Underwrite
            </Link>{" "}
            page.
          </p>
          {tx.view}
        </div>
      )}
    </Card>
  );
}

function BuyCover(props: {
  vault: Address;
  agentId?: bigint;
  isGuardian: boolean;
  hasActive: boolean;
}) {
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SignedQuoteResponse>();
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoting, setQuoting] = useState(false);
  const tx = useSend();
  const cover = parseUsd(amount);
  async function getQuote() {
    if (!cover || props.agentId === undefined) return;
    setQuoting(true);
    setQuoteError(null);
    setQuote(undefined);
    try {
      setQuote(
        await api.quote({
          agentId: props.agentId.toString(),
          vault: props.vault,
          coverAmount: cover.toString(),
        }),
      );
    } catch (e) {
      setQuoteError(e);
    } finally {
      setQuoting(false);
    }
  }
  const buy = async () => {
    if (!quote) return;
    const ok = await tx.send([
      {
        address: deployment.coverManager,
        abi: coverManagerAbi as Abi,
        functionName: "buyCover",
        args: [quoteMessage(quote.quote as Parameters<typeof quoteMessage>[0]), quote.signature],
        label: "Buy cover",
      },
    ]);
    if (ok) setQuote(undefined);
  };
  return (
    <Card title="Buy cover">
      <p className="mb-3 text-sm text-muted">
        Quotes are priced from the agent's on-chain score and bond, and the premium streams from the
        vault. Only the vault's guardian, who must also own the agent, can buy. Testnet cover is
        capped at {SELF_SERVE_MAX_COVER_USD.toLocaleString("en-US")} tUSDG.
      </p>
      {props.hasActive ? (
        <p className="text-sm text-muted">
          This vault is already covered. See the policy on the left.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3">
            <Input
              label="Cover amount"
              value={amount}
              onChange={(a) => (setAmount(a), setQuote(undefined))}
              placeholder="20000"
              inputMode="decimal"
              suffix="tUSDG"
            />
            <Button kind="secondary" disabled={!cover} loading={quoting} onClick={getQuote}>
              {quoting ? "Pricing…" : "Get quote"}
            </Button>
          </div>
          <ErrorText error={quoteError} />
          {quote && (
            <div className="flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent-soft/50 p-4 text-sm">
              <div>
                <p className="text-xs text-muted">Your quote</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {bps(quote.quote.premiumRateBps)}
                  <span className="ml-1 text-sm font-normal text-muted">a year</span>
                </p>
                <p className="text-muted">
                  for ${usd(BigInt(quote.quote.coverAmount), 0)} of cover, priced at score{" "}
                  {quote.quote.score}.
                </p>
              </div>
              <Button disabled={!props.isGuardian || tx.busy} onClick={buy}>
                Buy cover
              </Button>
              {!props.isGuardian && (
                <span className="text-xs text-muted">Connect the guardian's wallet to buy.</span>
              )}
            </div>
          )}
          {tx.view}
        </div>
      )}
    </Card>
  );
}

/** The guardian lets a frozen agent act again, e.g. after a claim has been paid. */
function Unfreeze({ vault }: { vault: Address }) {
  const tx = useSend();
  return (
    <Card title="Agent frozen" className="border-breach/40">
      <p className="mb-3 text-sm text-muted">
        A breach froze this vault's agent. As the guardian you can let it act again; any open claim
        is unaffected.
      </p>
      <Button
        disabled={tx.busy}
        onClick={() =>
          tx.send([
            {
              address: vault,
              abi: mandateVaultAbi as Abi,
              functionName: "unfreeze",
              args: [],
              label: "Unfreeze the agent",
            },
          ])
        }
      >
        Unfreeze the agent
      </Button>
      {tx.view}
    </Card>
  );
}

/** Where a simulated breach sends funds: the standard burn address, outside any mandate. */
const BURN = "0x000000000000000000000000000000000000dEaD";

/**
 * For testers whose wallet is the vault's agent key: send tUSDG out of the mandate, so the vault
 * records a breach and the keeper files the claim, exactly as if the agent had been tricked.
 */
function SimulateBreach(props: {
  vault: Address;
  frozen: boolean;
  monitor: boolean;
  covered: boolean;
}) {
  const [amount, setAmount] = useState("1000");
  const tx = useSend();
  const value = parseUsd(amount);
  const breach = () =>
    value &&
    tx.send([
      {
        address: props.vault,
        abi: mandateVaultAbi as Abi,
        functionName: "execute",
        args: [
          deployment.usdg,
          encodeFunctionData({ abi: testTokenAbi, functionName: "transfer", args: [BURN, value] }),
        ],
        label: "Send tUSDG outside the mandate",
      },
    ]);
  return (
    <Card
      title="Simulate a breach"
      actions={<Badge tone="warn">Testing only</Badge>}
      className="border-warn/40"
    >
      <p className="mb-3 text-sm text-muted">
        Your wallet is this vault's agent key, so you can act as a tricked agent: send tUSDG to the
        burn address, which no mandate allows. The vault records a breach and freezes the agent.
        {props.monitor
          ? props.covered
            ? " With cover active, the keeper files the claim within a minute: the operator's bond pays first, then the pool."
            : " Buy cover first if you want to see a claim paid."
          : " This vault is in Enforce mode, so the transfer is blocked: the breach is recorded with no loss, and nothing is claimed."}
      </p>
      {props.frozen ? (
        <p className="text-sm text-muted">
          The agent is frozen after a breach. The guardian can unfreeze it above.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            label="Amount"
            value={amount}
            onChange={setAmount}
            inputMode="decimal"
            suffix="tUSDG"
          />
          <Button kind="danger" disabled={!value || tx.busy} onClick={breach}>
            Simulate the breach
          </Button>
        </div>
      )}
      {tx.view}
    </Card>
  );
}

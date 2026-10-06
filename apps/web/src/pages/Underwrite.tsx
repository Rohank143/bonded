import { useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { Abi } from "viem";
import { coverManagerAbi, coverPoolAbi, testTokenAbi } from "@bonded/shared";
import { deployment, faucets } from "../config";
import { bps, duration, parseUsd, usd, when } from "../lib/format";
import {
  Button,
  Card,
  Details,
  Grid,
  Input,
  Loading,
  Page,
  Stat,
  Unavailable,
  linkClass,
} from "../components/ui";
import { isRpcUnavailable } from "../lib/errors";
import { useSend } from "../components/wallet";

const ZERO = "0x0000000000000000000000000000000000000000";
const pool = { address: deployment.pool, abi: coverPoolAbi } as const;
const manager = { address: deployment.coverManager, abi: coverManagerAbi } as const;

export function Underwrite() {
  const { address: user } = useAccount();
  const who = user ?? ZERO;
  const reads = useReadContracts({
    contracts: [
      { ...pool, functionName: "totalAssets" },
      { ...pool, functionName: "requiredCapital" },
      { ...pool, functionName: "freeCapital" },
      { ...pool, functionName: "cooldown" },
      { ...manager, functionName: "totalActiveCover" },
      { ...manager, functionName: "maxLeverageBps" },
      { ...manager, functionName: "maxAgentCoverBps" },
      { ...manager, functionName: "modelFamilyCapBps" },
      { ...pool, functionName: "balanceOf", args: [who] },
      { ...pool, functionName: "maxWithdraw", args: [who] },
      { ...pool, functionName: "withdrawRequests", args: [who] },
      { address: deployment.usdg, abi: testTokenAbi, functionName: "balanceOf", args: [who] },
    ],
    query: { refetchInterval: 15_000 },
  });
  if (reads.isLoading)
    return (
      <Page title="Underwrite">
        <Card>
          <Loading what="pool" lines={4} />
        </Card>
      </Page>
    );
  if (reads.isError || isRpcUnavailable(reads.data?.find((r) => r.error)?.error))
    return (
      <Page title="Underwrite">
        <Unavailable
          error={reads.error ?? reads.data?.find((r) => r.error)?.error}
          onRetry={() => void reads.refetch()}
        />
      </Page>
    );
  const r = reads.data ?? [];
  const n = (i: number) => r[i]?.result as bigint | undefined;
  const [tvl, required, free, cooldown, cover, leverage, agentCap, familyCap] = [
    0, 1, 2, 3, 4, 5, 6, 7,
  ].map(n);
  const shares = n(8);
  const redeemable = n(9);
  const request = r[10]?.result as readonly [bigint, bigint] | undefined;
  const wallet = n(11);
  const utilisation = tvl && cover !== undefined && tvl > 0n ? Number((cover * 10_000n) / tvl) : 0;
  const $ = (v?: bigint) => (v === undefined ? "…" : `$${usd(v, 0)}`);
  return (
    <Page
      title="Underwrite"
      eyebrow="Cover pool"
      intro="Back the pool that pays claims, and earn 80% of every premium."
    >
      <Card
        title="Cover pool"
        description="The pool pays whatever the operator's bond doesn't. Withdrawals wait out a cooldown and can only use capital that isn't backing active cover."
      >
        <Grid>
          <Stat label="Pool assets" value={$(tvl)} hint="tUSDG" />
          <Stat label="Active cover" value={$(cover)} hint={`${bps(utilisation)} of pool`} />
          <Stat label="Capital backing cover" value={$(required)} />
          <Stat label="Free capital" value={$(free)} />
        </Grid>
        <div className="mt-6">
          <div className="mb-1.5 flex justify-between text-xs text-muted">
            <span>Active cover as a share of the pool</span>
            <span className="tabular-nums">{bps(utilisation)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-sunken">
            <div
              className="h-2 rounded-full bg-brand"
              style={{ width: `${Math.min(utilisation / 100, 100)}%` }}
            />
          </div>
        </div>
        <Details>
          <dt>Total cover limit</dt>
          <dd>{leverage !== undefined ? `${bps(leverage)} of pool assets` : "…"}</dd>
          <dt>One agent at most</dt>
          <dd>{agentCap !== undefined ? `${bps(agentCap)} of pool assets` : "…"}</dd>
          <dt>One model family at most</dt>
          <dd>{familyCap !== undefined ? `${bps(familyCap)} of pool assets` : "…"}</dd>
          <dt>Withdrawal cooldown</dt>
          <dd>{cooldown !== undefined ? duration(cooldown) : "…"}</dd>
        </Details>
      </Card>
      {!user ? (
        <Card title="Your position">
          <p className="text-sm text-muted">
            Connect a wallet to deposit, withdraw or get test tUSDG.
          </p>
        </Card>
      ) : (
        <Position wallet={wallet} shares={shares} redeemable={redeemable} request={request} />
      )}
      <p className="text-xs text-muted">
        Need test ETH for gas? Use a public faucet:{" "}
        {faucets.map((f, i) => (
          <a key={f} href={f} className={linkClass} target="_blank" rel="noreferrer">
            {i ? ", " : ""}
            {new URL(f).hostname}
          </a>
        ))}
        .
      </p>
    </Page>
  );
}

function Position(props: {
  wallet?: bigint;
  shares?: bigint;
  redeemable?: bigint;
  request?: readonly [bigint, bigint];
}) {
  const { address: user } = useAccount();
  const [amount, setAmount] = useState("");
  const tx = useSend();
  const value = parseUsd(amount);
  const call = (
    functionName: string,
    args: readonly unknown[],
    label: string,
    address = deployment.pool,
    abi: Abi = coverPoolAbi as Abi,
  ) => ({ address, abi, functionName, args, label });
  const [requestedShares, unlockAt] = props.request ?? [0n, 0n];
  // Pool shares carry 12 decimals (6 plus a 6-decimal offset against inflation attacks), so show
  // their value in tUSDG instead of the raw share count.
  const values = useReadContracts({
    contracts: [
      { ...pool, functionName: "convertToAssets", args: [props.shares ?? 0n] },
      { ...pool, functionName: "convertToAssets", args: [requestedShares] },
    ],
  });
  const [stake, requested] = (values.data ?? []).map((v) => v.result as bigint | undefined);
  return (
    <Card title="Your position">
      <Grid>
        <Stat
          label="Wallet"
          value={props.wallet !== undefined ? `$${usd(props.wallet)}` : "…"}
          hint="tUSDG"
        />
        <Stat
          label="Your stake"
          value={stake !== undefined ? `$${usd(stake)}` : "…"}
          hint="value of your pool shares"
        />
        <Stat
          label="Withdrawable now"
          value={props.redeemable !== undefined ? `$${usd(props.redeemable)}` : "…"}
        />
        <Stat
          label="Withdrawal request"
          value={
            requestedShares > 0n ? (requested !== undefined ? `$${usd(requested)}` : "…") : "none"
          }
          hint={requestedShares > 0n ? `unlocks ${when(unlockAt)}` : undefined}
        />
      </Grid>
      <div className="mt-6 grid gap-6 border-t border-line pt-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold">Deposit</p>
          <Input
            label="Amount"
            value={amount}
            onChange={setAmount}
            placeholder="10000"
            inputMode="decimal"
            suffix="tUSDG"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!value || tx.busy}
              onClick={() =>
                value &&
                user &&
                tx.send([
                  call(
                    "approve",
                    [deployment.pool, value],
                    "Approve tUSDG",
                    deployment.usdg,
                    testTokenAbi as Abi,
                  ),
                  call("deposit", [value, user], "Deposit"),
                ])
              }
            >
              Deposit
            </Button>
            <Button
              kind="ghost"
              disabled={tx.busy}
              onClick={() =>
                tx.send([
                  call(
                    "faucet",
                    [10_000_000_000n],
                    "Get 10,000 tUSDG",
                    deployment.usdg,
                    testTokenAbi as Abi,
                  ),
                ])
              }
            >
              Get 10,000 test tUSDG
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold">Withdraw</p>
          <p className="text-sm text-muted">
            Request a withdrawal, wait out the cooldown, then withdraw what's free.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              kind="secondary"
              disabled={!props.shares || tx.busy}
              onClick={() =>
                props.shares &&
                tx.send([call("requestRedeem", [props.shares], "Request withdrawal")])
              }
            >
              Request withdrawal of all shares
            </Button>
            <Button
              kind="secondary"
              disabled={!props.redeemable || tx.busy}
              onClick={() =>
                user &&
                props.redeemable &&
                tx.send([call("withdraw", [props.redeemable, user, user], "Withdraw")])
              }
            >
              Withdraw available
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-2">{tx.view}</div>
    </Card>
  );
}

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Hex,
  type Address,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmDeployment } from "@bondedhq/shared";

/** Durable callers can track the uncertain interval around an RPC broadcast. */
export interface SendLifecycle {
  /** Reuse this nonce (a retry of a send whose outcome is unknown); default: the next one. */
  nonce?: number;
  /** Called with the nonce the transaction will use, before it is broadcast. */
  beforeBroadcast: (nonce: number) => Promise<void>;
  onBroadcast: (hash: Hex) => Promise<void>;
  onReverted: () => Promise<void>;
}

const transactions = new Map<string, Promise<unknown>>();
/** Connect a deployment and serialize writes per chain/account to avoid nonce races. */
export function connectChain(deployment: EvmDeployment, rpcUrl: string, key: Hex): ServiceChain {
  const chain = defineChain({
    id: deployment.chainId,
    name: "Bonded",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const read = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 250 });
  const wallet = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account: privateKeyToAccount(key),
  });
  return {
    deployment,
    read,
    wallet,
    /** Simulate, estimate with a margin, serialize the send and require a successful receipt. */
    async send(
      address: Address,
      abi: Abi,
      functionName: string,
      args: readonly unknown[],
      lifecycle?: SendLifecycle,
    ) {
      const accountKey = `${deployment.chainId}:${wallet.account.address}`;
      const previous = transactions.get(accountKey) ?? Promise.resolve();
      const pending = previous
        .catch(() => {})
        .then(async () => {
          const { request } = await read.simulateContract({
            address,
            abi,
            functionName,
            args,
            account: wallet.account,
          });
          const estimate = await read.estimateContractGas({
            address,
            abi,
            functionName,
            args,
            account: wallet.account,
          });
          // A tracked send fixes its nonce first, so its caller can tell later whether it landed.
          const nonce = lifecycle
            ? (lifecycle.nonce ??
              (await read.getTransactionCount({
                address: wallet.account.address,
                blockTag: "pending",
              })))
            : undefined;
          if (lifecycle) await lifecycle.beforeBroadcast(nonce!);
          const hash = await wallet.writeContract({
            ...request,
            gas: (estimate * 12n) / 10n + 30000n,
            ...(nonce === undefined ? {} : { nonce }),
          });
          await lifecycle?.onBroadcast(hash);
          const receipt = await read.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            await lifecycle?.onReverted();
            throw new Error(`${functionName} reverted: ${hash}`);
          }
          return hash;
        });
      transactions.set(accountKey, pending);
      try {
        return await pending;
      } finally {
        if (transactions.get(accountKey) === pending) transactions.delete(accountKey);
      }
    },
  };
}
export interface ServiceChain {
  deployment: EvmDeployment;
  read: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
  send(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    lifecycle?: SendLifecycle,
  ): Promise<Hex>;
}

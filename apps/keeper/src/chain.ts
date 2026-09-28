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
import type { EvmDeployment } from "@bonded/shared";

const transactions = new Map<string, Promise<unknown>>();
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
    async send(address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
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
          const hash = await wallet.writeContract({
            ...request,
            gas: (estimate * 12n) / 10n + 30000n,
          });
          const receipt = await read.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
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
  send(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Hex>;
}

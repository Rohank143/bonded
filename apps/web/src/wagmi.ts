import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { robinhoodTestnet, rpcUrl } from "./config";

/** Browser wallets only (MetaMask, Rabby and similar). Reads go through the configured RPC. */
export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors: [injected()],
  transports: { [robinhoodTestnet.id]: http(rpcUrl) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

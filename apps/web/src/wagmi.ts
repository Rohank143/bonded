import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  phantomWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { robinhoodTestnet, rpcUrl } from "./config";

const projectId =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() ?? "";
const connectors = connectorsForWallets(
  [
    {
      groupName: "Wallets",
      wallets: [
        phantomWallet,
        rabbyWallet,
        ...(projectId ? [metaMaskWallet, rainbowWallet, walletConnectWallet] : []),
        injectedWallet,
      ],
    },
  ],
  // Injected wallets do not use a project ID. QR/mobile connectors require a real one.
  { appName: "Bonded", projectId },
);

/** RainbowKit owns wallet selection and connection. Reads use the configured chain RPC. */
export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors,
  transports: { [robinhoodTestnet.id]: http(rpcUrl) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

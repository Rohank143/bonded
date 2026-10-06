import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "./wagmi";
import { robinhoodTestnet } from "./config";
import { Layout } from "./App";
import { OperatorTokenProvider } from "./components/wallet";
import { Landing } from "./pages/Landing";
import { Arena } from "./pages/Arena";
import { Agent } from "./pages/Agent";
import { Vaults } from "./pages/Vaults";
import { Vault } from "./pages/Vault";
import { Underwrite } from "./pages/Underwrite";
import { Claims } from "./pages/Claims";
import { Leaderboard } from "./pages/Leaderboard";
import { Bounties } from "./pages/Bounties";
import { NotFound } from "./pages/NotFound";
import { NewAgent } from "./pages/NewAgent";
import { Agents } from "./pages/Agents";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/arena", element: <Arena /> },
      { path: "/agents", element: <Agents /> },
      { path: "/agents/new", element: <NewAgent /> },
      { path: "/agents/:id", element: <Agent /> },
      { path: "/vaults", element: <Vaults /> },
      { path: "/vaults/:address", element: <Vault /> },
      { path: "/underwrite", element: <Underwrite /> },
      { path: "/claims", element: <Claims /> },
      { path: "/leaderboard", element: <Leaderboard /> },
      { path: "/bounties", element: <Bounties /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
// The wallet button and modal in the brand: blue accent, Inter, the app's corner radius.
const walletFont = '"Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif';
const lightWallet = lightTheme({
  accentColor: "#1d4ed8",
  accentColorForeground: "#ffffff",
  borderRadius: "medium",
});
const darkWallet = darkTheme({
  accentColor: "#1d4ed8",
  accentColorForeground: "#ffffff",
  borderRadius: "medium",
});
const walletTheme = {
  lightMode: { ...lightWallet, fonts: { body: walletFont } },
  darkMode: {
    ...darkWallet,
    fonts: { body: walletFont },
    colors: {
      ...darkWallet.colors,
      modalBackground: "#151b22",
      connectButtonBackground: "#151b22",
    },
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={robinhoodTestnet} theme={walletTheme} modalSize="compact">
          <OperatorTokenProvider>
            <RouterProvider router={router} />
          </OperatorTokenProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);

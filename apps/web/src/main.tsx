import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "./wagmi";
import { robinhoodTestnet } from "./config";
import { AppLayout, SiteLayout } from "./App";
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
  { element: <SiteLayout />, children: [{ path: "/", element: <Landing /> }] },
  {
    element: <AppLayout />,
    children: [
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
// The wallet button and modal in the Aurora style: brand blue, Manrope, the app's dark surfaces.
const base = darkTheme({
  accentColor: "#1d4ed8",
  accentColorForeground: "#ffffff",
  borderRadius: "large",
});
const walletTheme = {
  ...base,
  fonts: { body: '"Manrope Variable", "Manrope", ui-sans-serif, system-ui, sans-serif' },
  colors: {
    ...base.colors,
    modalBackground: "#0e1320",
    connectButtonBackground: "#0e1320",
    connectButtonInnerBackground: "#151b2b",
    generalBorder: "rgba(255,255,255,0.08)",
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

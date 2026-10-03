import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./wagmi";
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
import "./index.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/arena", element: <Arena /> },
      { path: "/agents/:id", element: <Agent /> },
      { path: "/vaults", element: <Vaults /> },
      { path: "/vaults/:address", element: <Vault /> },
      { path: "/underwrite", element: <Underwrite /> },
      { path: "/claims", element: <Claims /> },
      { path: "/leaderboard", element: <Leaderboard /> },
      { path: "/bounties", element: <Bounties /> },
      { path: "*", element: <p className="text-sm text-muted">Page not found.</p> },
    ],
  },
]);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OperatorTokenProvider>
          <RouterProvider router={router} />
        </OperatorTokenProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);

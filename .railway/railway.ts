import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

// Bonded's Railway project. One Docker image runs as three services; ROLE selects what each does.
// See docs/SERVICES.md. Signing keys and the API token are secrets set in Railway, never here:
// preserve() keeps the value already stored on Railway.
export default defineRailway(() => {
  const repo = github("ddboy19912/bonded", { branch: "main", checkSuites: false });

  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 5000,
  });

  const shared = {
    DATABASE_URL: Postgres.env.DATABASE_URL,
    RPC_URL: "https://rpc.testnet.chain.robinhood.com/rpc",
    DEPLOYMENT_FILE: "contracts/evm/deployments/46630.json",
  };
  const role = (deploy: { healthcheckPath?: string; healthcheckTimeout?: number }) => ({
    source: repo,
    build: { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" },
    deploy: {
      startCommand: "node apps/api/dist/main.js",
      restartPolicyType: "ON_FAILURE" as const,
      restartPolicyMaxRetries: 10,
      sleepApplication: false,
      ...deploy,
    },
    replicas: { sfo: 1 },
  });

  const api = service("api", {
    ...role({ healthcheckPath: "/health", healthcheckTimeout: 120 }),
    env: { ...shared, ROLE: "api", API_TOKEN: preserve(), ATTESTER_KEY: preserve() },
  });
  // The keeper and worker have no HTTP listener, so no health check.
  const keeper = service("keeper", {
    ...role({}),
    env: { ...shared, ROLE: "keeper", KEEPER_KEY: preserve() },
  });
  const arenaWorker = service("arena-worker", {
    ...role({}),
    env: { ...shared, ROLE: "arena-worker", ATTESTER_KEY: preserve() },
  });

  return project("zippy-spirit", {
    resources: [Postgres, postgresVolume, api, keeper, arenaWorker],
  });
});

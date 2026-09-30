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
    // Complete set of agents the worker may rate; see docs/SERVICES.md.
    AGENTS_FILE: "config/agents.46630.json",
  };
  const role = (deploy: { healthcheckPath?: string; healthcheckTimeout?: number }) => ({
    source: repo,
    build: { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" },
    deploy: {
      // Restart on failure (10 retries) and sleeping off are Railway's defaults; Railway stores
      // defaults as null, so spelling them out here makes every plan show a false change.
      startCommand: "node apps/api/dist/main.js",
      ...deploy,
    },
    replicas: { sfo: 1 },
  });

  const api = service("api", {
    ...role({ healthcheckPath: "/health", healthcheckTimeout: 120 }),
    env: {
      ...shared,
      ROLE: "api",
      // Browser origins allowed by CORS (comma-separated). Add the hosted web app's URL here.
      WEB_ORIGINS: "http://localhost:5173",
      API_TOKEN: preserve(),
      ATTESTER_KEY: preserve(),
    },
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

  // Sentinel (services/sentinel, docs/SENTINEL.md): Laya's server in its own Python image,
  // reachable only on the private network at http://sentinel.railway.internal:8000. Railway has
  // no GPUs, so it runs on CPU at about 2.5 s a check. The model downloads on start, hence the
  // long health check. HF_TOKEN is a read-only Hugging Face token for the private model repo;
  // LAYA_API_KEY is the bearer key callers send. Both are set in Railway, never here.
  const sentinel = service("sentinel", {
    source: github("ddboy19912/bonded", {
      branch: "main",
      checkSuites: false,
      rootDirectory: "services/sentinel",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["services/sentinel/**"],
    },
    deploy: {
      healthcheckPath: "/health",
      healthcheckTimeout: 600,
      // The container uses a little over 2 GB after loading and more while checking; Railway
      // bills memory used, not this cap.
      limitOverride: { containers: { cpu: 2, memoryBytes: 4 * 1024 ** 3 } },
    },
    replicas: { sfo: 1 },
    networking: { privateNetworkEndpoint: "sentinel" },
    env: {
      PORT: "8000",
      LAYA_THREADS: "2",
      SENTINEL_MODEL_REPO: "ddboy19912/bonded-sentinel-laya",
      // Fine-tune v1 (docs/progress/DAY-10.md). Change only after the held-out evaluation.
      SENTINEL_MODEL_REVISION: "22d2ad765058158a1a3c7472ac551690a05fe1e6",
      HF_TOKEN: preserve(),
      LAYA_API_KEY: preserve(),
    },
  });

  return project("zippy-spirit", {
    resources: [Postgres, postgresVolume, api, keeper, arenaWorker, sentinel],
  });
});

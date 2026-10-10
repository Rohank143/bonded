import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AgentMode } from "@bondedhq/shared";
import { gatewayUrlProblem } from "./tail.js";

export const SERVICE_USAGE = `Usage: bonded-runner service --print systemd|pm2|docker --gateway <url> [options] -- <agent command...>

Prints a ready config that keeps the runner running in the background, restarts it if it stops,
and starts it at boot. Nothing is installed or written: copy what it prints. The runner token is
never put in the config; it is read from an environment file (systemd, Docker) or your shell (pm2).

  --print <kind>      systemd (a unit file), pm2 (an ecosystem file) or docker (a Dockerfile and
                      the docker run line, with --restart unless-stopped)
  --gateway <url>     the Arena Gateway (or BONDED_GATEWAY_URL)
  --mode tools|chain  default tools
  --name <name>       the service's name (default bonded-runner)
  --dir <folder>      the agent's folder (default: this one)
  --user <user>       systemd: the user it runs as (default: you)

Example:
  bonded-runner service --print systemd --gateway https://arena.example.com -- node agent.js`;

export type ServiceKind = "systemd" | "pm2" | "docker";

export interface ServiceOptions {
  kind: ServiceKind;
  gateway: string;
  mode: AgentMode;
  command: string[];
  name: string;
  dir: string;
  user: string;
  /** Folder of the node binary, for systemd's PATH. */
  nodeBin: string;
}

/** A systemd ExecStart word (systemd's own quoting: double quotes, backslash escapes). */
function systemdWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
    ? word
    : `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;
}

function runnerArgs(o: ServiceOptions): string[] {
  return [
    "--gateway",
    o.gateway,
    ...(o.mode === "chain" ? ["--mode", "chain"] : []),
    "--",
    ...o.command,
  ];
}

export function serviceConfig(o: ServiceOptions): string {
  const args = runnerArgs(o);
  const envFile = `${o.dir}/${o.name}.env`;
  switch (o.kind) {
    case "systemd":
      return `# /etc/systemd/system/${o.name}.service
# 1. Put your runner token in ${envFile} (one line: BONDED_RUNNER_TOKEN=...), then
#    chmod 600 ${envFile}
# 2. sudo cp ${o.name}.service /etc/systemd/system/ && sudo systemctl daemon-reload
# 3. sudo systemctl enable --now ${o.name}   (logs: journalctl -u ${o.name} -f)
[Unit]
Description=Bonded runner (${basename(o.dir)})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${o.user}
WorkingDirectory=${o.dir}
EnvironmentFile=${envFile}
Environment=PATH=${o.nodeBin}:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env npx --yes @bondedhq/runner ${args.map(systemdWord).join(" ")}
Restart=always
RestartSec=10
# Exit code 2: the token was refused or another runner took over. Restarting won't help.
RestartPreventExitStatus=2
KillMode=mixed
TimeoutStopSec=15
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
    case "pm2":
      return `// ecosystem.config.cjs: start it with your runner token in the environment:
//   BONDED_RUNNER_TOKEN=... pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup   (starts it again at boot; pm2 keeps the token in its dump file)
module.exports = {
  apps: [
    {
      name: ${JSON.stringify(o.name)},
      cwd: ${JSON.stringify(o.dir)},
      script: "npx",
      args: ${JSON.stringify(["--yes", "@bondedhq/runner", ...args])},
      interpreter: "none",
      autorestart: true,
      restart_delay: 10000,
      // Exit code 2: the token was refused or another runner took over. Restarting won't help.
      stop_exit_codes: [2],
      kill_timeout: 15000,
    },
  ],
};
`;
    case "docker": {
      const cmd = JSON.stringify(args);
      // Not "bonded-runner": that is the base image's name.
      const image = `${o.name}-agent`;
      return `# Dockerfile, in your agent's folder. It builds on the runner's image: build that once from a
# clone of the Bonded repository (docker build -f apps/runner/Dockerfile -t bonded-runner .).
FROM bonded-runner
COPY --chown=node:node . /agent
WORKDIR /agent
RUN npm ci --omit=dev   # or your package manager's install
CMD ${cmd}

# Then, with your runner token in ${o.name}.env (one line: BONDED_RUNNER_TOKEN=...):
#   docker build -t ${image} .
#   docker run -d --name ${o.name} --restart unless-stopped --env-file ${o.name}.env \\
#     -e BONDED_IMAGE_DIGEST="$(docker inspect --format '{{.Id}}' ${image})" ${image}
# --restart unless-stopped starts it again after a crash or a reboot, until you docker stop it.
# BONDED_IMAGE_DIGEST pins the code hash to the image (the image has no git).
`;
    }
  }
}

export function serviceCommand(
  argv: string[],
  io: {
    cwd: string;
    env: Record<string, string | undefined>;
    out: (text: string) => void;
    err: (text: string) => void;
    user?: string;
    nodeBin?: string;
  },
): number {
  const dash = argv.indexOf("--");
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  let values;
  try {
    ({ values } = parseArgs({
      args: dash >= 0 ? argv.slice(0, dash) : argv,
      options: {
        print: { type: "string" },
        gateway: { type: "string" },
        mode: { type: "string", default: "tools" },
        name: { type: "string", default: "bonded-runner" },
        dir: { type: "string" },
        user: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${SERVICE_USAGE}`);
    return 1;
  }
  if (values.help) {
    io.out(SERVICE_USAGE);
    return 0;
  }
  const kind = values.print;
  const gateway = values.gateway ?? io.env.BONDED_GATEWAY_URL;
  const mode = AgentMode.safeParse(values.mode);
  const missing = [
    !(kind === "systemd" || kind === "pm2" || kind === "docker") && "--print systemd|pm2|docker",
    !gateway && "--gateway",
    !mode.success && "--mode tools|chain",
    command.length === 0 && "an agent command after --",
    !/^[A-Za-z0-9_.-]+$/.test(values.name) && "--name (letters, digits, . _ -)",
  ].filter(Boolean);
  if (missing.length) {
    io.err(`${SERVICE_USAGE}\n\nMissing or invalid: ${missing.join(", ")}`);
    return 1;
  }
  const problem = gatewayUrlProblem(gateway!);
  if (problem) {
    io.err(problem);
    return 1;
  }
  io.out(
    serviceConfig({
      kind: kind as ServiceKind,
      gateway: gateway!,
      mode: mode.data!,
      command,
      name: values.name,
      dir: resolve(io.cwd, values.dir ?? "."),
      user: values.user ?? io.user ?? io.env.USER ?? "node",
      nodeBin: io.nodeBin ?? dirname(process.execPath),
    }),
  );
  return 0;
}

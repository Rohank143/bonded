# The Bonded runner as a container image. Build from the repository root:
#
#   docker build -f apps/runner/Dockerfile -t bonded-runner .
#
# The image runs the runner; your agent goes on top of it:
#
#   FROM bonded-runner
#   COPY --chown=node:node my-agent /agent
#   RUN cd /agent && npm ci --omit=dev
#   CMD ["--gateway", "https://arena.example.com", "--", "node", "/agent/index.js"]
#
# and pass the runner token at run time: docker run -e BONDED_RUNNER_TOKEN=... my-agent-image
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@bonded/runner..." \
  && pnpm exec turbo run build --filter=@bonded/runner \
  && pnpm --filter @bonded/runner deploy --legacy --prod /out

FROM node:22-bookworm-slim
WORKDIR /runner
COPY --from=build /out ./
# The runner needs no privileges, and neither should the agent it starts.
USER node
ENTRYPOINT ["node", "/runner/dist/cli.js"]
CMD ["--help"]

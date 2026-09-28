FROM ghcr.io/foundry-rs/foundry:stable AS foundry
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm contracts:build
ENV ROLE=api PORT=3000
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

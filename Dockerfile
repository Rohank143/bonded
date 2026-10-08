FROM ghcr.io/foundry-rs/foundry:stable AS foundry
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast
WORKDIR /app
COPY . .
# Railway builds from a source snapshot without git submodules, and .dockerignore drops the git
# metadata that local submodule checkouts point to. Unless a library's checked-out commit is readable
# and equal to its pin, replace it with a fresh fetch of the pinned commit. Pins come from
# git ls-tree HEAD contracts/evm/lib/forge-std contracts/evm/lib/openzeppelin-contracts
ARG FORGE_STD_COMMIT=bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
ARG OPENZEPPELIN_COMMIT=cab19933c33c2ad1d4c7a84864a3601dddfd16f3
RUN fetch() { \
      if [ "$(git -C "$1" rev-parse HEAD 2>/dev/null)" != "$3" ]; then \
        rm -rf "$1" && git init -q "$1" && \
        git -C "$1" fetch -q --depth 1 "$2" "$3" && git -C "$1" checkout -q FETCH_HEAD; \
      fi; \
      actual=$(git -C "$1" rev-parse HEAD) || { echo "$1 has no checked-out commit" >&2; exit 1; }; \
      [ "$actual" = "$3" ] || { echo "$1 is not at $3" >&2; exit 1; }; \
    }; \
    fetch contracts/evm/lib/forge-std https://github.com/foundry-rs/forge-std "$FORGE_STD_COMMIT" && \
    fetch contracts/evm/lib/openzeppelin-contracts https://github.com/OpenZeppelin/openzeppelin-contracts "$OPENZEPPELIN_COMMIT"
# The services only need the protocol's own contracts: they always rate on a fork of the live
# chain with its committed deployment, and src/ and script/ import nothing beyond the two
# libraries fetched above. Everything under test/ (not only *.t.sol) is skipped: the module tests
# import test-only libraries (Safe7579, the Safe contracts, the ERC-7579 reference account) that
# this image doesn't fetch.
RUN pnpm install --frozen-lockfile && pnpm exec turbo run build --filter="!@bonded/web" && \
    cd contracts/evm && forge build --skip 'test/**'
ENV ROLE=api PORT=3000
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

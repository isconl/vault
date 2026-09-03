# vault engine -- portable container build, same shape across every isconl
# engine (vault/pulse/scope/circle/spark/hub) on purpose: one Dockerfile
# pattern to maintain, not six bespoke ones.
#
# node:20-slim (Debian/glibc), not -alpine: @bitwarden/sdk-napi is a native
# N-API module: musl (alpine) breaks native bindings built against glibc.
FROM node:20-slim

# better-sqlite3-multiple-ciphers has no prebuilt binary for every
# platform/arch combo (confirmed missing on linux-arm64, e.g. the OCI
# Ampere A1 VM this fleet deploys to) -- npm falls back to compiling it
# from source via node-gyp, which needs python3 + a C/C++ toolchain,
# neither present in the base -slim image. @bitwarden/sdk-napi (every
# other engine's only native dep) does ship prebuilt binaries and doesn't
# need this -- only vault carries better-sqlite3-multiple-ciphers, so this
# extra toolchain is deliberately just here, not copied into every
# Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY src ./src

# Real fail-closed bind guard already in src/server.js: refuses to bind
# 0.0.0.0 without a configured token. Set VAULT_TOKEN (or ISCONL_TOKEN) and
# VAULT_BIND=0.0.0.0 at runtime -- not baked into the image.
EXPOSE 8081
CMD ["node", "src/server.js"]

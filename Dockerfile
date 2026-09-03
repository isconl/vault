# vault engine -- portable container build, same shape across every isconl
# engine (vault/pulse/scope/circle/spark/hub) on purpose: one Dockerfile
# pattern to maintain, not six bespoke ones. vault is the one deliberate
# exception (Node 22, not 20 -- see below).
#
# node:*-slim (Debian/glibc), not -alpine: @bitwarden/sdk-napi is a native
# N-API module: musl (alpine) breaks native bindings built against glibc.
#
# Node 22, not the other 6 engines' Node 20 -- found live, standing up the
# docker deploy on the OCI VM (linux/arm64, Oracle Ampere A1): the
# better-sqlite3-multiple-ciphers prebuild for linux-arm64 (confirmed
# correct ELF/arch, all shared libs resolve, not a missing-binary or
# wrong-architecture problem) reproducibly segfaults (SIGSEGV, no JS-level
# error at all) on `new Database()` under Node 20 on this host, works
# cleanly under Node 22 -- confirmed by isolating the exact same
# node_modules install under each base image, nothing else different. The
# live bare-node deployment on this same VM already runs Node 22
# (`node --version` on the host: v22.23.2), so this isn't a new runtime
# being introduced, just matching what's already proven to work here.
# Scoped to vault alone (not all 7 Dockerfiles) because
# better-sqlite3-multiple-ciphers is vault's own dependency only -- the
# other 6 engines' sole native module, @bitwarden/sdk-napi, already builds
# and runs clean under Node 20, confirmed live.
FROM node:22-slim

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

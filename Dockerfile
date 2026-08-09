# vault engine -- portable container build, same shape across every isconl
# engine (vault/pulse/scope/circle/spark/hub) on purpose: one Dockerfile
# pattern to maintain, not six bespoke ones.
#
# node:20-slim (Debian/glibc), not -alpine: @bitwarden/sdk-napi is a native
# N-API module: musl (alpine) breaks native bindings built against glibc.
FROM node:20-slim

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

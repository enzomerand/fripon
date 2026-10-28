# Fripon Cloud server image.
#
# The build context is the REPOSITORY ROOT, not server/: the server bundles modules from ../lib.
#   docker build -f server/Dockerfile -t fripon-cloud .
# `server/compose.yml` does exactly that. `.dockerignore` (at the root) keeps the context small.

# The Node image is pinned to an exact version: a rebuild must not move the runtime by itself. Bump it
# on purpose (security releases: https://nodejs.org/en/about/previous-releases), keep it on 22.x.
# ---- build: all dependencies, the esbuild bundle, then only the production dependencies ----
FROM node:22.23.4-bookworm-slim AS build

# better-sqlite3 compiles its native module at install when no prebuilt binary matches this Node
# version (seen with 22.23.4): the toolchain lives in THIS stage only, the runtime stage never needs it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

# `../lib` of the server's imports is /app/lib.
COPY lib /app/lib
COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/scripts ./scripts
# The bundles keep their npm packages external (--packages=external): after the build, only the
# production ones stay in node_modules. dist/stripe-resync.js is the one-off maintenance command
# (`docker compose exec fripon-cloud node dist/stripe-resync.js`, see docs/cloud.md) and
# dist/stripe-setup.js the Stripe setup that `scripts/configure.sh` runs on the server.
RUN npm run build && npm run build:resync && npm run build:setup && npm prune --omit=dev

# ---- runtime: production node_modules + the bundle, nothing else ----
FROM node:22.23.4-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATABASE_PATH=/data/fripon.db

WORKDIR /app
# package.json carries "type": "module": without it Node would read dist/main.js as CommonJS.
COPY server/package.json ./package.json
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist/main.js ./dist/main.js
COPY --from=build /app/server/dist/stripe-resync.js ./dist/stripe-resync.js
COPY --from=build /app/server/dist/stripe-setup.js ./dist/stripe-setup.js

# The SQLite database (and its -wal / -shm files) lives in /data. The directory is created and
# handed to the `node` user (uid 1000) before VOLUME, so a new named volume inherits that owner.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data

EXPOSE 8787

# /healthz runs a query on the database. No curl in the image: Node's own fetch does the call.
HEALTHCHECK --interval=30s --timeout=6s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# main.ts closes the server and the database on SIGTERM (it waits up to 45 s for the requests in flight).
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]

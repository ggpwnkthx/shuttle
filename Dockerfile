# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- dependencies
FROM oven/bun:1.4.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ------------------------------------------------------------------- fixtures
#
# The development identity provider, the access fixture and the sample
# upstreams. They exist for the tests and for the local stack, they are not
# part of a deployment: the identity provider holds accounts with known
# passwords and the access fixture decides with a static policy.
#
# This stage is never used for the gateway. It refuses to start in an
# environment that is marked as production.
FROM oven/bun:1.4.3-alpine AS fixtures
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY services ./services
COPY package.json ./

USER bun
EXPOSE 5556
ENTRYPOINT ["bun", "run"]
CMD ["services/oidc-provider.ts"]

# ------------------------------------------------------------------- runtime
#
# The production image contains the gateway and nothing else. The fixtures
# with their known accounts and their static policies are not copied into it.
FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SHUTTLE_CONFIG=/etc/shuttle/routes.json \
    SHUTTLE_GATEWAY_PORT=8080

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY config ./config
COPY package.json ./

USER bun
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "run"]
CMD ["src/index.ts"]

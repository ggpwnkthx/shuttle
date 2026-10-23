# syntax=docker/dockerfile:1

# The version of the runtime and the revision of the build are labels of the
# image: an operator has to know what is running without reading the logs.
ARG BUN_VERSION=1.4.3
ARG VERSION=1.3.0
ARG REVISION=unknown

# ---------------------------------------------------------------- dependencies
#
# The dependencies of the gateway alone. The development dependencies (the
# fixtures of the tests) are not part of the image of the gateway.
FROM oven/bun:${BUN_VERSION}-alpine AS runtime-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && \
    rm -rf /root/.bun/install/cache

# ------------------------------------------------------------------- fixtures
#
# The development identity provider, the access fixture and the sample
# upstreams. They exist for the tests and for the local stack, they are not
# part of a deployment: the identity provider holds accounts with known
# passwords and the access fixture decides with a static policy.
#
# This stage is never used for the gateway. It refuses to start in an
# environment that is marked as production.
FROM oven/bun:${BUN_VERSION}-alpine AS fixtures
WORKDIR /app
ENV NODE_ENV=development
# The fixtures need the development dependencies (the identity provider is
# one of them), so this stage installs everything.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY services ./services
COPY package.json ./

USER bun
EXPOSE 5556
ENTRYPOINT ["bun", "run"]
CMD ["services/oidc-provider.ts"]

# ------------------------------------------------------------------- access
#
# The reference implementation of the access service. It is not part of
# the gateway: it is the service the gateway asks about the workspaces, and
# a deployment that has its own does not need this one. The implementation
# uses nothing but the runtime, so the image carries no dependency.
FROM oven/bun:${BUN_VERSION}-alpine AS access-service
WORKDIR /app
ENV NODE_ENV=production

COPY services/access-service.ts ./services/access-service.ts

USER bun
EXPOSE 8090
ENTRYPOINT ["bun", "run"]
CMD ["services/access-service.ts"]

# ---------------------------------------------------------- control binary
#
# The control plane is a separate process. It is the same code and the same
# dependencies, and it is compiled into a binary of its own for the
# deployments that run a binary and not the sources.
FROM oven/bun:${BUN_VERSION}-alpine AS control-binary
WORKDIR /app
ENV NODE_ENV=production

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# The binary of the control plane: `shuttle-control`. It listens on its own
# socket and it acts on the shared state directly.
RUN bun build --compile --minify --outfile /app/bin/shuttle-control src/control-main.ts

USER bun
EXPOSE 9090
ENTRYPOINT ["/app/bin/shuttle-control"]

# ------------------------------------------------------------------- runtime
#
# The production image contains the gateway and nothing else. The fixtures
# with their known accounts and their static policies are not copied into it.
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.title="shuttle" \
      org.opencontainers.image.description="An application gateway: it authenticates a caller, asks an access service and forwards the request to a single upstream." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/ggpwnkthx/shuttle" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    SHUTTLE_CONFIG=/etc/shuttle/routes.json \
    SHUTTLE_GATEWAY_PORT=8080 \
    SHUTTLE_CONTROL_PORT=9090

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY src ./src
COPY config ./config
COPY package.json ./

USER bun
EXPOSE 8080

# The gateway writes nothing: the route table is mounted read-only and the
# logs go to the standard output. The file system of the container can be
# read-only, apart from the temporary directory of the runtime.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The control plane is the same image with another command:
#
#   docker run --rm -p 9090:9090 ghcr.io/ggpwnkthx/shuttle:1.3.0 \
#     bun run src/control-main.ts
#
# It is never published to the callers: it is internal.
ENTRYPOINT ["bun", "run"]
CMD ["src/main.ts"]

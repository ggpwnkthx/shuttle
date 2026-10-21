# Shuttle

Shuttle is an application gateway. It authenticates a caller against an
OpenID Connect provider, asks an access service whether the caller may use
a workspace, and forwards the request to one configured upstream.

It has no domain model of its own: the workspaces, the roles and the
quotas live in the access service. Shuttle enforces "authenticated +
authorized for this workspace + forwarded safely" and nothing else.

The documentation is in [docs/](docs/):

| Document | What it holds |
| --- | --- |
| [docs/spec.md](docs/spec.md) | The normative behavior, and the only document that changes the contract. |
| [docs/architecture.md](docs/architecture.md) | How the code is laid out, which import is allowed where, and which file owns what. |
| [docs/decisions.md](docs/decisions.md) | The decisions behind the contract, with their evidence. |
| [docs/operations.md](docs/operations.md) | How to deploy, configure, run and review it. |
| [docs/capacity.md](docs/capacity.md) | The measurements of the capacity. |
| [docs/runtime.md](docs/runtime.md) | The capabilities of the runtime the gateway is written against. |
| [docs/upstream-identity.md](docs/upstream-identity.md) | How an upstream verifies the identity of a request, with the code. |

## What it does

| | |
| --- | --- |
| **Routing** | One upstream or several per route, matched on host, path and method, with a fixed precedence and an ambiguity check at load time. A route may declare the path its upstream receives. |
| **Authentication** | OpenID Connect with PKCE for the browser, bearer tokens for the API clients, in four modes that decide predictably which credential a route accepts. |
| **Authorization** | The access service decides who may use a workspace; the gateway asks and fails closed. The protocol of the service is published and a reference implementation ships with the project. |
| **Proxying** | Streamed bodies, server sent events, uploads, a budget per phase of the upstream exchange and a limit on the body. A route with several upstreams fails over to the next one when the first one does not answer. |
| **Header policy** | The hop-by-hop headers and the spoofable headers are removed, the identity is written by the gateway and signed with a JWS an upstream verifies with a standard library, and the forwarding headers are only trusted from known proxies. The gateway writes the trace of the request. |
| **Sessions** | Server side, in the process or in a server the replicas share (Redis or Postgres), with an idle lifetime and a maximum age. |
| **Limits** | Four scopes of sliding windows, shared by the replicas through the shared state (Redis or Postgres), that bound a flood without a boundary burst. |
| **WebSockets** | The upstream handshake first, bounded buffers, keepalive, and a revalidation that closes a connection whose access was revoked. |
| **Operations** | Health and readiness probes, Prometheus metrics, structured logs with redaction, the log of the policy that is running, a hot reload of the configuration and a graceful drain. |

The shared state — the sessions, the rate limits and the cached decisions —
lives in a **Redis server** or in a **Postgres server**. The two hold the
same state with the same contract, and the gateway measures them side by
side: see [docs/capacity.md](docs/capacity.md).

## Quick start

```bash
bun install
bun run dev          # the gateway with the local fixtures
```

The development runner starts the identity provider, the access service and
two upstreams, writes a configuration file for them, and starts the gateway
on `http://localhost:8080`.

```bash
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz | jq
```

### The shared state

The scheme of the url picks the backend of the shared state:

```bash
# a Redis server
SHUTTLE_SESSION_URL=rediss://:<password>@redis:6379/0

# a Postgres server
SHUTTLE_SESSION_URL=postgres://user:<password>@postgres:5432/shuttle
```

The two are interchangeable: the same suite of tests runs against both, and
the script of the comparison measures them on the same traffic:

```bash
bun run benchmark -- --redis redis://127.0.0.1:6379/0 \
                     --postgres postgres://127.0.0.1:5432/shuttle
```

A developer without a server of either kind runs the tests of the shared
state against the in-process engine of Postgres:

```bash
bun test test/integration
```

## The configuration

The route table is a JSON file, validated as a whole and rejected as a whole
when it is invalid. The last valid configuration stays active when a reload
fails.

```jsonc
{
  "version": 1,
  "defaults": {
    "auth": { "mode": "none" },
    "timeouts": { "responseMs": 5000, "firstByteMs": 30000, "bodyMs": 300000 },
    "maxBodyBytes": 10485760
  },
  "trustedProxies": ["10.0.0.0/8"],
  "routes": [
    {
      "id": "workspace-api",
      "match": { "host": "api.example.com", "path": "/ws/{workspaceId}/" },
      "upstream": "http://upstream-b:3000",
      "auth": { "mode": "any", "workspace": { "param": "workspaceId", "requireUuid": true } },
      "websocket": true
    }
  ]
}
```

Three policies belong to a route rather than to the deployment, and they
replace the value of the defaults: `crossSite` (`navigation` or `strict`)
refuses the navigations from another site on that route,
`forwardAuthorization` (`true` or `false`) decides whether the token of the
caller reaches its upstream, and `accessCacheTtlMs` is the lifetime of the
cached decisions of the access service on that route — the latency of a
revocation there. They are described in [docs/operations.md](docs/operations.md).

A route may also declare the path its upstream receives — `rewrite` — and
several upstreams, which are tried in the order of the list.

The environment is described in [.env.example](.env.example). Every variable
has a default, except the ones a production deployment has to set: the
session secret, the key of the identity signature, the identity provider,
the access service, the shared state and at least one rate limit.

## The endpoints of the gateway

| Endpoint | Behaviour |
| --- | --- |
| `GET /healthz` | Always `200`. |
| `GET /readyz` | `200` when a configuration is loaded and the session store answers, `503` otherwise. |
| `GET /metrics` | Prometheus text. `404` without `SHUTTLE_METRICS_TOKEN`, `401` with a wrong bearer token. |
| `GET /auth/login` | Redirect to the identity provider (PKCE). |
| `GET /auth/callback` | Completes the login and sets the session cookie. |
| `GET /auth/logout` | Destroys the session. Refused when it comes from another site. |

Every other request is dispatched: the route is matched, the limiters are
applied, the caller is authenticated, the cross-site guard runs, the access
service is asked, and the request is forwarded.

## The binaries

The release compiles the gateway for seven platforms and publishes the
binaries on the release of the tag. They carry the runtime inside them:
nothing else has to be installed.

```bash
shuttle-v0.4.0-linux-x64-musl   # Linux, Alpine
shuttle-v0.4.0-linux-x64        # Linux, glibc
shuttle-v0.4.0-darwin-arm64     # macOS
shuttle-v0.4.0-windows-x64.exe  # Windows
```

The checks

```bash
bun run typecheck      # the types
bun run lint           # the linter
bun run format:check   # the formatting
bun run versions       # the version of the release is the same everywhere
bun test               # every test
bun test src           # the unit tests of the domains
bun test test/contract # the contract tests of the pipeline
bun test test/network  # the tests against a real socket
bun test test/browser  # the tests in a real browser
bun test test/integration # the tests against a real Redis and a real Postgres
```

The tests that need a Redis server or a Postgres server are skipped
without one. To run them locally:

```bash
scripts/redis-dev.sh start 6399
SHUTTLE_TEST_REDIS_URL=redis://127.0.0.1:6399/0 bun test test/integration
scripts/redis-dev.sh stop 6399

scripts/postgres-dev.sh start 5432
SHUTTLE_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/shuttle bun test test/integration
scripts/postgres-dev.sh stop 5432
```

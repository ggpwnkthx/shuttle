# Shuttle

Shuttle is an application gateway. It authenticates a caller against an
OpenID Connect provider, asks an access service whether the caller may use a
workspace, and forwards the request to a single configured upstream.

- The specification of the behavior is [SPECS.md](SPECS.md).
- The ownership of the code is [IMPLEMENTATION.md](IMPLEMENTATION.md) and
  [ARCHITECTURE.md](ARCHITECTURE.md).
- The order of the delivery is [BUILD_PLAN.md](BUILD_PLAN.md), the state of
  the build is [BUILD_STATUS.md](BUILD_STATUS.md) and the decisions of the
  release are [DECISIONS.md](DECISIONS.md).

## What it does

| | |
| --- | --- |
| **Routing** | One upstream per route, matched on host and path, with a fixed precedence and an ambiguity check at load time. |
| **Authentication** | OpenID Connect with PKCE for the browser, bearer tokens for the API clients, in four modes that decide predictably which credential a route accepts. |
| **Authorization** | The access service decides who may use a workspace; the gateway asks and fails closed. |
| **Proxying** | Streamed bodies, server sent events, uploads, a budget per phase of the upstream exchange and a limit on the body. |
| **Header policy** | The hop-by-hop headers and the spoofable headers are removed, the identity is written by the gateway and the forwarding headers are only trusted from known proxies. |
| **Sessions** | Server side, in the process or in a Redis compatible store, with an idle lifetime and a maximum age. |
| **Operations** | Health and readiness probes, Prometheus metrics, structured logs with redaction, a hot reload of the configuration and a graceful shutdown. |

## Quick start

```bash
bun install
bun run dev          # the gateway with the local fixtures
```

The development runner starts the identity provider, the access service and
two upstreams, writes a configuration file for them and starts the gateway on
`http://localhost:8080`.

```bash
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz | jq
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
  "trustedProxies": ["127.0.0.1/32", "::1/128"],
  "reservedPaths": [],
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

The environment is described in [.env.example](.env.example); every variable
has a default, except the ones a production deployment has to set.

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
applied, the caller is authenticated, the cross site guard runs, the access
service is asked and the request is forwarded.

## The checks

```bash
bun run typecheck      # the types
bun run lint           # the linter
bun run format:check   # the formatting
bun test               # every test
bun test src           # the unit tests of the domains
bun test test/contract # the contract tests of the pipeline
bun test test/network  # the tests against a real socket
bun test test/browser  # the tests in a real browser
```

The import boundaries of the project are checked by
`scripts/architecture.ts`; the rules are described in
[ARCHITECTURE.md](ARCHITECTURE.md).

## The deployment

The image is built from the `Dockerfile` of the repository:

```bash
docker build -t shuttle:0.1.0 .
```

The operations guide (topology, ingress, TLS, secrets, metrics, recovery and
rollback) is in [docs/operations.md](docs/operations.md), the targets of the
deployment and the measurements of the capacity are in
[docs/capacity.md](docs/capacity.md), the review of a deployment is in
[docs/deployment-review.md](docs/deployment-review.md) and the boundaries of
the runtime are in [docs/transport-capabilities.md](docs/transport-capabilities.md).

The artifacts of the deployment are in `deploy/`:

| Artifact | Where |
| --- | --- |
| The manifests of Kubernetes | `deploy/kubernetes/` (the deployment, the service, the autoscaling, the budget of the disruptions, the network policy, the ingress, the route table and the template of the secret) |
| The stack of a single host | `deploy/compose.production.yaml` |
| The stack of the development | `deploy/compose.yaml` (with the fixtures) |

The image of a release is built by the workflow `release.yml` when a tag is
pushed: it builds the image, it starts it with the configuration of a
deployment and it exports it as an artifact of the run.

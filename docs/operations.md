# The operations of Shuttle

How to deploy, configure, run and repair the gateway. The behavior it
implements is in [spec.md](spec.md).

## The topology

```
                 ┌──────────────┐
                 │   ingress    │  TLS, the limits of the connections
                 └──────┬───────┘
                        │ http, the headers of the proxy
                 ┌──────▼───────┐
                 │   shuttle    │  × N replicas, the same image
                 └──────┬───────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   the upstreams   the identity      the access
   (the apps)      provider          service
                    (the workspaces)
                        │
                        ▼
                    ┌─────────┐
                    │  redis  │  the sessions, the limits, the decisions
                    └─────────┘
```

The gateway is stateless: everything that has to survive a restart lives in
the shared state. A replica can be replaced at any moment.

## The settings of a deployment

| Variable | Value | Why |
| --- | --- | --- |
| `SHUTTLE_CONFIG` | `/etc/shuttle/routes.json` | The route table, mounted as a file. |
| `SHUTTLE_GATEWAY_HOST` | `0.0.0.0` | The listener. |
| `SHUTTLE_GATEWAY_PORT` | `8080` | The listener. |
| `SHUTTLE_OIDC_ISSUER` | `https://dex.example.com/dex` | The identity provider. |
| `SHUTTLE_OIDC_CLIENT_ID` / `_CLIENT_SECRET` | `shuttle` | The client of the gateway. The secret is in the secret store. |
| `SHUTTLE_OIDC_REDIRECT_URI` | `https://<the public url of the gateway>/auth/callback` | Where the provider sends the browser back to. |
| `SHUTTLE_OIDC_REQUIRED_TOKEN_CLAIMS` | — | The claims a bearer token has to carry. A provider that publishes a claim that names the type of the token names it here. |
| `SHUTTLE_OIDC_REJECT_NONCE_TOKEN` | `true` | Refuses a bearer token that carries a nonce. The id token of the gateway always carries one and an access token never does. A provider whose access tokens carry a nonce turns it off. |
| `SHUTTLE_ACCESS_URL` / `_ACCESS_TOKEN` | `https://access.example.com` | The access service. The token is in the secret store. |
| `SHUTTLE_SESSION_SECRET` | A random value of at least 32 bytes | It signs the state of the login. It has to be the **same on every replica**. |
| `SHUTTLE_IDENTITY_SIGNING_KEY` | The private key of the deployment | It signs the identity of the requests. The upstreams are given the public key. It has to be the **same on every replica**. |
| `SHUTTLE_SESSION_URL` | `rediss://:<password>@<redis>:6379/0` | The sessions of the callers. It has to name a server whose state is shared in production: a Redis server or a Postgres server. |
| `SHUTTLE_SHARED_STATE_URL` | `rediss://:<password>@<redis>:6379/1` | The limits and the decisions. It defaults to the url of the sessions. It has to name a server whose state is shared in production. |
| `SHUTTLE_REDIS_SENTINEL_MASTER` | — | The name of the master, when the server is behind sentinel. The hosts of the urls are then the sentinels. Empty by default. |
| `SHUTTLE_POSTGRES_POOL_MAX` | `10` | The connections of the pool of a replica, when the shared state is a Postgres server. |
| `SHUTTLE_POSTGRES_CONNECTION_TIMEOUT_MS` | `5000` | How long the client waits for a connection of the pool. |
| `SHUTTLE_POSTGRES_STATEMENT_TIMEOUT_MS` | `5000` | How long a statement of the gateway may run. |
| `SHUTTLE_POSTGRES_SYNCHRONOUS_COMMIT` | `off` | Whether the server waits for the disk before it answers. `off` is the guarantee a Redis server gives without its append only file, and it is nine times faster on the path of the limiter. |
| `SHUTTLE_POSTGRES_AUTO_MIGRATE` | `true` outside production | Builds the schema of the shared state when the client connects. A production deployment that applies its own migrations says no here and runs `bun run postgres:migrate` instead. |
| `SHUTTLE_METRICS_TOKEN` | A random value | The metrics are only served with it. |
| `SHUTTLE_UPSTREAM_TLS_CA` | The authority of the deployment | The certificate of the upstream is verified with it. |
| `SHUTTLE_UPSTREAM_TLS_CERT` / `_KEY` | The certificate of the gateway and its private key | They are presented to the upstreams that ask for a client certificate. They belong together. |
| `SHUTTLE_TRUSTED_PROXIES` | The ranges of the ingress | The forwarding headers are only trusted from them. |
| `SHUTTLE_EXTERNAL_PROTO` | `https` | The protocol the callers use. |
| `SHUTTLE_COOKIE_SECURE` | `true` | The cookies of the gateway are `Secure`. |
| `SHUTTLE_MAX_BODY_BYTES` | The limit of the deployment | The limit of the routes wins over it. |
| `SHUTTLE_MAX_CONCURRENT_REQUESTS` | `1000` | The exchanges that run at the same time. |
| `SHUTTLE_UPSTREAM_ATTEMPT_TIMEOUT_MS` | `2000` | The budget of one attempt to an upstream, when a route names several. An attempt that does not answer in time is abandoned and the next upstream is tried. `0` disables it. |
| `SHUTTLE_REPLAY_MAX_BYTES` | `65536` | The size of a body that may be sent again to a second upstream. A body that fits is held in memory. `0` disables it. |
| `SHUTTLE_UPSTREAM_BREAKER_FAILURES` | `3` | The number of consecutive failures before an upstream is skipped. The breaker is passive: it learns from the failures the gateway observes and it never probes an upstream. `0` disables it: the order of the list is always the order of the file. |
| `SHUTTLE_UPSTREAM_BREAKER_COOLDOWN_MS` | `30000` | How long an upstream is skipped, in milliseconds. The upstream is tried again when the cooldown is over, even when it failed in the meantime. |
| `SHUTTLE_ACCESS_STALE_GRACE_MS` | `0` | How long a decision of the access service may be served after the service became unreachable. `0` disables it: an unreachable service is an outage and the gateway answers `503` to it. |
| `SHUTTLE_RATE_LIMIT_TOTAL_MAX` | A value | The budget of the deployment. At least one limit has to be set. |
| `SHUTTLE_SHUTDOWN_TIMEOUT_MS` | `15000` | The deadline of the drain. |

The full list, with the default of every value, is in
[.env.example](../.env.example).

## The shape of the shared state

The url of the shared state names the shape of the server **and its
backend**: the scheme picks the one of the two, and the two hold the same
three things with the same contract.

| The url | The server |
| --- | --- |
| `redis://host:6379/0` | A **Redis** server. |
| `redis://host-a:6379,host-b:6379/0` | A **Redis cluster**: the hosts are its masters. |
| `redis://host-a:26379,host-b:26379/0` with `SHUTTLE_REDIS_SENTINEL_MASTER` | The **sentinels** of a Redis server: the master and the replicas are discovered from them, and a failover is transparent for the gateway. |
| `postgres://user:<password>@host:5432/shuttle` | A **Postgres** server. |
| `postgresql://user:<password>@host:5432/shuttle` | The same Postgres server. |

A cluster holds one database, so the path of the url is dropped in that
shape. The certificate of the server is verified with the authority of the
deployment (`SHUTTLE_SESSION_TLS_CA` and `SHUTTLE_SHARED_STATE_TLS_CA`).

The client connects in the background and keeps trying, so a gateway that
starts while the shared state is down stays up: it answers `503` to the
readiness probe, it denies the callers that need a session, and it becomes
ready when the server answers. The failure is reported once per outage.

### The Postgres server

The Postgres backend holds three tables and two functions in the schema
`shuttle`:

| The object | What it holds |
| --- | --- |
| `shuttle.sessions` | The sessions of the callers. The record is a `jsonb`, the expiry is a column. |
| `shuttle.access_decisions` | The cached decisions of the access service. |
| `shuttle.rate_limit_buckets` | The buckets of the windows of the limiters. |
| `shuttle.session_touch(...)` | Reads a session and refreshes its expiry. One transaction, the equivalent of the `TOUCH_SCRIPT` of Redis. |
| `shuttle.rate_limit_check(...)` | Counts a request in the window of a caller. One transaction, the equivalent of the `WINDOW_SCRIPT` of Redis. |

The schema is built by the gateway when `SHUTTLE_POSTGRES_AUTO_MIGRATE=true`,
which is the default outside a production deployment. The statements are
idempotent and an advisory lock makes one replica build the schema while
the others wait for it.

A production deployment that applies its own migrations says no and runs
the script instead:

```bash
bun run postgres:migrate -- postgres://user:<password>@host:5432/shuttle
```

**The connections are a pool** (`SHUTTLE_POSTGRES_POOL_MAX`, ten per
replica by default). A Postgres server has a low limit of connections, so
a deployment with many replicas needs a pooler in front of it. The limit of
the server is the number of the replicas times the size of the pool.

**The server does not wait for the disk** (`SHUTTLE_POSTGRES_SYNCHRONOUS_COMMIT=off`,
the default). The state of the shared state is a protection and not a
ledger: a counter that is lost when the server crashes costs a caller a
few requests of its budget. It is the same guarantee a Redis server gives
without its append only file, and it is the difference between a
millisecond and a tenth of a millisecond on every transaction of the
limiter.

**The rows that are over are removed by a sweep.** The expiry of a row is
a column and not the disappearance of a key, so the adapters remove the
rows that are over. The server never serves a row that is over, whatever
the sweep did.

### The comparison of the two backends

The two backends are interchangeable and the gateway measures them side by
side:

```bash
bun run benchmark -- --redis redis://127.0.0.1:6379/0 \
                     --postgres postgres://127.0.0.1:5432/shuttle
```

The script runs the same traffic against the same gateway with the two
backends and prints the table of the comparison. The measurements of the
last run are in [capacity.md](capacity.md).

## The policies of the routes

Several policies are properties of a route rather than of the deployment.
They are in the route table, and they replace the value of the defaults.

| Key | Default | What it decides |
| --- | --- | --- |
| `crossSite` | `navigation` | `strict` refuses the navigations from another site on that route. Use it for a route whose upstream changes the state of something on a `GET`. |
| `forwardAuthorization` | `true` | `false` does not forward the `Authorization` header of the caller to that upstream. The identity of the caller still reaches it, in the headers of the gateway and in the signature. |
| `accessCacheTtlMs` | the value of the environment | The lifetime of the cached decisions of the access service on that route. `0` asks the service for every request, so a revocation on that route is immediate. |
| `replayMaxBytes` | the value of the environment | The size of a body that may be sent again to a second upstream. A body that fits is held in memory, so that the request may be sent to the next upstream when the first one fails. |
| `timeouts.upstreamAttemptMs` | the value of the environment | The budget of one attempt to an upstream, when the route names several. `0` disables it. |

```jsonc
{
  "id": "workspace-api",
  "match": { "host": "api.example.com", "path": "/ws/{workspaceId}/" },
  "upstream": "http://upstream-b:3000",
  "auth": { "mode": "any", "workspace": { "param": "workspaceId", "requireUuid": true } },
  // The upstream of this route changes the state of something on a `GET`:
  // it may only be reached from the site itself.
  "crossSite": "strict",
  // The upstream does not need the token of the caller.
  "forwardAuthorization": false
}
```

## The access service of the deployment

The access service is a dependency of the deployment and not a part of
Shuttle. The gateway asks it and fails closed: without a decision, the
request is refused.

The protocol of the service is published in
[spec.md](spec.md) §6.1, and a deployment that writes its own service runs
the conformance suite against it:

```bash
SHUTTLE_TEST_ACCESS_URL=https://access.example.com \
SHUTTLE_TEST_ACCESS_TOKEN=… \
SHUTTLE_TEST_ACCESS_ALLOWED_SUBJECT=alice@example.com \
SHUTTLE_TEST_ACCESS_ALLOWED_WORKSPACE=11111111-1111-4111-8111-111111111111 \
bun test test/integration/access-conformance.test.ts
```

A deployment that has no service of its own may run the **reference
implementation** that ships with the project:
`services/access-service.ts` applies a policy file and answers the protocol.

```bash
ACCESS_POLICY_FILE=/etc/shuttle/access-policy.json \
ACCESS_SERVICE_TOKEN=… \
bun run services/access-service.ts
```

The image of the reference implementation is built with the stage
`access-service` of the `Dockerfile`. It is **not** part of the image of the
gateway: the two are different programs and they are deployed apart.

The policy file:

```json
{
  "version": 1,
  "subjects": {
    "alice@example.com": {
      "workspaces": ["11111111-1111-4111-8111-111111111111"],
      "roles": ["editor"]
    },
    "bob@example.com": { "workspaces": ["*"] },
    "carol@example.com": { "workspaces": [], "routes": ["admin-api"] }
  }
}
```

A subject that the file does not know is denied. The service applies the
file, and it says no when the file says nothing.

The `routes` of a subject are the routes it may use when the request
names **no workspace**: a route of the gateway that asks the access
service about itself (`accessCheck`) sends a request without a workspace,
and the service decides on the routes of the subject.

**The grace of an outage.** A route may ask the access service for a
decision and go on with the last decision the service took while the
service is down:

```jsonc
{
  "id": "workspace-api",
  "accessStaleGraceMs": 30000
}
```

The grace is `0` by default: an unreachable service is an outage, and the
gateway answers `503 access_unavailable` to it, which is the answer that
tells the operator that the service is down. A grace keeps the traffic of
the route flowing, and it makes the revocations late by that much: the
decisions that were served this way are counted in
`shuttle_access_stale_total{route}` and their age is measured in
`shuttle_access_stale_age_seconds{route}`.

## The secrets

| Secret | Where it comes from | What it protects | How it is rotated |
| --- | --- | --- | --- |
| `SHUTTLE_SESSION_SECRET` | The secret store | The state of the login | The logins in flight fail and the callers sign in again. |
| `SHUTTLE_IDENTITY_SIGNING_KEY` | The secret store | The signature of the identity that the upstreams verify | The upstreams are given the new **public key** at the same time. The signatures of the old key are refused in the meantime. |
| `SHUTTLE_OIDC_CLIENT_SECRET` | The secret store | The exchange of the code | The provider accepts two secrets during the rotation of the client; the deployment changes the value afterwards. |
| `SHUTTLE_ACCESS_TOKEN` | The secret store | The calls to the access service | The service accepts two tokens during the rotation. |
| The password of Redis | The secret store | The sessions and the limits | The deployment changes the password of the client and of the server in the same window. |
| `SHUTTLE_METRICS_TOKEN` | The secret store | The metrics | The scraper and the deployment change it together. |
| The public key of the identity signature | `bun run identity:key --public` | The verification of the signature of the identity by the upstreams | The upstreams are given the public key, never the private one. |

The rules:

- a secret is never written in the image, in the configuration file or in
  the repository;
- the upstreams verify the signature of the identity with the **public key**
  and never with the private one, so an upstream that verifies an identity
  cannot mint one;
- the secret of the sessions is the same on every replica: a replica with
  another secret cannot read the session of a caller and cannot verify the
  state of a login.

## The ingress

The gateway does not terminate TLS and it does not rewrite the path of a
request. The ingress is in front of it and it has to preserve the streaming
of the bodies and the WebSockets.

| Setting | Value | Why |
| --- | --- | --- |
| The timeouts of the ingress | At least `SHUTTLE_SHUTDOWN_TIMEOUT_MS` for the read, and **no** write timeout. | A stream of events lasts longer than any write timeout. |
| The buffering of the request | off | The body is streamed to the upstream; a buffered body breaks the budgets and the limits of the body. |
| The buffering of the answer | off | The same, for the answers. |
| `proxy_http_version` | `1.1` | The WebSockets need it. |
| `proxy_set_header Upgrade` / `Connection` | on | The WebSockets need it. |
| The limits of the body | The limit of the route (`maxBodyBytes`), or the biggest one. | The gateway refuses the bodies that are over the limit with `413`; the ingress may refuse them earlier, with its own answer. |
| The timeouts of the idle connections | At least `SHUTTLE_WS_IDLE_TIMEOUT_SECONDS`. | The WebSockets of the editors are idle most of the time. |
| The number of connections | At least the number of the WebSockets of the deployment. | The ingress is the limit of the connections. |
| The health check | `GET /healthz` | It is always available. |
| The readiness check | `GET /readyz` | It answers `503` when the gateway cannot serve the traffic. |

### The headers of the proxy

The gateway tells the ingress the real address of the caller in
`x-forwarded-for`, `x-forwarded-proto` and `x-forwarded-host`. The ingress
has to set them, and the ranges of the ingress have to be in
`SHUTTLE_TRUSTED_PROXIES` (or in the `trustedProxies` of the configuration
file): the headers of a client that is not a trusted proxy are ignored.

**The host needs attention.** The effective host decides the route that
handles the request, the origin the browser is compared with, and the value
the signature of the identity covers. An ingress that rewrites the `Host`
header to its own name must report the public host in `x-forwarded-host`,
or the requests do not match a route.

A typical nginx configuration:

```nginx
location / {
    proxy_pass http://shuttle:8080;

    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

The path of a request is forwarded unchanged, unless the route declares a
`rewrite`. The ingress must not rewrite it and must not add a prefix: the
upstream application is mounted under the path of its route, and the
signature of the identity covers the path the upstream receives.

A route that declares a `rewrite` writes the path its upstream receives —
`/{rest}` removes the prefix of the route — and the ingress still must not
rewrite the path: the rewrite of the route is applied to the path the
caller sent.

## The metrics

`GET /metrics` answers the Prometheus text exposition format. The endpoint
is `404` when `SHUTTLE_METRICS_TOKEN` is not set and `401` when the bearer
token does not match.

| Metric | What it says | What an operator does with it |
| --- | --- | --- |
| `shuttle_requests_total{route,method,status}` | Every answer of the gateway, the refusals included. | The traffic of the routes. |
| `shuttle_request_errors_total{route}` | The answers with a status of 5xx. | An error of the gateway or of the upstream. |
| `shuttle_auth_failures_total{route,reason}` | The callers that were rejected (`unauthenticated`, `missing_role`, `access_denied`). | A policy of the platform, not an error of the gateway. |
| `shuttle_access_unavailable_total{route}` | The requests that were refused because the access service could not be reached. | The access service is restored. The gateway fails closed, so the callers are refused meanwhile. |
| `shuttle_cross_site_refusals_total{route}` | The requests that came from another site. | An attack or a broken client. |
| `shuttle_websocket_connections_total{route}` | The WebSockets that were accepted. | The capacity. |
| `shuttle_websocket_refusals_total{reason}` | The handshakes that were refused. | The capacity, the origins. |
| `shuttle_request_duration_seconds{route}` | The latency of the exchanges. | The budgets of the routes. |
| `shuttle_upstream_duration_seconds{route}` | The latency of the upstreams: from the request that left the gateway to the final headers of the answer. | An upstream that is slow. |
| `shuttle_upstream_failures_total` | The failures of the upstreams: a connection that was refused, an attempt that ran out of time. | An upstream that is down. |
| `shuttle_upstreams_skipped_total` | The times an upstream was moved to the end of the list because it failed recently. | The breaker of the upstreams is working. |
| `shuttle_bytes_in_total` / `shuttle_bytes_out_total` | The bytes that really went through. | The volume. |
| `shuttle_active_requests` | The requests that are in flight. | The drain. |
| `shuttle_config_reloads_total{result}` | The reloads of the configuration. | A broken file on disk. |
| `shuttle_rate_limited_total` | The requests that the limiter refused. | A flood. |
| `shuttle_shared_state_errors_total` | The times the shared state was not reachable. | The degradation of the deployment. |

The labels are bounded: `unmatched` for the requests that matched no route,
`other` for a method or a status that is not tracked, `overflow` beyond 500
routes. A workspace, a subject, an url or a request id are never a label, so
the metrics of a busy gateway do not grow the memory of the process.

The scraper of the deployment sends the token as a bearer token:

```yaml
scrape_configs:
  - job_name: shuttle
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: <the token of the secret store>
```

## The logs

The logs are JSON, one object per line. `Authorization`, `Cookie`,
`Set-Cookie`, `x-api-key` and the query parameters that carry a token
(`access_token`, `code`, `code_verifier`, `id_token`, `refresh_token`,
`state`, `token`) are redacted before anything is written.

Every line of a request carries the identifier of the request, and the
answer carries it in the header `x-request-id`: a caller that sends a valid
identifier can follow its request in the logs.

The line of a proxied request carries the route, the method, the path, the
status, the duration, the bytes and the outcome (`complete` or `aborted`).
The status and the outcome are two different things: an upstream that
answered `200` and a body that was cut is a `200` with the outcome
`aborted`.

## What happens when a dependency fails

| Piece | When it is not reachable |
| --- | --- |
| The identity provider | The logins fail with `503`. The callers that have a session keep working. |
| The access service | The requests that need a decision are refused with `503 access_unavailable`. The other routes are unaffected. A route that has a grace (`accessStaleGraceMs`) goes on with the last decision of the service, and the decisions that were served this way are counted in `shuttle_access_stale_total`. |
| The shared state (Redis) | The sessions fail closed (`401`/`503`), the limiter fails open, the decisions are asked for again. |
| The upstreams | The requests of the route are answered with `502`. The other routes are unaffected. A route that names several upstreams tries the next one when the request may be sent again, and the breaker moves an upstream that failed recently to the end of the list, so the next request of the route goes to an upstream that answered recently. |

## The recovery

| Symptom | What it means | What the operator does |
| --- | --- | --- |
| `/readyz` answers `503` with `config.lastError` | The configuration file is broken. | The file is corrected. The last good configuration keeps serving the traffic. |
| `/readyz` answers `503` with `sessionStore: unavailable` | The shared state is not reachable. | The shared state is restored. The deployment is out of the rotation until then. |
| Every request answers `404 no_route` | The ingress rewrites the `Host` header and does not report the public host. | The ingress sets `x-forwarded-host`, or the routes match the host the ingress sends. |
| Every request answers `403 cross_site_request` | The same, with the origin the browser sends. | The ingress sets `x-forwarded-host` and `x-forwarded-proto`. |
| `shuttle_shared_state_errors_total` grows | The shared state is degraded: the limiter fails open and the decisions are asked for again. | The shared state is restored. |
| `shuttle_access_unavailable_total` grows | The access service is not reachable, or it answers something the gateway cannot read. | The access service is restored. The gateway fails closed: the callers are refused with `503 access_unavailable` until the service answers again. |
| `shuttle_access_stale_total` grows | The access service is not reachable, and the routes that have a grace went on with the last decision of the service. | The access service is restored. The revocations of the callers are late by the grace: a route that may not be late sets `accessStaleGraceMs: 0`. |
| `shuttle_request_errors_total` grows for one route | The upstream of the route is broken. | The upstream is repaired. The other routes are unaffected. |
| `shuttle_rate_limited_total` grows | A flood. | The limits are reviewed. The limiter protects the upstreams. |
| `shuttle_cross_site_refusals_total` grows | A client of the platform sends requests from another site. | The origin of the client is added to `SHUTTLE_ALLOWED_ORIGINS`, or the client is fixed. |
| The logins fail with `503` | The identity provider is not reachable. | The provider is restored. The callers that have a session keep working. |
| The WebSockets close with `1008` | The session expired, the access was revoked, or the route changed. | Nothing, unless it is unexpected: the revalidation is doing its job. |
| The gateway refuses to start | A production deployment without a session secret, without an identity provider, without an access service, or without a rate limit. | The message names the variable. |

## The rollback

The gateway is a stateless process: a rollback is the deployment of the
previous image.

1. The deployment of the previous image is started with the same
   configuration and the same secrets. The routes are read from the file, so
   a rollback does not need a change of the configuration.
2. The pods of the new version are drained: the readiness answers `503`, the
   WebSockets are closed with the code 1001 and the requests that are in
   flight get `SHUTTLE_SHUTDOWN_TIMEOUT_MS`. The orchestrator has to allow
   at least that much time between the signal and the removal of the pod.
3. The sessions of the callers live in the shared state: they survive the
   rollback, as long as `SHUTTLE_SESSION_SECRET` did not change. A rollback
   that changes the secret of the sessions logs the callers out.
4. The signature of the identity is versioned (`v3`): an upstream that
   verifies the signature keeps working with the previous version of the
   gateway, as long as the secret of the sessions did not change.

The configuration is reloaded on the fly: a broken file never takes a
running deployment out of the rotation, and a corrected file is picked up
within a second.

## The invalidation of the sessions

The sessions of the callers live in the shared state, under the prefix of
the deployment (`SHUTTLE_SESSION_KEY_PREFIX`).

| What is wanted | How | What it costs |
| --- | --- | --- |
| End the session of one caller | The session is removed from the state (`DEL <prefix>:s:<id>`). | The caller has to sign in again. |
| **End every session of one caller** | `bun run sessions -- --subject <sub>` | The caller has to sign in again. The other callers are untouched. |
| End the sessions of the callers of a deployment | The keys of the prefix are removed (`SCAN` + `DEL`, or `FLUSHDB` when the deployment has the state to itself). | Every caller has to sign in again. |
| End every session of every deployment that shares the state | The keys of the prefix of the deployment are removed. | The same. |

The script of the revocation talks to the state the replicas share — a Redis
server or a Postgres server — and it takes the url of the state and the
prefix of the deployment from the environment of the gateway:

```bash
SHUTTLE_SESSION_URL=redis://127.0.0.1:6379/0 bun run sessions -- --subject alice@example.test
```

The subject is the `sub` of the identity provider. The script prints the
number of sessions it removed, and it prints `0` when the subject has no
session.

The gateway has no endpoint for the revocation: a gateway that answers an
administrative request is a request an attacker reaches, and the
administrative surface of a gateway is the surface that decides who reaches
the applications behind it.

**The index of the sessions.** The sessions are indexed by subject, so they
can be revoked at once. The index of Redis is built as the sessions are
created: a session that was created before the index existed is not in it,
and it expires on its own. The index of Postgres is a column of the table,
and the sessions that were created before the column existed are indexed by
the migration:

```bash
bun run postgres:migrate -- postgres://user:password@host:5432/shuttle
```

The rotation of the secret of the sessions has the same effect on the
sessions that are in flight: the state of a login is signed with the old
secret, so a caller that was in the middle of a login has to sign in again.

The sessions of a caller can also be ended by the gateway itself: the logout
destroys the session of the caller and deletes its cookie.

## The rotation of the secret of the sessions

1. The new secret is added to the secret store.
2. The deployment is changed to the new secret. The replicas are replaced one
   by one: **a replica with the old secret and a replica with the new secret
   do not understand each other** (the state of the login and the signature
   of the identity differ), so the replicas of a rollout have to be replaced
   quickly (`maxUnavailable: 0` with a surge, or a maintenance window).
3. The upstreams are given the new derived key.
4. The old secret is removed from the secret store.

The callers that were in the middle of a login have to sign in again.

## The review of a deployment

This checklist is ticked once per deployment. Every item names the place
where the setting lives, so a reviewer can check it without reading the
code. The rules at the end of each section are the ones the gateway
enforces; the questions are the ones a reviewer has to answer.

### 1. The authentication of the routes

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which routes accept a session cookie, which accept a bearer token and which accept both? | `auth.mode` of the route table | |
| Which routes need a workspace and which placeholder carries it? | `auth.workspace` of the route table | |
| Does any route accept no credential at all (`mode: none`)? | `auth.mode` of the route table | |
| Is the upstream of a route with `mode: none` the one that authenticates the caller? | the route table and the application behind it | |

**The rule**: a route with `mode: none` hands the `Authorization` header of
the caller to its upstream unchanged. The upstream of such a route is the
one that authenticates the caller.

### 2. The hosts that are accepted

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which hosts does the gateway answer for? | `match.host` of the route table | |
| Is there a route that matches every host (`*`)? What does it serve? | the route table | |
| Do the hosts of the routes match the hosts the callers use? | the route table and the ingress | |
| Does the ingress preserve the `Host` header, or does it report the public host in `x-forwarded-host`? | the ingress | |

**The rules**:

- The effective host decides the route, the origin the browser is compared
  with, and the value the signature of the identity covers. An ingress that
  rewrites the `Host` header without reporting the public host breaks all
  three.
- The paths of the gateway itself (`/healthz`, `/readyz`, `/metrics`,
  `/auth/login`, `/auth/callback`, `/auth/logout`) are reserved whatever
  the configuration says, and a route that claims one of them is refused
  when the configuration is loaded.

### 3. The trusted proxies

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which ranges may send the forwarding headers? | `trustedProxies` of the file and `SHUTTLE_TRUSTED_PROXIES` | |
| Is the ingress the only one that talks to the gateway? | the network policy | |
| Is the client address of a caller the one the rate limiter counts? | `x-forwarded-for` and the trusted proxies | |

**The rule**: the forwarding headers of a request that does not come from a
trusted proxy are ignored, and the address of the peer is the address of the
caller. A range that is too wide lets a caller choose the key of the rate
limiter.

### 4. The access to the upstreams

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which upstream is behind which route? | the route table | |
| Are the upstreams reachable from the internet? | the network policy and the services | |
| Does the gateway reach the upstreams over TLS? | the url of the upstream | |
| Are the upstreams of the different routes in different trust domains? | the namespace of the services | |
| Do the upstreams verify the signature of the identity? | the application behind them | |

**The rules**:

- The upstreams are only reachable from the gateway. The identity headers of
  the gateway are only trustworthy when the upstream cannot be reached from
  anywhere else.
- An upstream that does not verify the signature trusts the headers of the
  gateway on the word of the network.

### 5. The protection of the metrics

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Is `SHUTTLE_METRICS_TOKEN` set? | the secret of the platform | |
| Who reads the metrics and with which token? | the configuration of the scraper | |
| Is the metrics endpoint reachable from outside the cluster? | the service and the network policy | |

**The rule**: without a token the endpoint answers `404`; with a wrong token
it answers `401`. The metrics carry the routes, the methods, the statuses
and a closed set of reasons: never a workspace, a subject, an url or a
request id.

### 6. The secrets

| Secret | In the secret store | The same on every replica | Rotated |
| --- | --- | --- | --- |
| `SHUTTLE_SESSION_SECRET` | | | |
| `SHUTTLE_IDENTITY_SIGNING_KEY` | | | |
| `SHUTTLE_OIDC_CLIENT_SECRET` | | | |
| `SHUTTLE_ACCESS_TOKEN` | | | |
| The password of the shared state | | | |
| `SHUTTLE_METRICS_TOKEN` | | | |

**The rules**:

- the secret of the sessions is the same on every replica: a replica with
  another secret cannot read the session of a caller and cannot verify the
  state of a login;
- the upstreams verify the signature of the identity with the **derived**
  key, never with the secret of the sessions;
- a secret is never in the image, in the configuration file or in the
  repository.

### 7. The limits and the budgets

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| What is the limit of the body of a request, and does the ingress agree with it? | `maxBodyBytes` of the routes, `SHUTTLE_MAX_BODY_BYTES` and the ingress | |
| Which phase has which budget? | `timeouts` of the routes and of the defaults | |
| Are the budgets of the routes longer than the timeouts of the ingress? | the ingress | |
| Which rate limits are enabled? | `SHUTTLE_RATE_LIMIT_MAX`, `_GLOBAL_MAX`, `_PRINCIPAL_MAX`, `_TOTAL_MAX` | |
| Is the budget of the deployment enabled? | `SHUTTLE_RATE_LIMIT_TOTAL_MAX` | |
| How many requests may a replica handle at the same time? | `SHUTTLE_MAX_CONCURRENT_REQUESTS` and the memory of the pod | |
| How many WebSockets may a replica hold? | `SHUTTLE_WS_MAX_CONNECTIONS` and the memory of the pod | |
| How often is an open WebSocket revalidated? | `SHUTTLE_WS_REVALIDATE_INTERVAL_MS` | |

**The rules**:

- The ingress must not buffer the bodies and must not have a write timeout
  that is shorter than a stream of events.
- A production deployment has to set at least one rate limit. The scope of
  the deployment is the only one that bounds a flood that spreads over many
  addresses.
- The cap of the exchanges is the bound of the clients that open a request
  and never send its body.

### 8. The capacity

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| What is the measured capacity of a replica? | [capacity.md](capacity.md) | |
| How many replicas does the deployment have? | the autoscaling | |
| What is the capacity of the shared state? | the server of the state | |
| What is the memory of a replica under the load of the deployment? | the limit of the pod | |

**The rule**: the numbers of the capacity document are the ones of the
gateway alone. The capacity of a deployment is bounded by its ingress and by
its upstreams, and it has to be measured there.

### 9. The operations

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which probe is the liveness and which one is the readiness? | the deployment | |
| Is the grace period of the pod longer than the deadline of the drain? | the deployment | |
| Who is paged when the readiness fails? | the alerts | |
| How is a broken configuration file rolled back? | the configuration in the version control | |
| How are the sessions invalidated? | [operations.md](operations.md) | |
| What is the latency of a revocation? | `SHUTTLE_ACCESS_CACHE_TTL_MS` and `SHUTTLE_WS_REVALIDATE_INTERVAL_MS` | |

**The rule**: the latency of a revocation is the TTL of the cache of the
decisions plus the interval of the revalidation of the WebSockets. They are
the knobs an operator turns when a revocation has to be immediate.

## The checks of the project

| Check | Command | In the CI |
| --- | --- | --- |
| Types | `bun run typecheck` | yes |
| Lint | `bun run lint` | yes |
| Format | `bun run format:check` | yes |
| Import boundaries | `bun test test/architecture` | yes |
| Unit and contract tests | `bun test src test/contract` | yes |
| The property tests of the parsers | `bun test test/fuzz` | yes |
| Network tests | `bun test test/network` | yes |
| The shared state against a real Redis | `bun test test/integration` | yes |
| The shared state against a real Postgres | `bun test test/integration` | yes |
| The browser | `bun test test/browser` | yes |
| The interoperability with a real provider | `bun test test/interop` | yes |
| The soak | `bun test test/load` | yes |
| The load | `bun run load` | yes |
| The comparison of the backends | `bun run benchmark` | no |
| The image | `docker build` and the smoke tests | yes |

The last full run of the suite: **711 tests passed, 0 failed** over 71 files
with Bun 1.4.3, including the tests against a real Redis 7.0.15
(`SHUTTLE_TEST_REDIS_URL=redis://127.0.0.1:6399/0`) and against a real
Postgres 15.18 (`SHUTTLE_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/shuttle`),
the 3 tests in Chromium and the 2 soak tests. The coverage of the source
(`src/`) is **94.1 %** of the lines and **90.6 %** of the functions; the
coverage of the whole tree, the tests included, is **93.9 %** of the lines
and **93.5 %** of the functions.

Without a Redis server and without a Postgres server, the 36 tests of the
shared state are skipped and the rest pass. The tests of the shared state
of a Postgres server run without a server when none is named: they run
against the in-process engine of Postgres itself.

## The workflow of the release

The CI workflow (`.github/workflows/ci.yml`) runs six jobs:

| Job | What it proves |
| --- | --- |
| `check` | The types, the lint, the format, the import boundaries, the unit and contract tests, the network tests and the soak. |
| `redis` | The shared state against a real Redis 7. |
| `postgres` | The shared state against a real Postgres 16, and the migration of the schema. |
| `load` | The capacity: 20 000 requests at 100 in flight, and 500 WebSockets. |
| `browser` | The cookies and the origins in a real Chromium. |
| `image` | The image builds, starts with the configuration of a deployment, refuses to start without a session secret, without an access service, without an identity provider and without a rate limit, and does not contain the fixtures. |

The release workflow (`.github/workflows/release.yml`) builds the image of a
tag, starts it with the configuration of a deployment and exports it as an
artifact of the run. The image carries the version and the revision as
labels, and holds the dependencies of the gateway alone.

The image is built twice: once for the local store, so that the checks of
the deployment can run it, and once for the registry. The attestations —
the provenance and the bill of materials — are added by the second build:
the docker exporter of a local build cannot carry the manifest list of an
attestation.

The workflow of the binaries (`.github/workflows/release-binaries.yml`)
compiles the gateway for the seven platforms of the release and publishes
them on the release of the tag:

| Platform | The target of the compilation |
| --- | --- |
| Linux x64 (glibc) | `bun-linux-x64` |
| Linux x64 (musl, Alpine) | `bun-linux-x64-musl` |
| Linux arm64 | `bun-linux-arm64` |
| macOS x64 | `bun-darwin-x64` |
| macOS arm64 | `bun-darwin-arm64` |
| Windows x64 | `bun-windows-x64` |
| Windows arm64 | `bun-windows-arm64` |

The binaries carry the runtime of the release inside them: nothing else has
to be installed. The workflow refuses a tag that does not name the version
of the package, it checks that every binary is of the format of its
platform, and it starts the binary of the runner and waits for its health
probe before it publishes anything. The checksums of the binaries are
published with them.

The libc of a binary is the one of its platform: a binary of `linux-x64`
needs glibc and a binary of `linux-x64-musl` needs musl, so a deployment on
Alpine takes the second one.

## The gaps of the deployment

Nothing is missing from the contract of [spec.md](spec.md). The following
are outside the scope of the gateway and are the responsibility of the
deployment:

| Gap | Where it is closed |
| --- | --- |
| The TLS of the clients | An ingress in front of the gateway. |
| The upstream is static per route | A router in front of the pods, when the workspace decides the pod. |
| The revocation of an access takes the TTL of the cache | The TTL is the knob: `SHUTTLE_ACCESS_CACHE_TTL_MS`, and `accessCacheTtlMs` on the route that has to be revoked at once. |
| The latency of a decision that is not cached | The control plane has to be fast. The cache absorbs the rest. |
| One hostname per product surface | Subdomains, or one host with distinct path prefixes. |
| The upstream of a websocket over TLS | The websocket client of the runtime cannot speak TLS: the upstream of a websocket is served over plain http. The measurements are in [runtime.md](runtime.md). |

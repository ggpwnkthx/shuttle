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
| `SHUTTLE_ACCESS_URL` / `_ACCESS_TOKEN` | `https://access.example.com` | The access service. The token is in the secret store. |
| `SHUTTLE_SESSION_SECRET` | A random value of at least 32 bytes | It signs the state of the login and the signature of the identity. It has to be the **same on every replica**. |
| `SHUTTLE_SESSION_URL` | `rediss://:<password>@<redis>:6379/0` | The sessions of the callers. It has to be a Redis server in production. |
| `SHUTTLE_SHARED_STATE_URL` | `rediss://:<password>@<redis>:6379/1` | The limits and the decisions. It defaults to the url of the sessions. It has to be a Redis server in production. |
| `SHUTTLE_METRICS_TOKEN` | A random value | The metrics are only served with it. |
| `SHUTTLE_TRUSTED_PROXIES` | The ranges of the ingress | The forwarding headers are only trusted from them. |
| `SHUTTLE_EXTERNAL_PROTO` | `https` | The protocol the callers use. |
| `SHUTTLE_COOKIE_SECURE` | `true` | The cookies of the gateway are `Secure`. |
| `SHUTTLE_MAX_BODY_BYTES` | The limit of the deployment | The limit of the routes wins over it. |
| `SHUTTLE_MAX_CONCURRENT_REQUESTS` | `1000` | The exchanges that run at the same time. |
| `SHUTTLE_RATE_LIMIT_TOTAL_MAX` | A value | The budget of the deployment. At least one limit has to be set. |
| `SHUTTLE_SHUTDOWN_TIMEOUT_MS` | `15000` | The deadline of the drain. |

The full list, with the default of every value, is in
[.env.example](../.env.example).

## The secrets

| Secret | Where it comes from | What it protects | How it is rotated |
| --- | --- | --- | --- |
| `SHUTTLE_SESSION_SECRET` | The secret store | The state of the login and the signature of the identity | The signature changes with it: the upstreams are given the new derived key at the same time. The logins in flight fail and the callers sign in again. |
| `SHUTTLE_OIDC_CLIENT_SECRET` | The secret store | The exchange of the code | The provider accepts two secrets during the rotation of the client; the deployment changes the value afterwards. |
| `SHUTTLE_ACCESS_TOKEN` | The secret store | The calls to the access service | The service accepts two tokens during the rotation. |
| The password of Redis | The secret store | The sessions and the limits | The deployment changes the password of the client and of the server in the same window. |
| `SHUTTLE_METRICS_TOKEN` | The secret store | The metrics | The scraper and the deployment change it together. |
| The derived identity key | `HMAC-SHA256(SHUTTLE_SESSION_SECRET, "shuttle-identity-signature-v1")` | The signature of the identity that the upstreams verify | The upstreams are given the **derived key**, never the secret. |

The rules:

- a secret is never written in the image, in the configuration file or in
  the repository;
- the upstreams verify the signature of the identity with the derived key
  and never with the secret of the sessions;
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

The path of a request is forwarded unchanged. The ingress must not rewrite
it and must not add a prefix: the upstream application is mounted under the
path of its route, and the signature of the identity covers the path the
upstream receives.

## The metrics

`GET /metrics` answers the Prometheus text exposition format. The endpoint
is `404` when `SHUTTLE_METRICS_TOKEN` is not set and `401` when the bearer
token does not match.

| Metric | What it says | What an operator does with it |
| --- | --- | --- |
| `shuttle_requests_total{route,method,status}` | Every answer of the gateway, the refusals included. | The traffic of the routes. |
| `shuttle_request_errors_total{route}` | The answers with a status of 5xx. | An error of the gateway or of the upstream. |
| `shuttle_auth_failures_total{route,reason}` | The callers that were rejected (`unauthenticated`, `missing_role`, `access_denied`). | A policy of the platform, not an error of the gateway. |
| `shuttle_cross_site_refusals_total{route}` | The requests that came from another site. | An attack or a broken client. |
| `shuttle_websocket_connections_total{route}` | The WebSockets that were accepted. | The capacity. |
| `shuttle_websocket_refusals_total{reason}` | The handshakes that were refused. | The capacity, the origins. |
| `shuttle_request_duration_seconds{route}` | The latency of the exchanges. | The budgets of the routes. |
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
| The access service | The requests with a workspace are denied (`403`). The other routes are unaffected. |
| The shared state (Redis) | The sessions fail closed (`401`/`503`), the limiter fails open, the decisions are asked for again. |
| The upstreams | The requests of the route are answered with `502`. The other routes are unaffected. |

## The recovery

| Symptom | What it means | What the operator does |
| --- | --- | --- |
| `/readyz` answers `503` with `config.lastError` | The configuration file is broken. | The file is corrected. The last good configuration keeps serving the traffic. |
| `/readyz` answers `503` with `sessionStore: unavailable` | The shared state is not reachable. | The shared state is restored. The deployment is out of the rotation until then. |
| Every request answers `404 no_route` | The ingress rewrites the `Host` header and does not report the public host. | The ingress sets `x-forwarded-host`, or the routes match the host the ingress sends. |
| Every request answers `403 cross_site_request` | The same, with the origin the browser sends. | The ingress sets `x-forwarded-host` and `x-forwarded-proto`. |
| `shuttle_shared_state_errors_total` grows | The shared state is degraded: the limiter fails open and the decisions are asked for again. | The shared state is restored. |
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
| End the sessions of the callers of a deployment | The keys of the prefix are removed (`SCAN` + `DEL`, or `FLUSHDB` when the deployment has the state to itself). | Every caller has to sign in again. |
| End every session of every deployment that shares the state | The keys of the prefix of the deployment are removed. | The same. |

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
| Network tests | `bun test test/network` | yes |
| The shared state against a real Redis | `bun test test/integration` | yes |
| The browser | `bun test test/browser` | yes |
| The soak | `bun test test/load` | yes |
| The load | `bun run load` | yes |
| The image | `docker build` and the smoke tests | yes |

The last full run of the suite: **388 tests passed, 0 failed** over 38 files
with Bun 1.4.3, including the 14 tests against a real Redis 7.0.15
(`SHUTTLE_TEST_REDIS_URL=redis://127.0.0.1:6399/0`), the 3 tests in Chromium
and the 2 soak tests. The coverage of the lines of the source is
**91.3 %** and the coverage of the functions is **92.1 %**.

Without a Redis server, the fourteen tests of the shared state are skipped and
the rest pass.

## The workflow of the release

The CI workflow (`.github/workflows/ci.yml`) runs six jobs:

| Job | What it proves |
| --- | --- |
| `check` | The types, the lint, the format, the import boundaries, the unit and contract tests, the network tests and the soak. |
| `redis` | The shared state against a real Redis 7. |
| `load` | The capacity: 20 000 requests at 100 in flight, and 500 WebSockets. |
| `browser` | The cookies and the origins in a real Chromium. |
| `image` | The image builds, starts with the configuration of a deployment, refuses to start without a session secret, without an access service, without an identity provider and without a rate limit, and does not contain the fixtures. |

The release workflow (`.github/workflows/release.yml`) builds the image of a
tag, starts it with the configuration of a deployment and exports it as an
artifact of the run. The image carries the version and the revision as
labels, and holds the dependencies of the gateway alone.

## The gaps of the deployment

Nothing is missing from the contract of [spec.md](spec.md). The following
are outside the scope of the gateway and are the responsibility of the
deployment:

| Gap | Where it is closed |
| --- | --- |
| The TLS of the clients | An ingress in front of the gateway. |
| The upstream is static per route | A router in front of the pods, when the workspace decides the pod. |
| The revocation of an access takes the TTL of the cache | The TTL is the knob: `SHUTTLE_ACCESS_CACHE_TTL_MS`. |
| The latency of a decision that is not cached | The control plane has to be fast. The cache absorbs the rest. |
| One hostname per product surface | Subdomains, or one host with distinct path prefixes. |

# The operations of the gateway

This document describes how the gateway is deployed, what the operator has
to configure, what the failure of a dependency means and how a deployment is
rolled back.

## The topology

```
                 ┌──────────────┐
   the callers → │   ingress    │  TLS, the limits of the connections
                 └──────┬───────┘
                        │ http, the headers of the proxy
                 ┌──────▼───────┐
                 │   shuttle    │  × N replicas, the same image
                 └──────┬───────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
   the upstreams   the identity      the access
   (the apps)      provider          service
                                    (the workspaces)
                        │
                        ▼
                 ┌──────────────┐
                 │    redis     │  the sessions, the limits, the decisions
                 └──────────────┘
```

The gateway is stateless: everything that has to survive a restart lives in
the shared state. A replica can be replaced at any moment.

| Piece | What it is | What happens when it is not reachable |
| --- | --- | --- |
| The identity provider | the OpenID Connect provider of the platform | the logins fail with `503`, the callers that have a session keep working |
| The access service | the service that decides who may use a workspace | the requests with a workspace are denied (`403`), the others are unaffected |
| The shared state (Redis) | the sessions, the rate limits, the cached decisions | the sessions fail closed (`401`/`503`), the limiter fails open, the decisions are asked for again |
| The upstreams | the applications | the requests of the route are answered with `502`, the other routes are unaffected |

## The settings of a deployment

| Variable | Value | Why |
| --- | --- | --- |
| `SHUTTLE_CONFIG` | `/etc/shuttle/routes.json` | the route table, mounted as a file |
| `SHUTTLE_GATEWAY_HOST` | `0.0.0.0` | the listener |
| `SHUTTLE_GATEWAY_PORT` | `8080` | the listener |
| `SHUTTLE_OIDC_ISSUER` | the issuer of the provider | the callers are authenticated against it |
| `SHUTTLE_OIDC_CLIENT_ID` / `_CLIENT_SECRET` | the client of the gateway | the secret is in the secret store |
| `SHUTTLE_OIDC_REDIRECT_URI` | `https://<the public url of the gateway>/auth/callback` | the provider sends the browser back to it |
| `SHUTTLE_ACCESS_URL` / `_ACCESS_TOKEN` | the service and the token of the gateway | the token is in the secret store |
| `SHUTTLE_SESSION_SECRET` | a random value of at least 32 bytes | it signs the state of the login and the identity of the upstreams: it has to be the **same on every replica** |
| `SHUTTLE_SESSION_URL` | `rediss://:<password>@<redis>:6379/0` | the sessions of the callers |
| `SHUTTLE_SHARED_STATE_URL` | `rediss://:<password>@<redis>:6379/1` | the limits and the decisions; it defaults to the url of the sessions |
| `SHUTTLE_METRICS_TOKEN` | a random value | the metrics are only served with it |
| `SHUTTLE_TRUSTED_PROXIES` | the ranges of the ingress | the forwarding headers are only trusted from them |
| `SHUTTLE_EXTERNAL_PROTO` | `https` | the protocol the callers use |
| `SHUTTLE_COOKIE_SECURE` | `true` | the cookies of the gateway are `Secure` |
| `SHUTTLE_MAX_BODY_BYTES` | the limit of the deployment | the limit of the routes wins over it |
| `SHUTTLE_SHUTDOWN_TIMEOUT_MS` | `15000` | the deadline of the drain |

The full list is in [.env.example](../.env.example) and the defaults are in
`src/runtime/env.ts`.

## The secrets

| Secret | Where it comes from | What it protects | How it is rotated |
| --- | --- | --- | --- |
| `SHUTTLE_SESSION_SECRET` | the secret store of the platform | the state of the login and the signature of the identity | the signature of the identity changes with it: the upstreams have to be given the new derived key at the same time. The logins of the callers in flight fail and they have to sign in again |
| `SHUTTLE_OIDC_CLIENT_SECRET` | the secret store | the exchange of the code | the provider accepts two secrets during the rotation of the client, the deployment changes the value afterwards |
| `SHUTTLE_ACCESS_TOKEN` | the secret store | the calls to the access service | the service accepts two tokens during the rotation |
| The password of Redis | the secret store | the sessions and the limits | the deployment changes the password of the client and of the server in the same window |
| `SHUTTLE_METRICS_TOKEN` | the secret store | the metrics | the scraper and the deployment change it together |
| The derived identity key | `HMAC-SHA256(SHUTTLE_SESSION_SECRET, "shuttle-identity-signature-v1")` | the signature of the identity that the upstreams verify | it is derived from the secret: the upstreams are given the **derived key**, never the secret |

The rules:

- a secret is never written in the image, in the configuration file or in the
  repository;
- the upstreams verify the signature of the identity with the derived key
  and never with the secret of the sessions;
- the secret of the sessions is the same on every replica: a replica with
  another secret cannot read the session of a caller and cannot verify the
  state of a login.

## The ingress

The gateway does not terminate TLS and it does not rewrite the path of a
request: the ingress is in front of it and it has to preserve the streaming
of the bodies and the websockets.

| Setting | Value | Why |
| --- | --- | --- |
| The timeouts of the ingress | at least `SHUTTLE_SHUTDOWN_TIMEOUT_MS` for the read, and **no** write timeout | a stream of events lasts longer than any write timeout |
| The buffering of the request | off | the body of a request is streamed to the upstream, a buffered body breaks the budgets and the limits of the body |
| The buffering of the answer | off | the same, for the answers |
| `proxy_http_version` | `1.1` | the websockets need it |
| `proxy_set_header Upgrade` / `Connection` | on | the websockets need it |
| The limits of the body | the limit of the route (`maxBodyBytes`), or the biggest one | the gateway refuses the bodies that are over the limit with `413`; the ingress may refuse them earlier, with its own answer |
| The timeouts of the idle connections | at least `SHUTTLE_WS_IDLE_TIMEOUT_SECONDS` | the websockets of the editors are idle most of the time |
| The number of connections | at least the number of the websockets of the deployment | the ingress is the limit of the connections |
| The health check | `GET /healthz` | it is always available |
| The readiness check | `GET /readyz` | it answers `503` when the gateway cannot serve the traffic |

The gateway tells the ingress the real address of the caller in
`x-forwarded-for`, `x-forwarded-proto` and `x-forwarded-host`. The ingress
has to set them, and the ranges of the ingress have to be in
`SHUTTLE_TRUSTED_PROXIES` (or in the `trustedProxies` of the configuration
file): the headers of a client that is not a trusted proxy are ignored.

The path of a request is forwarded unchanged. The ingress must not rewrite
it, and it must not add a prefix: the upstream application is mounted under
the path of its route and the signature of the identity covers the path the
upstream receives.

## The metrics

`GET /metrics` answers the Prometheus text exposition format. The endpoint
is `404` when `SHUTTLE_METRICS_TOKEN` is not set and `401` when the bearer
token does not match.

| Metric | What it says | What an operator does with it |
| --- | --- | --- |
| `shuttle_requests_total{route,method,status}` | the requests that were handled | the traffic of the routes |
| `shuttle_request_errors_total{route}` | the answers with a status of 5xx | an error of the gateway or of the upstream |
| `shuttle_auth_failures_total{route,reason}` | the callers that were rejected (`unauthenticated`, `missing_role`, `access_denied`) | a policy of the platform, not an error of the gateway |
| `shuttle_websocket_connections_total{route}` | the websockets that were accepted | the capacity |
| `shuttle_websocket_refusals_total{reason}` | the handshakes that were refused | the capacity, the origins |
| `shuttle_request_duration_seconds{route}` | the latency of the exchanges | the budgets of the routes |
| `shuttle_bytes_in_total` / `shuttle_bytes_out_total` | the bytes that really went through | the volume |
| `shuttle_active_requests` | the requests that are in flight | the drain |
| `shuttle_config_reloads_total{result}` | the reloads of the configuration | a broken file on disk |
| `shuttle_rate_limited_total` | the requests that the limiter refused | a flood |
| `shuttle_cross_site_refusals_total{route}` | the requests that came from another site | an attack or a broken client |
| `shuttle_shared_state_errors_total` | the times the shared state was not reachable | the degradation of the deployment |

The labels are bounded: the route (or the fixed value `unmatched`), the
method, the status and a closed set of reasons. A workspace, a subject, an
url or a request id are never a label, so the metrics of a busy gateway do
not grow the memory of the process.

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

## The recovery

| Symptom | What it means | What the operator does |
| --- | --- | --- |
| `/readyz` answers `503` with `config.lastError` | the configuration file is broken | the file is corrected; the last good configuration keeps serving the traffic |
| `/readyz` answers `503` with `sessionStore: unavailable` | the shared state is not reachable | the shared state is restored; the deployment is out of the rotation until then |
| `shuttle_shared_state_errors_total` grows | the shared state is degraded: the limiter fails open and the decisions are asked for again | the shared state is restored |
| `shuttle_request_errors_total` grows for one route | the upstream of the route is broken | the upstream is repaired; the other routes are unaffected |
| `shuttle_cross_site_refusals_total` grows | a client of the platform sends requests from another site | the origin of the client is added to `SHUTTLE_ALLOWED_ORIGINS`, or the client is fixed |
| `shuttle_rate_limited_total` grows | a flood | the limits of the deployment are reviewed; the limiter protects the upstreams |
| the logins fail with `503` | the identity provider is not reachable | the provider is restored; the callers that have a session keep working |

## The rollback

The gateway is a stateless process: a rollback is the deployment of the
previous image.

1. The deployment of the previous image is started with the same
   configuration and the same secrets. The routes are read from the file, so
   a rollback does not need a change of the configuration.
2. The pods of the new version are drained: the readiness answers `503`, the
   websockets are closed with the code 1001 and the requests that are in
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

## The rotation of the secret of the sessions

1. The new secret is added to the secret store.
2. The deployment is changed to the new secret. The replicas are replaced
   one by one: **a replica with the old secret and a replica with the new
   secret do not understand each other** (the state of the login and the
   signature of the identity differ), so the replicas of a rollout have to
   be replaced quickly (`maxUnavailable: 0` with a surge, or a maintenance
   window).
3. The upstreams are given the new derived key.
4. The old secret is removed from the secret store.

The callers that were in the middle of a login have to sign in again: the
state of the login is signed with the old secret.

# Shuttle — Specification

Shuttle is an application gateway. It authenticates a caller against an
OpenID Connect provider, asks an access service whether the caller may use a
workspace, and forwards the request to an upstream of the route it matched.

This document is normative for product behavior and source organization.
[architecture.md](architecture.md) describes how the code is laid out and
which file owns what; [decisions.md](decisions.md) records the decisions
behind the contract. Recommendations in an implementation guide do not
become requirements until they are recorded here.

Status: 0.4.0. Runtime: Bun ≥ 1.4.3 (§15, decision 20). The gateway **refuses
to start** on an older runtime: the boundaries it relies on are not
observable there. Listener: HTTP and
WebSocket on `SHUTTLE_GATEWAY_HOST:SHUTTLE_GATEWAY_PORT` (default
`0.0.0.0:8080`).

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **caller** | The client of the gateway: a browser or an API client. |
| **principal** | The authenticated caller: `subject`, optional `email`, `roles`, and the `source` of the credential (`session` or `jwt`). |
| **route** | A host and path match with one policy and one upstream, or an ordered list of upstreams that a request is sent to one at a time. |
| **workspace** | The unit of access control, named by a path placeholder (`{workspaceId}`). |
| **upstream** | The application a request is forwarded to. |
| **access service** | The external service that decides whether a subject may use a workspace. |

Invariants. All of them are enforced in code and none of them is
configurable:

- Shuttle never decides access on its own. It asks the access service and
  fails closed.
- The identity headers of Shuttle are written only by Shuttle. A copy sent
  by a client is always stripped.
- The cookies of the gateway never reach an upstream.
- A credential that the mode of the route selected and that turns out to be
  invalid is rejected. The gateway does not fall back to another credential
  (§5.1).
- The cross-site guard is driven by the **presence of the session cookie**,
  not by the credential that authenticated the request (§8).

---

## 2. The request pipeline

### 2.1 The request identifier

A middleware wraps the endpoints of the gateway and the dispatcher, so every
answer carries one:

- the `x-request-id` of the request is reused when it matches
  `^[A-Za-z0-9._-]{1,64}$`;
- otherwise a UUID is generated;
- it is written in the `x-request-id` header of the answer and in every log
  line of the request.

An identifier that is not valid is replaced by a generated one: it ends up
in a log line and in a header, so it may not carry anything else.

### 2.2 The endpoints of the gateway

The paths of the gateway itself are matched by their own handlers, before
the route table is consulted. They are never forwarded to an upstream,
whatever the configuration says.

| Endpoint | Behaviour |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok",…}`. Always available. |
| `GET /readyz` | `200` when a configuration is loaded and the session store answers, `503` otherwise (§12.3). |
| `GET /metrics` | Prometheus text. `404` when `SHUTTLE_METRICS_TOKEN` is unset, `401` when the bearer token does not match. |
| `GET /auth/login` | Login limiter, then an OIDC redirect (§5.2). |
| `GET /auth/callback` | Completes the login (§5.2). |
| `GET /auth/logout` | Cross-site navigation guard, then the session is destroyed and the answer is `302 /`. |

`/auth/login` needs the address of the caller for its limiter, so the
handler computes the forwarding context itself (§7.3), exactly like the
dispatcher does.

A request that uses another method on one of these paths (for example
`POST /healthz`) falls through to the dispatcher and is refused with
`404 not_found`: the path is reserved.

### 2.3 The dispatcher

Every other request runs these steps, in this order:

1. **Configuration.** No configuration has ever been loaded → `503
   not_ready`.
2. **Reserved path.** The path is one of the endpoints of §2.2, or one of
   the `reservedPaths` of the configuration → `404 not_found`.
3. **Forwarding context.** The peer address, the trusted-proxy evaluation
   and the client address are computed (§7.3).
4. **Route match.** The route is matched (host and path) **before** the
   limiters, so the budget of a route is keyed by the route that would
   handle the request.
5. **Rate limits.** The budget of the deployment, then the budget of the
   caller over all the routes, then the budget of the caller on this route
   (§9). A refusal → `429 too_many_requests` with `retry-after`.
6. **No route.** A request that matched no route → `404 no_route`. It has
   already been counted by the limiters, in the `none:<ip>` bucket: a flood
   of requests to a path that does not exist is a flood like any other.
7. **Authentication.** Per the mode of the route (§5). Failure → `401
   unauthorized`, or a `302` to `/auth/login?redirect=…` when the client
   accepts HTML and the mode is not `jwt`-only.
8. **Principal limit.** The budget of the authenticated caller on this
   route (§9). Refusal → `429 too_many_requests`.
9. **Cross-site guard.** Applied when the request carries the session
   cookie (§8). Refusal → `403 cross_site_request`.
10. **Workspace check.** The placeholder is read, validated as a UUID when
    `requireUuid` is set, and the access service is asked (§6). A denial →
    `403 workspace_forbidden`; an outage of the access service → `503
    access_unavailable`.
11. **Dispatch.** A WebSocket upgrade (§10) or HTTP proxying (§11).

The answers the gateway generates itself are JSON
`{"error": <code>, "message": <text>}`, except the documented redirects,
the client-disconnect outcome and the upgrade behavior. The bodies of the
upstreams are forwarded as they are.

---

## 3. The configuration file

The route table is a JSON file. It is validated as a whole and rejected as a
whole when it is invalid: a configuration that is half applied is a
configuration nobody can reason about.

```jsonc
{
  "version": 1,
  "defaults": {
    "auth": { "mode": "none" },
    "timeouts": { "responseMs": 5000, "firstByteMs": 30000, "bodyMs": 300000 },
    "maxBodyBytes": 10485760
  },
  "trustedProxies": ["10.0.0.0/8"],
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

### 3.1 The fields

| Field | Rule |
| --- | --- |
| `version` | Exactly `1`. |
| `defaults.auth` | The policy of the routes that declare none (§5). |
| `defaults.timeouts` | The budgets of the routes that declare none (§11.2). |
| `defaults.maxBodyBytes` | The body limit of the routes that declare none. |
| `defaults.crossSite` | The policy of the cross site requests of the routes that declare none (§8). The default is `navigation`. |
| `defaults.forwardAuthorization` | Whether the routes that declare none forward the `Authorization` header of the caller to their upstream (§7.1). The default is `true`. |
| `defaults.accessCacheTtlMs` | The lifetime of a cached decision of the access service for the routes that declare none (§6). The default is the one of the environment. |
| `defaults.accessStaleGraceMs` | The grace of an outage of the access service for the routes that declare none (§6). The default is the one of the environment. |
| `defaults.replayMaxBytes` | The size of a body that may be sent again to a second upstream, for the routes that declare none (§11.4). The default is the one of the environment. |
| `trustedProxies` | The ranges whose forwarding headers are honoured (§7.3). The ranges of the environment are added to them. |
| `reservedPaths` | The paths the gateway keeps for itself, on top of §2.2. |
| `routes` | At least one route. |

A route:

| Field | Rule |
| --- | --- |
| `id` | Lowercase kebab-case, at most 63 characters, unique. |
| `match.host` | `example.com`, `*.example.com` (the subdomains, not the domain itself), or `*` for any host. |
| `match.path` | A list of segments. A segment is a literal or a `{placeholder}`. |
| `match.methods` | The methods the route accepts, upper cased. A route that names none accepts every method. A route that names the methods it accepts handles the other ones nowhere (§3.3). |
| `rewrite` | The path the route forwards to its upstream. A list of segments; the placeholders of the path of the route are the values the caller sent, and `{rest}` is the part of the path that follows the prefix the route matched. A route without one forwards the path of the request (§11.1). |
| `upstream` | An `http` or `https` url, or a list of them. A url may not carry a query string or a fragment. The upstreams are tried in the order of the list (§11.4). |
| `auth` | The policy of the route. It replaces `defaults.auth`; it is not merged with it. |
| `timeouts` | The budgets of the route. Merged field by field with `defaults.timeouts`. |
| `maxBodyBytes` | The body limit of the route. It wins over `defaults.maxBodyBytes`, which wins over `SHUTTLE_MAX_BODY_BYTES`. |
| `replayMaxBytes` | The size of a body that may be sent again to a second upstream (§11.4). It replaces `defaults.replayMaxBytes`, which wins over `SHUTTLE_REPLAY_MAX_BYTES`. |
| `crossSite` | The policy of the cross site requests of the route: `navigation` (the default) or `strict` (§8). It replaces `defaults.crossSite`. |
| `forwardAuthorization` | Whether the `Authorization` header of the caller is forwarded to the upstream of the route (§7.1). It replaces `defaults.forwardAuthorization`. |
| `accessCacheTtlMs` | The lifetime of a cached decision of the access service for the route, in milliseconds (§6). It replaces `defaults.accessCacheTtlMs`. `0` asks the service for every request. |
| `accessStaleGraceMs` | How long a decision of the access service may be served after the service became unreachable, in milliseconds (§6). It replaces `defaults.accessStaleGraceMs`, which wins over `SHUTTLE_ACCESS_STALE_GRACE_MS`. `0` disables the grace. |
| `accessCheck` | Whether the access service is asked about the route when the route names no workspace (§6). The default is `false`: a route that names no workspace is not checked. A check needs an authentication mode other than `none`. |
| `websocket` | Whether the route accepts WebSocket upgrades. Default `false`. |

An unknown key is a configuration error, not a setting that is silently
ignored.

### 3.2 The route table is rejected when it is ambiguous

Two routes that could match exactly the same request — the same kind of host
with the same value and the same path skeleton — are refused when the
configuration is loaded. A table that is ambiguous would make the answer of
the gateway depend on the order of the file.

A route that claims a reserved path is refused for the same reason.

### 3.3 The precedence of the routes

The routes are sorted once, when the configuration is loaded. The first
route that matches the host and the path of a request handles it.

1. The specificity of the host: an exact host, then a wildcard
   (`*.example.com`), then the catch-all (`*`).
2. The length of the literal prefix of the path template.
3. The number of segments of the template.
4. The id of the route, alphabetically.

The **method** of the request decides between the routes that match the host
and the path:

- a route that names the methods it accepts handles the request only for
  those methods;
- among the routes that match, one that names the method of the request
  wins over one that names none. A route that names no method is the
  fallback of the others: it handles the methods that no other route names.

Two routes that name the same methods and match the same host and the same
path are ambiguous and are refused (§3.2). Two routes that name different
methods are not: they are two halves of one route.

---

## 4. The environment

The environment is read once, at the start of the process, and it is
validated as a whole: a value that cannot be understood stops the gateway,
because a setting that looks active but is not a security hole. The only
exception is the level of the log, which falls back to `info`.

The **runtime** is validated the same way and before the environment: the
gateway needs Bun ≥ 1.4.3 (§15, decision 20) and stops on an older one,
because the boundaries it relies on — the early answer of an upstream while
the upload runs, the cancellation of the producer of the body, the refusal
of the handshake of an upstream websocket and the upgrade of the caller with
the headers of the gateway — are not observable there. The measurements are
in [runtime.md](runtime.md).

The names of the variables never leave `src/runtime/env.ts`. The rest of the
gateway receives the settings it needs, not the environment.

The full list, with the default of every value, is in
[.env.example](../.env.example). A production deployment has to set:

| Variable | Why |
| --- | --- |
| `SHUTTLE_SESSION_SECRET` | Signs the state of the login and derives the key of the identity signature. The same value on every replica. |
| `SHUTTLE_OIDC_ISSUER` | Names the identity provider. |
| `SHUTTLE_OIDC_CLIENT_ID` | Names the client of the gateway. |
| `SHUTTLE_OIDC_REDIRECT_URI` | The url the provider sends the browser back to. |
| `SHUTTLE_OIDC_CLIENT_SECRET` | The secret of the client. `SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT=true` replaces it when the provider accepts a public client. |
| `SHUTTLE_ACCESS_URL` | Names the access service. |
| `SHUTTLE_ACCESS_TOKEN` | The token the gateway authenticates with. `SHUTTLE_ACCESS_ALLOW_ANONYMOUS=true` replaces it when the service authenticates the gateway by other means. |
| One rate limit | At least one of `SHUTTLE_RATE_LIMIT_MAX`, `SHUTTLE_RATE_LIMIT_GLOBAL_MAX`, `SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX` and `SHUTTLE_RATE_LIMIT_TOTAL_MAX` must be non-zero. `SHUTTLE_ALLOW_NO_RATE_LIMITS=true` replaces them when another layer protects the deployment. |
| The shared state | `SHUTTLE_SESSION_URL` and `SHUTTLE_SHARED_STATE_URL` must name a Redis server or a Postgres server: a session that lives in the memory of one replica is unknown to the others, and a limit that lives in the memory of one replica is the limit of that replica. `SHUTTLE_ALLOW_MEMORY_STATE=true` replaces them when the deployment is a single node that accepts it. |

The url of the shared state names the shape of the server:

| The url | The server |
| --- | --- |
| `redis://host:6379/0` | A Redis server. |
| `redis://host-a:6379,host-b:6379/0` | A Redis cluster: the hosts are its masters. |
| `redis://host-a:26379,host-b:26379/0` with `SHUTTLE_REDIS_SENTINEL_MASTER` | The sentinels of a Redis server: the master and the replicas are discovered from them. |
| `postgres://user:password@host:5432/shuttle` | A Postgres server. |
| `postgresql://user:password@host:5432/shuttle` | The same Postgres server. |

`SHUTTLE_REDIS_SENTINEL_MASTER` is the name of the master, the one the
sentinels agree on. It is empty by default: a deployment that is not
behind sentinel does not set it.

---

## 5. Authentication

### 5.1 The modes

The mode of a route decides which credentials the route accepts and the
order in which they are evaluated. The order is fixed, so the credential
that authenticates a request never depends on the shape of the request.

| Mode | Credential |
| --- | --- |
| `none` | None. The request is forwarded unauthenticated. |
| `session` | The session cookie of the gateway. The `Authorization` header is ignored. |
| `jwt` | The bearer token of the caller. |
| `any` | The bearer token first, the session cookie second. |

A credential that is present but invalid is **rejected**, not replaced by
another one: a caller that asked for a token and sent a wrong one is not a
session caller. In `any` mode, an `Authorization` header that is not a
bearer token is a rejection.

### 5.2 The browser flow

1. `GET /auth/login?redirect=<path>` — the login limiter runs, then the
   gateway redirects to the provider with PKCE (`S256`), a `state` and a
   `nonce`. The redirect target is signed into the state cookie and is
   always a relative path: a crafted parameter cannot turn the login into
   an open redirect.
2. The provider sends the browser back to `GET /auth/callback`.
3. The gateway verifies the state against the cookie, exchanges the code
   with the verifier of the PKCE challenge, checks the nonce, and requires
   an id token.
4. The session is created and the cookie is written.

The state of the login is single use on four levels: the state cookie is
deleted as soon as the callback is processed, the state of the callback has
to be the state of the cookie, the verifier and the nonce bind the exchange
to the login attempt, and the authorization code is single use at the
provider.

### 5.3 The sessions

A session is a server-side record. The browser holds an opaque id of 32
random bytes, so the gateway can revoke a session, expire it and read the
roles of the caller again.

| Bound | Default | Meaning |
| --- | --- | --- |
| Idle lifetime | `SHUTTLE_SESSION_TTL_MS` (8 h) | How long a session survives without being used. It is refreshed on a read, at most once per `SHUTTLE_SESSION_TOUCH_INTERVAL_MS`. |
| Maximum age | `SHUTTLE_SESSION_MAX_AGE_MS` (24 h) | How long a session may be used at all, counted from its creation. `0` means no maximum age. |

The maximum age is the real bound. The cookie of the browser follows the
session: its `Max-Age` is the smaller of the idle lifetime that is left and
the maximum age that is left, so it never outlives the session it names.

The store is in memory (`memory://local`) or in a server that the replicas
share: a Redis server or a Postgres server. A deployment with several
replicas needs one of the two: a session that lives in the memory of one
replica is unknown to the others.

A store that cannot be reached denies the caller. The gateway never lets
somebody in because the store had a hiccup.

**The revocation of the sessions of a caller.** Every session of a subject
can be revoked at once, without touching the sessions of the other callers.
The gateway exposes no endpoint for it: a gateway that answers an
administrative request is a request an attacker reaches. The revocation is
a script of the deployment, against the state the replicas share:

```bash
bun run sessions -- --subject alice@example.test
```

The subject is the `sub` of the identity provider. The script removes the
sessions and prints how many it removed.

### 5.4 The bearer tokens

The bearer token is validated against the same provider: the signature
(through the remote JWKS set), the issuer, the audience and the expiry. The
accepted algorithms are `RS256`, `ES256`, `RS384`, `RS512`, `ES384` and
`PS256`. The tolerance of the clock is five seconds.

A bearer token has to be an **access token**, and not the id token of the
gateway. Many providers publish an id token and an access token for the same
client and the same audience, and an id token travels through the browser: it
lands in the history, in the logs and in the referrers.

Two rules keep them apart:

- The browser flow of the gateway always asks for a nonce, so the id token of
  this client **always** carries a `nonce` claim and an access token never
  does. A bearer token that carries a nonce is refused. The rule is on by
  default and `SHUTTLE_OIDC_REJECT_NONCE_TOKEN=false` turns it off for a
  provider whose access tokens carry a nonce anyway.
- A provider that publishes a claim that names the type of the token names
  it in `SHUTTLE_OIDC_REQUIRED_TOKEN_CLAIMS`, and a bearer token that does
  not carry it is refused.

A token that is verified **against a nonce** is an id token and not a bearer
token, so the rule of the nonce does not apply to it.

### 5.5 The cookies

| Cookie | Attributes |
| --- | --- |
| `shuttle_session` | The id of the session. `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`. |
| `shuttle_oidc_state` | The state of a login in flight. The same attributes. |

The names are not configurable. An upstream that could write the cookie of
the gateway could fix the session of a browser to an id of its choice (§7.2).

---

## 6. Workspace access

The gateway never decides access on its own. It asks the access service:

```
POST {SHUTTLE_ACCESS_URL}/v1/decisions
Authorization: Bearer {SHUTTLE_ACCESS_TOKEN}
Content-Type: application/json

{"subject":"user-1","workspaceId":"…","routeId":"workspace-api","roles":["dev"]}
```

The workspace is the unit of access of the platform, and it is the thing
the service is asked about. A route that names no workspace may still be
checked: the service is then asked about the route itself, and the request
carries no workspace (§6.3).

The answer is `{"allow": true}` or `{"allow": false, "reason": "…"}`. A
status that is not a success, a body that is not JSON and a decision that is
malformed are all the **unavailability of the service**, and not a denial:
only an explicit `{"allow": false}` denies a caller.

The two refusals are not the same thing, and the gateway answers them
differently:

| The decision | The answer of the gateway | The metric |
| --- | --- | --- |
| `{"allow": false}` | `403 workspace_forbidden` | `shuttle_auth_failures_total{reason="access_denied"}` |
| The service could not be asked, or its answer could not be read | `503 access_unavailable`, with a `retry-after` | `shuttle_access_unavailable_total` |

The gateway fails closed in both cases: the request is refused. A denial is
the policy of the platform and it is the same answer for every caller, while
an outage is a failure of the infrastructure: the caller may retry it, and
the operator has to be able to tell the two apart. An outage that answers
`403` looks like a policy, and a policy that answers `503` looks like an
outage.

The reason of the service is never given to the caller: it describes the
policy of the platform and it is not the business of the client.

The decisions are cached for `SHUTTLE_ACCESS_CACHE_TTL_MS` (5 s). Only an
**explicit** decision is cached: a transport failure is not a decision, and
caching it would keep denying a caller that the service would have allowed.

The calls that are **in flight are shared**: a burst of requests for the
same decision asks the service once and not once per request. The cache is
empty every time its lifetime is over, and the lifetime is short, so a
burst that arrives on the boundary of the lifetime would otherwise ask the
service as many times as there are requests.
The cache key is the subject, the workspace, the route and the roles, so a
decision made for a caller with a role is never served to a caller without
it.

The **latency of a revocation is the TTL of the cache**. It is the knob an
operator turns when a revocation has to be immediate. The **grace of an
outage** is the other knob: it is the time the last decision may be served
while the service is down (§6.2).

A route may set its own lifetime with `accessCacheTtlMs`: it replaces
`defaults.accessCacheTtlMs` and the lifetime of the environment. A route
that sets `0` asks the access service for every request, so a revocation on
that route is immediate. The routes of a deployment usually share one
lifetime; the route that carries the sensitive workspace is the one that
needs another.

### 6.1 The protocol of the access service

The access service is a dependency of the deployment and not a part of
Shuttle: a deployment that has one may write it in any language. The
protocol is small, and it is published so that the service can be written
against it and checked against it.

The request:

```
POST {SHUTTLE_ACCESS_URL}/v1/decisions
Authorization: Bearer {SHUTTLE_ACCESS_TOKEN}
Content-Type: application/json

{"subject":"user-1","workspaceId":"…","routeId":"workspace-api","roles":["dev"]}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `subject` | yes | The identifier of the caller. The service decides what it means. |
| `workspaceId` | no | The workspace the request is about. It is absent when the route asks the access service about itself and names no workspace (§6.3). |
| `routeId` | no | The route the request came in on. It may be part of the policy of the service. |
| `roles` | no | The roles of the caller. They are part of the key of the cached decision. |

The answer is `200` with a body that carries a boolean `allow`:

```json
{"allow": true}
{"allow": false, "reason": "the subject does not have the role of the workspace"}
```

The `reason` is free text and it is never given to the caller. It is
counted in the metrics when it mentions a role.

The status of the answer:

| Status | What it means |
| --- | --- |
| `200` | A decision. The body carries `allow`. |
| `400` | The request is malformed: it is not json, or it has no subject. A service that needs a workspace of its own refuses a request that has none with this status. |
| `401` | The token is missing or wrong. |
| `404` | The path is not the path of the protocol. |
| anything else | The unavailability of the service: the gateway answers `503 access_unavailable`. |

A body that is not json, or one whose `allow` is not a boolean, is the
unavailability of the service as well: only an explicit `{"allow": false}`
denies a caller.

**The conformance suite.** The protocol is a contract, and a contract is
worth nothing without a way to check it. `test/integration/access-conformance.ts`
is that way: it runs against any implementation, and the deployment that
writes its own service runs it against that service. The suite checks the
allow, the deny, the reason of a denial, the malformed requests, the token,
the path and the request that names no workspace.

**The reference implementation.** `services/access-service.ts` is an
implementation of the protocol that a deployment may run: it applies a
policy file and it answers the protocol. It is not a fixture: the fixtures
carry accounts with known passwords and refuse to run in a production
environment, and this one carries the policy of the operator. The suite
runs against it in the test suite, so the protocol and its reference do not
drift apart.

---

### 6.2 The grace of an outage

An outage of the access service is an outage of the deployment: the
gateway answers `503 access_unavailable` to every request of the routes
that need a decision, and the traffic of the deployment stops.

A route may ask for a **grace**: `accessStaleGraceMs`
(`SHUTTLE_ACCESS_STALE_GRACE_MS`, `0` by default) is the time the last
decision of the service may be served after the service became
unreachable.

| The service | The grace | What the caller gets |
| --- | --- | --- |
| answers | any | The decision of the service. |
| does not answer, and the last decision allows the caller | above zero, and the decision is inside the grace | The last decision. The gateway goes on. |
| does not answer, and the last decision denies the caller | any | `503 access_unavailable`. |
| does not answer, and there is no decision | any | `503 access_unavailable`. |
| does not answer, and the decision is older than the grace | any | `503 access_unavailable`. |

The rules of the grace:

- the grace is **off by default**: an unreachable service is an outage, and
  the outage has to be visible;
- a stale decision is served only when it **allows** the caller. A denial
  that is served instead of the outage would hide the outage from the
  operator, and the refusal of the caller is the same answer as the refusal
  of a gateway that fails closed;
- the grace is a **delay of a revocation**: a caller whose access was
  revoked keeps it until the grace is over. The grace of a route and the
  lifetime of its decisions are the two knobs of that delay;
- a decision that is asked for **fresh** is never stale: the revalidation
  of an open connection asks for a fresh decision, so a connection whose
  access was revoked is closed even when the service is down and the grace
  is large.

The decisions that were served this way are counted in
`shuttle_access_stale_total{route}`, and the age of the decision is
measured in `shuttle_access_stale_age_seconds{route}`.

### 6.3 A route that names no workspace

A route that names a workspace is always checked. A route that names none
is not checked at all, unless it asks for it with `accessCheck`:

```jsonc
{
  "id": "admin-api",
  "match": { "host": "api.example.com", "path": "/admin" },
  "upstream": "http://admin:3000",
  "auth": { "mode": "session" },
  "accessCheck": true
}
```

The request of the access service then carries the subject, the route and
the roles, and **no workspace**. The service decides on those, which is
what a deployment without workspaces needs.

The rules of a check without a workspace:

- a check needs an authentication mode other than `none`: the gateway asks
  the access service about a caller it authenticated. A route that asks
  for a check with the mode `none` is refused when the configuration is
  loaded;
- the decisions of a route without a workspace have their own keys: they
  are never served to a route that names a workspace, and the other way
  around;
- the identity that is written to the upstream carries no workspace, and
  the signature of the identity is the one of the request.

## 7. The header policy

### 7.1 Request → upstream

Removed in both directions, never configurable: `connection`, `keep-alive`,
`proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
`transfer-encoding`, `upgrade`, `host`, all `x-forwarded-*`, `x-real-ip`,
the standard `forwarded` header, and the identity headers `x-shuttle-user`,
`x-shuttle-user-id`, `x-shuttle-email`, `x-shuttle-roles`,
`x-shuttle-workspace`, `x-shuttle-workspace-id`, `x-shuttle-internal`,
`x-shuttle-authenticated`, `x-shuttle-signature`, `x-forwarded-user`,
`x-forwarded-email`, `x-forwarded-groups`, `x-remote-user`,
`x-remote-email`. Every header named by `Connection` is removed as well.

The `Authorization` header of the caller is forwarded to the upstream as it
is. It is not one of the identity headers of the gateway, and the upstream
is an application of the same platform that the operator chose. The identity
of the caller travels in the headers below and in the signature.

The header is a credential of the caller: forwarding it places the upstream
in the trust domain of that credential. A route that does not need it says
so with `forwardAuthorization: false`, and the header is then not forwarded.
The identity of the caller still reaches the upstream, in the headers below
and in the signature.

`Cookie` is rewritten: the cookies of the gateway (`shuttle_session`,
`shuttle_oidc_state`) are removed, the cookies of the application are kept.
The cookies are parsed by the library that implements the standard
(RFC 6265), and the rules of the parsing are the rules of the standard: a
pair without a name is not a cookie and is dropped, a name that carries a
control character is not a name and its cookie is dropped, and the control
characters are removed from the values. What the gateway reads is what it
forwards.

Written by the gateway:

| Header | Value |
| --- | --- |
| `traceparent` | The trace of the request (§7.5). |
| `x-forwarded-for` | The chain, client first, peer of the gateway last. |
| `x-forwarded-proto` | `http` or `https` (the effective protocol). |
| `x-forwarded-host` | The host the caller used. |
| `x-real-ip` | The address of the caller. |
| `x-shuttle-user` | The subject of the caller. |
| `x-shuttle-email` | The e-mail of the caller, when it is known. |
| `x-shuttle-roles` | The roles, comma separated, ambiguous roles dropped. |
| `x-shuttle-workspace` | The workspace, when the route has one. |
| `x-shuttle-signature` | The signature of the identity (§7.4). |

Identity values are stripped of control characters and truncated to 512
characters. A subject that is empty after that cannot be written into a
header at all: the request fails with `500 internal_error`, so the upstream
never receives an identity it cannot trust.

### 7.2 Upstream → client

Removed: the hop-by-hop headers, the identity headers of §7.1, the
`x-forwarded-*` and `x-real-ip` headers, and every `Set-Cookie` that sets a
cookie of the gateway. An upstream must not be able to fix the session of a
browser to an id of its choice.

The `Location` header is made relative when it names the upstream itself,
so the internal hostname never reaches the browser. A location that names
another host is left alone.

### 7.3 The forwarding headers and the client address

The forwarding headers are honoured **only** when the immediate peer is in
`trustedProxies` (the configuration file plus `SHUTTLE_TRUSTED_PROXIES`).
Otherwise they are ignored and the peer address is the client address.

The chain of `x-forwarded-for` is read from the **right**: the right-most
entry that is not a trusted proxy is the client. The entries to its left
were injected by the client and are dropped. The chain that is forwarded
upstream starts at the client and ends at the peer of the gateway.

Reading the left-most entry instead would let a client that sends its own
`x-forwarded-for` choose the address the gateway attributes to it, and with
it the key of the rate limiter.

`x-forwarded-proto` is only honoured from a trusted proxy, and only when it
is `http` or `https`. Anything else falls back to the configured protocol.

`x-forwarded-host` is only honoured from a trusted proxy, and only when it
is a plausible host: no whitespace, no control character, no path. The
value used is the **last** one of the list, because a proxy that appends
writes its own value last. A value that is not a host is ignored.

The effective host decides three things: the route that handles the
request, the origin the browser is compared with, and the value the
signature covers. A deployment behind an ingress that rewrites the `Host`
header therefore needs the ingress to report the public host in
`x-forwarded-host`.

### 7.4 The identity signature

**The key.** The signature is keyed with the private key of the deployment,
`SHUTTLE_IDENTITY_SIGNING_KEY`. It is an elliptic curve key on the curve
P-256, and the signature is an `ES256` one. The upstreams are given the
**public** key: they verify the identity of a request and they cannot mint
one, so the trust boundary is the key and not the network.

The key belongs to the deployment: it is the same on every replica, or the
upstreams refuse the signatures of the others. The script `bun run
identity:key` generates a pair, and `bun run identity:key --public` prints
the public key of the key that is in the environment.

**The symmetric format.** A deployment that does not set the key signs with
the symmetric key that is derived from `SHUTTLE_SESSION_SECRET`:

```
key = HMAC-SHA256(secret, "shuttle-identity-signature-v1")
```

The upstream is then given the derived key, so an upstream that verifies an
identity can mint one as well. The gateway refuses to start in production
without the private key: a setting that looks active but is not is a
security hole.

If `SHUTTLE_SESSION_SECRET` is unset, a random secret is generated **per
process**: the signatures are then not verifiable by an upstream across
replicas or restarts. The gateway refuses to start in production without
it. The secret is never sent to an upstream.

**The format.** The signature is a **JWS** (RFC 7515) with a detached
payload. The protected header names the algorithm and the type of the
signature:

```json
{ "alg": "ES256", "typ": "shuttle-identity" }
```

The symmetric format signs the same way with `HS256`.

**The payload.** The payload is **detached**: it is not transmitted. An
upstream rebuilds it from the request and from the identity headers it
received, so a signature that does not belong to the request is refused by
the verification itself, and not by a comparison that could be written
wrong.

The payload is a canonical JSON **object**, so no value can move from one
field into another and no field can be confused with another one:

```json
{"v":"v4","method":"GET","path":"/base/ws/123","query":"?x=1","host":"api.example.com","subject":"user-1","workspaceId":"…","email":"…","roles":["admin","dev"]}
```

| Field | Value |
| --- | --- |
| `v` | The version of the format: `v5` for the asymmetric one, `v4` for the symmetric one. |
| `method` | The method, upper-cased. |
| `path` | The path **as the upstream received it**: the base path of the upstream in front of the request path. |
| `query` | The query string as the upstream received it, with its leading `?`. The empty string when there is none. |
| `host` | The effective host (§7.3), lower-cased. |
| `subject` | The subject, sanitized as in §7.1. |
| `workspaceId` | The workspace, sanitized. The empty string when there is none. |
| `email` | The e-mail, sanitized. The empty string when it is not known. |
| `roles` | The roles, sorted ascending. The order is not part of the meaning. |

The fields are written in this order, and the roles are sorted, so the
payload is one string that every replica and every upstream rebuilds
byte for byte.

The signature covers exactly the values that are written into the headers:
the **sanitized** subject, e-mail and workspace, and the **filtered** roles
(a role that contains a comma or a control character is dropped, because it
would make the comma separated list of `x-shuttle-roles` ambiguous). The
roles that are handed to the access service are not filtered.

**The value.** `v5=<the detached compact JWS>` for the asymmetric format
and `v4=<the detached compact JWS>` for the symmetric one. The version is
part of the value so the format can change without breaking the
verification, and a signature of one format never verifies with the key of
the other one.

**The verification of an upstream.** The upstream:

1. reads `x-shuttle-signature` and removes the `v5=` prefix;
2. splits the value into its three parts: the protected header, the
   **empty** payload and the signature;
3. rebuilds the payload from the request and from the identity headers;
4. rebuilds the compact serialization around its own payload:
   `<protected>.<base64url(payload)>.<signature>`;
5. verifies it with the public key of the deployment.

The last step is one call of a standard library: `jose.compactVerify(token,
key)`. An upstream does not implement a signature of Shuttle, it verifies a
JWS.

**The test vector** (pinned in `src/domains/forwarding/identity-signature.test.ts`):

```
secret  = "test-secret"
key     = 53060fda6e7406918eb25fc53342d73c12ebd6ff60b20444557bedb92be4ff5c
claims  = { subject: "user-1", email: "user@example.com",
            roles: ["admin","dev"],
            workspaceId: "11111111-1111-4111-8111-111111111111" }
request = { method: "GET", path: "/base/ws/123", query: "?x=1",
            host: "api.example.com" }
payload = {"v":"v4","method":"GET","path":"/base/ws/123","query":"?x=1",
           "host":"api.example.com","subject":"user-1",
           "workspaceId":"11111111-1111-4111-8111-111111111111",
           "email":"user@example.com","roles":["admin","dev"]}
signature = v4=eyJhbGciOiJIUzI1NiIsInR5cCI6InNodXR0bGUtaWRlbnRpdHkifQ..tIL7qgT7uQOhaHjjFpgmOHYSAcjNBrddkreDMFejQm8
```

**The migration from `v4`.** The value of `v4` is signed with a key that
every upstream holds, so an upstream that verifies an identity can mint one
as well. The value of `v5` is signed with the private key of the
deployment: the upstreams are given the public key, and an upstream that
can verify an identity cannot mint one. An upstream that verifies `v4` has
to be changed before the gateway signs `v5`: it reads the version of the
value and verifies with the public key of the deployment.

**The symmetric format is deprecated.** `v4` exists for the development
stack and for the deployments that have not migrated yet. A production
deployment is **refused** at the start when it has no
`SHUTTLE_IDENTITY_SIGNING_KEY`: the symmetric format is not a production
format. The gateway writes a warning in its log when it signs with the
symmetric key, and the format will be removed in the release that follows
the first one that is not a `0.x`. The `v5` format is the only one a
deployment has to implement.

**The migration from `v3`.** The value of `v3` was a hex digest of a
canonical JSON **array**. An upstream that verifies `v3` has to be changed:
it rebuilds the payload as an object and verifies the JWS. The gateway
writes `v4` only, so a deployment that changes the format changes the
contract of its upstreams with it.

### 7.5 The trace of a request

The gateway writes a `traceparent` header to the upstream: the trace
context of the W3C, that ties the request of the caller to the answer of
the upstream.

| The caller sent | The upstream receives |
| --- | --- |
| `00-<trace>-<span>-01` | `00-<trace>-<the span of the gateway>-01`: the id of the trace is the one of the caller and the span is the one of the gateway. |
| A header that is not well formed | `00-<a new trace>-<the span of the gateway>-01`. |
| Nothing | `00-<a new trace>-<the span of the gateway>-01`. |

The rules:

- the header of the caller is **never forwarded as it is**: the gateway
  writes a context of its own, so the upstream always receives a well
  formed one and a broken header of a client cannot confuse the collector
  of the upstream;
- the span of the gateway is new: the span of the upstream is a child of
  it, and the trace of the caller continues;
- the flags of the caller are kept;
- the id of the trace is written in the log of the request, next to the
  request id, so the two halves of a request are found with the same
  search.

The gateway does not export spans: it writes the context and it logs the
id of the trace. A deployment that collects the traces of the upstreams
sees the gateway as the parent of the span of the upstream.

---

## 8. The cross-site requests

A caller that authenticates with a session cookie is a browser, and a
browser can be made to send a request to the gateway from another site.

- `Sec-Fetch-Site` says where the request comes from. A request from
  another site that changes the state of an upstream is refused.
- `Origin` says which origin the request comes from. An origin that is not
  an allowed origin is refused for the methods that change the state of an
  upstream.

The methods that change the state are `POST`, `PUT`, `PATCH` and `DELETE`.

A request with neither header comes from a client that is not a browser and
is allowed: a server to server call is not a cross-site request.

A navigation from another site (a link in an e-mail, a search result) is
allowed by default, because refusing it breaks every deep link into an
application. `SHUTTLE_CSRF_STRICT=true` refuses it as well; it is the mode
for a deployment where the upstreams never change the state of anything on
a `GET`.

A route may refuse the navigations from another site on its own, with
`crossSite: "strict"`. It is the policy of a route whose upstream changes
the state of something on a `GET`: such a route may only be reached from
the site itself. The policy of the deployment applies to the routes that do
not declare one, and a route may declare `crossSite: "navigation"` to keep
the navigations allowed even in a strict deployment.

The allowed origins are the origin of the gateway itself and the origins of
`SHUTTLE_ALLOWED_ORIGINS`. The origin of the gateway is computed from the
**effective host** (§7.3) and the effective protocol.

The guard is applied to every request that carries the session cookie of the
gateway, whatever the credential that authenticated it.

`GET /auth/logout` is refused from another site whatever its method.

---

## 9. The limits

Sliding-window counters.

| Scope | Key | Setting |
| --- | --- | --- |
| The deployment | `deployment:total` | `SHUTTLE_RATE_LIMIT_TOTAL_MAX` |
| A caller over all the routes | `caller:<ip>` | `SHUTTLE_RATE_LIMIT_GLOBAL_MAX` |
| A caller on one route | `route:<id>:<ip>` | `SHUTTLE_RATE_LIMIT_MAX` |
| An authenticated caller on one route | `principal:<id>:<subject>` | `SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX` |
| The requests that match no route | `none:<ip>` | `SHUTTLE_RATE_LIMIT_MAX` |
| The login attempts | `<ip>` | `SHUTTLE_LOGIN_RATE_LIMIT_MAX` |

A limit of `0` disables the limiter.

**The three budgets of a request are counted at the same time.** They are
independent: they are counted in three different windows and none of them
changes the answer of another one. They are checked together, so the state
the replicas share is asked **once** instead of three times: the round trip
is on the path of every request, and the measurements of
[capacity.md](capacity.md) attribute the cost of the shared state to the
number of round trips.

The refusal that is reported is the first of the order of the table: the
deployment, then the caller over all the routes, then the caller on the
route. **Every budget is counted**, even when one of them refuses: the
request was made, and the budget of the caller is spent by the requests
that were made.

**The window.** The window **slides**: the count of a caller is the number
of its requests in the last `windowMs` milliseconds, and not the number of
its requests since the last boundary of the clock.

A fixed window has a property that a limit does not want: a caller that
spends its whole budget at the end of a window and its whole budget again
at the beginning of the next one crosses the gateway twice as fast as the
limit allows. The window of the gateway slides, so the budget of a caller
is the budget of the last `windowMs` milliseconds, always.

The window is counted in **buckets**: it is divided into buckets of
`bucketMs` milliseconds, and the count of the window is the sum of the
counts of the buckets that are in it. Two properties matter:

- a window holds at most 60 buckets, so the state of a caller does not grow
  with its traffic;
- the boundary of a bucket is a moment every replica can compute, so the
  replicas of a deployment count in the same buckets and the limit of the
  deployment is the limit of the configuration.

The count is exact to the bucket: a request stays counted until the bucket
of its moment leaves the window.

A request that is over the limit is **not counted**: a client that keeps
hammering does not push the window further away.

The `retry-after` of a refusal is the time until the oldest requests of
the window leave it: it is the moment the count of the window is under the
limit again.

Two of these scopes exist because the others cannot do their job:

- The scopes that are keyed by an **address** cannot bound a flood that
  spreads over many addresses. Every address gets its own budget. The scope
  `deployment:total` has no address in it, so every request of the
  deployment is counted in the same window.
- The scopes that are keyed by an **address** cannot tell two tenants
  behind the same address apart. The scope `principal` is keyed by the
  subject of the caller, so one tenant cannot spend the budget of the
  others.

The refusal is `429 too_many_requests` with a `retry-after`, and it is
counted in `shuttle_rate_limited_total`.

The Redis limiter fails **open**: a cache hiccup is not an outage. The
Postgres limiter fails **open** as well, for the same reason. The
in-process limiter is bounded by a table of 10 000 keys. A key leaves the
table when its window is over, never because another key needed its place:
a limiter that evicts a live window hands the evicted caller a fresh
budget, so a caller that sprays addresses resets its own counter at will.
When the table is full, the requests that do not fit are counted in one
shared window, so the flood is bounded by the same limit.

---

## 10. The websockets

A route must set `websocket: true`; otherwise an upgrade → `400
websocket_not_allowed`.

The gateway performs its own handshake with the upstream (with the identity
headers and the signature) **before** it answers the client, so the client
learns the outcome and the subprotocol the upstream selected. The handshake
headers of the client are not forwarded.

**The handshake follows the header policy of §7.1.** It is a request to the
upstream: the cookies of the gateway never reach it, the identity of the
caller is written by the gateway, and the `Authorization` header of the
caller is forwarded only when the route says so (`forwardAuthorization`).

**The origin of the handshake.** A handshake is a `GET`, so the guard of §8
lets it through. A WebSocket is not a `GET` though: it opens a
bidirectional connection that stays open, and the page of another site could
use it to talk to the gateway. A browser always sends the origin of the
page in a handshake, so **a handshake that carries the session cookie of
the gateway has to name an allowed origin**.

- A handshake with a foreign origin → `403 cross_site_request`.
- A handshake without an origin → `403 cross_site_request`.
- A handshake of a client that does not use the session cookie (an API
  client with a bearer token) is not a browser and is not asked for an
  origin.

The check runs before the connection to the upstream is opened, and it is
**not** relaxed by `SHUTTLE_CSRF_STRICT`.

**The revalidation of an open connection.** A connection is authorized when
it is opened. A connection that stays open for hours was authorized hours
ago: the session it was opened with may have expired, the access it was
opened with may have been revoked, and the route it was opened on may have
changed.

Every `SHUTTLE_WS_REVALIDATE_INTERVAL_MS` (60 s) the gateway checks three
things, and closes the connection with the code `1008` (policy violation)
when one of them fails:

1. the **route** still exists and still accepts WebSockets;
2. the **session** still exists, when the connection was opened with one;
3. the **access service** still allows the workspace, asked again and not
   from the cache. A route that names no workspace and asks the access
   service about itself is asked again as well, and the decision it
   answers is never stale (§6.2).

A revalidation that cannot be made closes the connection: a connection the
gateway cannot vouch for is a connection it must not keep. A value of `0`
disables the revalidation.

**The guards.** At most `SHUTTLE_WS_MAX_CONNECTIONS` open connections (`503
too_many_connections`). A message larger than `SHUTTLE_WS_MAX_PAYLOAD_BYTES`
is refused. The outbound buffer is bounded
(`SHUTTLE_WS_MAX_BUFFERED_BYTES` and `_MESSAGES`). A client that does not
read closes the connection at `SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES`. The
keepalive pings every `SHUTTLE_WS_PING_INTERVAL_MS` and closes a connection
that did not answer within `SHUTTLE_WS_PONG_TIMEOUT_MS` or that was idle
for `SHUTTLE_WS_IDLE_TIMEOUT_SECONDS`. The handshake of the upstream has
`SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS`.

---

## 11. The proxying

### 11.1 The url of the upstream

The upstream url is built from the base url of the route and the request:
1. The **base path** of the upstream is taken, its trailing slashes removed.
2. The **path of the request** is appended (it always starts with `/`).
3. The **query string of the request** is used. The query string of the
   upstream itself is not used (§3.1).
4. The **fragment** is never forwarded.

```
upstream http://app:3000        + /ws/123?x=1  →  http://app:3000/ws/123?x=1
upstream http://app:3000/base/  + /ws/123?x=1  →  http://app:3000/base/ws/123?x=1
upstream http://app:3000/base   + /ws/123      →  http://app:3000/base/ws/123
```

The path is forwarded unchanged: the prefix that matched the route is not
stripped, and the path is not rewritten — unless the route declares a
**rewrite**.

### 11.1.1 The rewrite of the path

A route may declare the path its upstream receives:

```jsonc
{
  "id": "workspace-api",
  "match": { "host": "api.example.com", "path": "/ws/{workspaceId}/" },
  "upstream": "http://upstream:3000",
  "rewrite": "/v1/workspaces/{workspaceId}/{rest}"
}
```

| The rewrite | The path the upstream receives |
| --- | --- |
| — | The path of the request: `/ws/123/assets`. |
| `/{rest}` | `/assets`: the prefix of the route is removed. |
| `/v1/workspaces/{workspaceId}/{rest}` | `/v1/workspaces/123/assets`. |
| `/v1/fixed` | `/v1/fixed`: the rest of the path is **not** forwarded. |

The rules:

- a placeholder of the rewrite is a placeholder of the **path of the
  route**: a rewrite that names one the path does not have is a
  configuration error;
- `{rest}` is the part of the path that follows the prefix the route
  matched, and it may only be the last segment of the rewrite;
- a rewrite **without** `{rest}` does not forward the rest of the path;
- the values are the ones the caller sent: the encoding of the path is not
  touched, so a value that carries an encoded character reaches the
  upstream as it was sent;
- the query string is not part of the rewrite and it is forwarded unchanged;
- the signature of the identity covers the path **as the upstream receives
  it** (§7.4), so a rewritten path is covered by the signature.

The WebSocket url is built the same way, with `http` → `ws` and `https` →
`wss`. An upstream of a websocket is served over plain http: a `wss`
upstream is refused (§11.1.2).

### 11.4 The upstreams of a route

A route may name one upstream or several:

```jsonc
{
  "id": "workspace-api",
  "upstream": ["http://upstream-a:3000", "http://upstream-b:3000"]
}
```

The upstreams are tried in the order of the list. The next one is tried
when the **connection** to the first one fails, and only when the request
may be sent again:

| The request | It is tried again |
| --- | --- |
| `GET`, `HEAD`, `OPTIONS`, `TRACE`, `PUT` or `DELETE` without a body | Yes. |
| Any other method | No: it may change the state of an upstream. The body is streamed and the request is sent to one upstream. |
| A request with a body that is too large to be held in memory | No: the bytes are already on their way to the first upstream. |
| A request with a body that fits in `replayMaxBytes` | Yes: the body is held in memory and sent again. |

The budget of the answer is the budget of the **whole** exchange: the
upstreams that are tried share it, so a list of upstreams does not make
the timeout of a route longer.

**The budget of an attempt.** An attempt that has another upstream behind
it is abandoned when it does not answer within `upstreamAttemptMs`
(`SHUTTLE_UPSTREAM_ATTEMPT_TIMEOUT_MS`, 2 s by default), and the next
upstream is tried. Without it, an upstream that accepts the connection and
never answers eats the whole budget of the route, and the upstreams behind
it are never reached.

The budget of an attempt applies only to a request that may be sent again:
a request that changes the state of an upstream is never sent to two of
them, whatever the budget says. The last upstream of the list has no
successor: the budget of the answer governs it.

**The body that may be sent again.** A body is held in memory when it
announced a length that fits in `replayMaxBytes`
(`SHUTTLE_REPLAY_MAX_BYTES`, 64 KiB by default), so that it may be sent to
a second upstream. A body that does not fit is streamed and the request is
sent once.

The body of a request that may **not** be sent again is never held in
memory, whatever its size: it would be held for nothing, and the upstream
would only be reached once the whole body arrived, which loses the early
answer of the upstream (§11.2). A `POST` of a route that names several
upstreams is therefore streamed like the `POST` of a route that names one.

**The health of the upstreams.** The failover above only reaches the second
upstream when the request may be sent again, so the traffic that matters
most — the `POST` of an API — had no failover at all: when the first
upstream accepted the connection and never answered, the request burned the
whole budget of the route and the second upstream was never reached.

The gateway therefore remembers the upstreams that failed recently and it
**moves them to the end of the list**, so that the next request of the
route goes to an upstream that answered recently. The rules are:

- the breaker is **passive**: it learns from the failures the gateway
  observes — a connection that was refused, an attempt that ran out of its
  budget — and it never probes an upstream. A probe would be a request of
  its own, and the deployment would have to decide what a healthy upstream
  is;
- the upstreams that are not skipped come first, in the order of the list,
  and the skipped ones come after them, also in the order of the list. The
  order of the file is the order of the upstreams;
- an upstream is skipped after `SHUTTLE_UPSTREAM_BREAKER_FAILURES`
  consecutive failures (3 by default) and for
  `SHUTTLE_UPSTREAM_BREAKER_COOLDOWN_MS` milliseconds (30 s by default). It
  is never removed: it is tried again when the cooldown is over, even when
  it failed in the meantime;
- `SHUTTLE_UPSTREAM_BREAKER_FAILURES=0` disables the breaker: the order of
  the list is then always the order of the file;
- the state is **per process**. Every replica learns on its own, from the
  traffic it handles: a replica that did not see the failure sends its next
  requests to the upstream that is down, and pays the budget of the route,
  the way it paid it before the breaker existed;
- a request is still sent to **one** upstream: the breaker chooses which
  one, it never sends the request twice.

The failures are published in `shuttle_upstream_failures_total` and the
requests that were sent to another upstream are published in
`shuttle_upstreams_skipped_total`.

The body is only held in memory when the route names **several** upstreams:
a route with one upstream has nothing to fail over to, and its body is
streamed, so the upstream is reached while the caller uploads and the early
answer of the upstream is preserved (§11.2).

The memory of the gateway is bounded by the limit and by the number of
exchanges that run at the same time: `SHUTTLE_MAX_CONCURRENT_REQUESTS` ×
`SHUTTLE_REPLAY_MAX_BYTES` in the worst case.

The handshake of a websocket goes to the **first** upstream of the route: a
handshake is not a request that may be sent twice.

### 11.1.2 The TLS of the connections to the upstreams

An upstream that is served over `https` is reached over TLS. The gateway
verifies the certificate of the upstream with the authority of the
deployment (`SHUTTLE_UPSTREAM_TLS_CA`) and presents the certificate of the
deployment (`SHUTTLE_UPSTREAM_TLS_CERT` and `SHUTTLE_UPSTREAM_TLS_KEY`)
when the upstream asks for one. The certificate and its key belong
together: a deployment that sets one without the other is refused at the
start.

The upstream that does not accept the certificate refuses the connection:
the gateway answers `502 bad_gateway` and the reason is in the log.

**An upstream of a websocket is served over plain http.** The websocket
client of the runtime cannot speak TLS (the measurements are in
[runtime.md](runtime.md)), so a handshake with an upstream over `wss` is
refused with the reason `tls` instead of failing with an error that hides
the cause. The way out is a proxy in front of the upstream that speaks
`wss` and forwards `ws`.

### 11.2 The phases and their budgets

Bodies are streamed in both directions, so server sent events and large
uploads work. Every phase has its own budget, merged field by field from
`defaults.timeouts` and the `timeouts` of the route:

| Phase | Budget | Default | Covers | Kind |
| --- | --- | --- | --- | --- |
| upload | `bodyMs` | 300 000 | The time between two chunks of the request body. | **idle** |
| response | `responseMs` | 5 000 | Everything between the end of the upload and the response headers. | **total** |
| first byte | `firstByteMs` | 30 000 | The time between the response headers and the first byte of the body. | **total** |
| body | `bodyMs` | 300 000 | The time between two chunks of the response body. | **idle** |

An **idle** budget is rearmed on every chunk: a client that uploads slowly
or an upstream that streams server sent events for hours is not cut off as
long as it keeps making progress.

**The upload is not part of the answer budget.** The `responseMs` budget
starts when the request has been sent completely, so a slow upload is never
defeated by a short answer budget. The same holds for `firstByteMs`: it
starts when the response headers arrived.

**An answer that cannot have a body has no first byte.** The `firstByteMs`
budget is not armed for the answer of a `HEAD` request, nor for the answers
of the statuses of a **final** response that carry no body (`204`, `205`,
`304`).

Two statuses are not in that list:

- **`103 Early Hints` is an interim response.** The gateway waits for the
  final response and forwards only that one. If the upstream closes without
  final headers, the exchange fails with `502 bad_gateway`.
- **`101 Switching Protocols` is a protocol switch.** It belongs to the
  WebSocket upgrade. The HTTP path refuses it (`502`).

The limit of the body is `route.maxBodyBytes` → `defaults.maxBodyBytes` →
`SHUTTLE_MAX_BODY_BYTES`; `0` disables it. A body over the limit → `413
payload_too_large`, both when the limit is already exceeded by
`content-length` and when it is discovered while the body streams.

**The number of exchanges that run at the same time** is bounded by
`SHUTTLE_MAX_CONCURRENT_REQUESTS` (1 000; `0` disables it). A client that
opens a request and never sends its body holds a connection until the idle
budget of the upload runs out, so the cap is the bound of that. An exchange
that does not fit → `503 gateway_overloaded`.

### 11.3 The failures and what the caller sees

**Before the response headers are sent**, the gateway can still answer with
an error of its own:

| Failure | Status | Body |
| --- | --- | --- |
| The upstream did not answer in time (`responseMs`) | `504 gateway_timeout` | JSON |
| The request body is over the limit, and the upstream had not answered yet | `413 payload_too_large` | JSON |
| The caller went away | `499` | empty |
| The upstream could not be reached | `502 bad_gateway` | JSON |
| Too many exchanges at the same time | `503 gateway_overloaded` | JSON |

**After the response headers are sent**, the status line is fixed. A
failure that is discovered while the body streams **ends the response
body**: the client sees a truncated stream and a closed connection. This
includes the `firstByteMs` budget: the response headers were already
received, so a timeout before the first byte ends the stream rather than
producing a `504`.

**An upstream may answer before it read the whole request.** The gateway
does not assume that an unfinished upload means that nothing was sent:

- If the limit of the body is reached **before** the answer of the upstream
  arrives, the gateway aborts the exchange and answers `413`.
- If the answer of the upstream arrived **first**, that answer is what the
  caller gets. The rest of the upload is dropped and the body of the answer
  may be truncated.

The status that is recorded is the status of the upstream, because that is
what the client received. The outcome is recorded separately as `aborted`.
The upstream request is cancelled when the caller disconnects, so a client
that goes away does not leave the upstream working.

---

## 12. The operations

### 12.1 The health, the readiness and the metrics

- `GET /healthz` → `200 {"status":"ok",…}`. Always available.
- `GET /readyz` → `200` when a configuration is loaded and the session store
  answers, `503` otherwise. The body reports both.
- `GET /metrics` → `200` in the Prometheus text format when the bearer
  token matches, `404` when `SHUTTLE_METRICS_TOKEN` is unset, `401` when
  the token does not match.

The metrics:

| Metric | Labels | What it says |
| --- | --- | --- |
| `shuttle_requests_total` | `route`, `method`, `status` | Every request the gateway answered, the refusals included. |
| `shuttle_request_errors_total` | `route` | The answers with a status of 5xx. |
| `shuttle_auth_failures_total` | `route`, `reason` | The callers that were rejected. |
| `shuttle_access_unavailable_total` | `route` | The requests that were refused because the access service could not be reached. |
| `shuttle_access_stale_total` | `route` | The decisions that were served while the access service was unreachable (§6.2). |
| `shuttle_access_stale_age_seconds` | `route` | The age of the decisions that were served while the access service was unreachable. |
| `shuttle_cross_site_refusals_total` | `route` | The requests that came from another site. |
| `shuttle_websocket_connections_total` | `route` | The accepted upgrades. |
| `shuttle_websocket_refusals_total` | `reason` | The refused handshakes. |
| `shuttle_request_duration_seconds` | `route` | The latency of the exchanges. |
| `shuttle_upstream_duration_seconds` | `route` | The latency of the upstreams: the time from the request that left the gateway to the final headers of the answer. |
| `shuttle_upstream_failures_total` | — | The failures of the upstreams: a connection that was refused, an attempt that ran out of time. |
| `shuttle_upstreams_skipped_total` | — | The times an upstream was moved to the end of the list because it failed recently (§11.4). |
| `shuttle_access_duration_seconds` | `route` | The latency of the calls to the access service. Only the calls that reached the service are counted: a decision that came from the cache cost nothing. |
| `shuttle_bytes_in_total`, `shuttle_bytes_out_total` | — | The bytes that really went through. |
| `shuttle_active_requests` | — | The requests that are in flight. |
| `shuttle_config_reloads_total` | `result` | The reloads of the configuration. |
| `shuttle_rate_limited_total` | — | The requests the limiter refused. |
| `shuttle_shared_state_errors_total` | — | The times the shared state was not reachable. |

**The labels are bounded**, so the number of series cannot grow without
limit:

- `route` is the id of the route, `unmatched` for the requests that
  matched no route, or `overflow` when there are more than 500 routes.
- `method` is the upper-cased method, or `other` for a method that is not
  tracked. The tracked ones are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE`, `OPTIONS`, `TRACE`, `PROPFIND`, `PROPPATCH`, `MKCOL`, `COPY`,
  `MOVE`, `LOCK`, `UNLOCK`, `REPORT` and `SEARCH`. A client chooses the
  method, so it cannot create a series per method.
- `status` is the status, or `other` for a status that is not tracked. The
  tracked ones are the statuses of the specification of HTTP, the ones the
  gateway generates itself (`499`, `503`) and the two that an operator looks
  for. An upstream chooses the status, so it cannot create a series per
  status.

### 12.2 The logs

JSON (pino). `Authorization`, `Cookie`, `Set-Cookie`, `x-api-key` and the
query parameters `access_token`, `code`, `code_verifier`, `id_token`,
`refresh_token` (and the like) are redacted before anything is written.
Every request or connection log line carries its request id.

The credentials of a url are removed as well: an upstream that is named
with a password in its url does not put that password in the log.

**The policy that is running.** The gateway writes the policy it is running
once per generation of the configuration: one line for the configuration,
one line for every route (the host, the path, the methods, the upstreams,
the credential it accepts, the workspace it asks about, the policy of the
cross site requests, whether the credential of the caller reaches the
upstream, the budgets) and one **warning** for every setting that is
permissive:

| The warning | What it means |
| --- | --- |
| `unauthenticated_route` | The route forwards a caller that was not authenticated. |
| `no_workspace_check` | The route authenticates the caller and never asks the access service. |
| `authorization_forwarded` | The credential of the caller reaches the upstream of the route. |
| `cross_site_allowed` | The route accepts a navigation from another site while it accepts a session. |
| `unbounded_body` | The route accepts a body of any size. |
| `limited_failover` | The route names several upstreams, and the failover is limited to the requests that may be sent twice. |

The warnings are not errors and a deployment may want them. They are
settings that look active but that nobody may have read, and a warning that
says so is worth more than a silent default.

### 12.3 The reload and the readiness

The configuration file is watched. A reload is atomic: the new file is
parsed, validated and checked for ambiguity **before** it replaces the
running one.

**A failed reload does not make the gateway unready.** The last valid
configuration stays active and the gateway keeps serving it. The failure is
reported in the body of `/readyz` (`config.lastError`), in the log and in
`shuttle_config_reloads_total{result="failed"}`.

`/readyz` answers `503` only when no configuration has ever been loaded or
when the session store cannot be reached.

### 12.4 The shutdown

On `SIGTERM` or `SIGINT` the listener stops accepting, the readiness probe
answers `503` with the body `draining`, the open connections are drained
for `SHUTTLE_SHUTDOWN_TIMEOUT_MS` (15 s) and then the process exits. The
WebSocket connections are closed with the code 1001 and the exchanges that
are running are cancelled when the deadline is reached.

### 12.5 The shared state

The sessions, the limits and the cached decisions live in a server that the
replicas share: a Redis server or a Postgres server. The scheme of the url
picks the backend, and the two hold the same three things.

**The Redis client** is the one of the `redis` package: the shared state is
not tied to the runtime of the gateway, and one implementation covers every
managed cache. **The Postgres client** is the one of the `pg` package, with
a bounded pool of connections.

**The queue of the commands is disabled.** A command that is sent before
the connection is established fails right away instead of waiting in a
queue that nobody drains. The gateway denies the caller when the store is
down, it does not pile up requests. The commands that failed because the
connection was not established are retried a few times.

**The connection is established in the background.** A gateway that starts
while the shared state is down stays up: it answers `503` to the readiness
probe, it denies the callers that need a session, and it becomes ready
when the server answers. The failure is reported once per outage, and the
recovery is reported in the log.

**The client is closed at the end of the drain**, and the wait is bounded:
a client that is still trying to reach a server that is not there does not
keep the gateway waiting for a reply that will never come.

#### 12.5.1 The atomicity of the shared state

The three operations of the shared state have to be **one** operation of the
server, because two replicas that count the same request at the same time
must not count it twice:

| Operation | Redis | Postgres |
| --- | --- | --- |
| Read a session and refresh its expiry | the `TOUCH_SCRIPT` | the function `shuttle.session_touch` |
| Count a request in the window of a caller | the `WINDOW_SCRIPT` | the function `shuttle.rate_limit_check` |
| Read or write a cached decision | one command | one command |

A function call of Postgres is a transaction of the server, so it is the
equivalent of a script of Redis. The counters of the replicas are exact:
the checks of one key are serialized with an advisory lock, and the
function that counts a request refuses to count it twice.

The expiry of a row of Postgres is a column, not a key that disappears: the
rows that are over are removed by a sweep, and the server never serves
them whatever the sweep did.

**The server does not wait for the disk** (`SHUTTLE_POSTGRES_SYNCHRONOUS_COMMIT=off`,
the default): the state of the shared state is a protection and not a
ledger, and the guarantee is the one a Redis server gives without its
append only file.

---

### 12.6 The comparison of the backends

The two backends are interchangeable and the gateway measures them side by
side. The measurements are in [capacity.md](capacity.md).

| | Redis | Postgres |
| --- | --- | --- |
| The cost of the shared state | about a tenth of the throughput of the baseline on the path of the limiter, about a third on the path of the whole request | about half of the throughput of the baseline on both paths, with a p50 about twice the one of Redis |
| The concurrency | the server serializes the commands of a key | the transactions of a key are serialized by an advisory lock |
| The connections | one per replica | a bounded pool per replica: the server has a low limit |
| The failure | the limiter fails open, the sessions fail closed | the same |

A deployment that runs on a managed Redis pays less latency and operates
less. A deployment that runs on a database it already has pays one more
service to operate and one more connection to plan.

---

## 13. What Shuttle does not do

Shuttle does not:

- terminate TLS (a proxy in front of it does);
- decide access on its own, or check roles;
- rewrite the path of the request in any way but the one of §11.1.1 (a
  route declares the path its upstream receives, and the gateway does not
  rewrite the body, the query string or the headers);
- buffer or cache responses;
- aggregate WebSockets;
- probe the health of an upstream: the upstreams of a route are tried in
  the order of the list, and the breaker of §11.4 only learns from the
  failures the gateway observes;
- send a request to a second upstream when it may change the state of the
  first one (§11.4).

---

## 14. The organization of the code

### 14.1 The domains

| Path | Owns |
| --- | --- |
| `src/domains/routing/` | The identity of a route, the host and path matching, the parameters, the precedence and the ambiguity detection. |
| `src/domains/configuration/` | The schema of the file, the strict validation, the effective defaults, the immutable compiled snapshots and the atomic last-good publication. |
| `src/domains/authentication/` | The principal, the policy of the modes, the selection of the credential, the OIDC and JWKS, the browser login and logout, the signed state, the sessions, the expiry and the cookies. |
| `src/domains/workspace-access/` | The validation of the workspace, the requests and the decisions of the access service, the cache keys, the TTL and the cache adapters. |
| `src/domains/forwarding/` | The peer and proxy trust, the cross-site policy, the filtering of the headers and the cookies, the target url, the sanitized identity and the signature. |
| `src/domains/rate-limiting/` | The sliding windows, the scopes, the `retry-after`, the bounded memory and the counters of the shared state. |
| `src/domains/proxying/` | The state of the exchange, the limits of the body, the phase and idle budgets, the cancellation, the commitment outcomes and the registry of the active exchanges. |
| `src/domains/websockets/` | The reservations of the slots, the handshake with the upstream first, the state of the bridge, the buffers, the keepalive, the revalidation and the registry of the pairs. |

### 14.2 The layers

| Path | Owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. It starts the runtime and nothing else. |
| `src/app/` | The Hono application: the thin handlers, the middleware, the order of the pipeline and the mapping of the failures to the answers of the protocol. |
| `src/platform/bun/` | The listener, the actual peer address, the outbound HTTP transport, the upgrade and the socket primitives. |
| `src/platform/redis/` | The construction, the TLS settings and the disposal of the shared Redis clients. |
| `src/platform/postgres/` | The construction, the pool, the TLS settings, the schema and the disposal of the shared Postgres clients. |
| `src/runtime/` | The environment, the composition root, the file watcher, the signals and the drain. |
| `src/observability/` | The logging, the metrics and the observation handles. It knows nothing else. |
| `services/` | The deterministic fixtures of the identity provider, of the access service and of the upstreams. |
| `test/` | The checks that are not the unit tests of a domain. |

### 14.3 The dependency rules

1. A domain exposes a deliberate `index.ts`. The consumers import that
   entry point, never an internal file. The concrete adapters expose a
   separate `adapters/index.ts` for the runtime.
2. Routing, authentication and rate limiting depend on no other domain.
   Configuration may use the public schemas of routing and authentication.
   Workspace access may use the principal of authentication and the
   identifier types of routing. Forwarding may use the principal type of
   authentication. Proxying and the websockets may use the plans of
   forwarding. The application orchestrates the combinations; the domains
   do not import it.
3. The core code of a domain imports no framework, no Bun API, no
   concrete adapter, no application, no platform and no runtime. It
   receives its dependencies through injected ports. All the production
   reads of the environment happen in the runtime.
4. The application uses the public entry points of the domains and the
   observation interfaces, never a concrete adapter. The platform
   implements the public ports of the domains without making a policy
   decision. The runtime is the composition root. The observation layer
   imports nothing of the project.
5. There are no catch-all directories (`utils`, `services`, `repositories`,
   `common`, …) and no import cycle, type-only imports included.
6. The framework of the application (Hono) is only used by the application,
   and the API of the runtime (the listener, the sockets, the client of the
   shared state) is only used by the platform.

The rules are checked by `scripts/architecture.ts`, which runs in the test
suite and in the CI workflow.

### 14.4 The ownership of the resources

The runtime constructs and closes the shared clients, the watchers and the
process timers. The configuration owns the last-good immutable generation.
Each request captures one generation for all its policy and forwarding
decisions. The HTTP exchange owns its streams, its phase timers and its
cancellation. A WebSocket pair owns both its legs, its buffers, its
keepalive timers and its slot.

A single owner finalizes each exchange and each connection exactly once.
The completion of a middleware is not the completion of an exchange.

---

## 15. The decision log

The decisions that shape the contract. The decisions of the release, with
the evidence that proves them, are in [decisions.md](decisions.md); the two
lists are numbered independently.

| # | Question | Decision |
| --- | --- | --- |
| 1 | A session cookie **and** a bearer token in the same request | The bearer token authenticates the request, but the request is guarded by the cross-site rules, because the cookie was attached by the browser (§5.1, §8). |
| 2 | Cross-site requests refused, cross-site navigations allowed | They are different things. The state-changing requests from another site are refused; the safe navigations are allowed unless `SHUTTLE_CSRF_STRICT` is set. `/auth/logout` is refused from another site whatever its method (§8). |
| 3 | The order of the pipeline | The endpoints of the gateway are matched before the dispatcher. In the dispatcher the route is matched **before** the limiters, and a request that matches no route is counted by the limiters and then refused (§2.3). |
| 4 | An upstream url with a base path | The base path of the upstream is prefixed to the path of the request; the query string of the request replaces the one of the upstream; fragments are dropped; an upstream that carries a query or a fragment is rejected at load time (§3.1, §11.1). |
| 5 | A failure while the body streams | The status line is already sent: the body stream ends, the client sees a truncated answer, the outcome is recorded as `aborted`. No JSON error is invented for a response that already started (§11.3). |
| 6 | The meaning of `bodyMs` | An **idle** budget, rearmed on every chunk. `responseMs` and `firstByteMs` are total budgets of their phase. The upload is governed by the idle `bodyMs` budget and is not part of `responseMs` (§11.2). |
| 7 | The names of the budgets | `connectMs` → `responseMs` (the answer of the upstream), `headersMs` → `firstByteMs` (the first byte of its body). The old names described something else than they did and are refused by the configuration (§11.2). |
| 8 | An upstream that answers before the upload is over | The answer of the upstream wins: the status line was already sent. The `413` is only for a failure that is discovered before the answer arrives (§11.3). |
| 9 | The origin of a WebSocket handshake | A handshake that carries the session cookie has to name an allowed origin; one without an origin is refused. The check is not relaxed by `SHUTTLE_CSRF_STRICT` and happens before the upstream is contacted (§8, §10). |
| 10 | The cookie of the browser | It follows the session: every request that is authenticated by a session refreshes it, with a `Max-Age` of the smaller of the idle lifetime that is left and the maximum age that is left (§5.3). |
| 11 | The request identifier | A middleware around the gateway endpoints and the dispatcher: the `x-request-id` of the request is reused when it is valid, a UUID is generated otherwise, and the answer carries it (§2.1). |
| 12 | A maximum age of `0` | Unlimited: the cap does not exist (§5.3). |
| 13 | An answer without a body | The `firstByteMs` budget is not armed for a `HEAD` request nor for the statuses of a final response that carry no body (§11.2). |
| 14 | `103` and `101` | `103` is interim: the gateway waits for the final response and forwards it. `101` is a protocol switch: it belongs to the WebSocket upgrade, and the HTTP path refuses it (§11.2). |
| 15 | The validation of an OIDC token | The nonce, the state, the PKCE verifier and the id token are required in the browser flow; the state is single use; the cookie attributes are fixed (§5.2, §5.4, §5.5). |
| 16 | The maximum lifetime of a session | The idle lifetime and a maximum age counted from the creation, whatever the activity. The maximum age is the real bound (§5.3). |
| 17 | The secret of the identity signature | `SHUTTLE_SESSION_SECRET`, from which the key is derived; unset means a random per-process secret, which is refused in production (§7.4). |
| 18 | The readiness after a failed reload | The gateway stays ready and keeps the last valid configuration; the failure is visible in `/readyz`, in the log and in the metrics (§12.3). |
| 19 | The organization of the code | The policy, the use cases, the ports and the adapters live together; the app, the platform and the runtime are explicit boundaries. The public imports and the dependency directions are checked in CI (§14). |
| 20 | The version of the runtime | The runtime is **Bun ≥ 1.4.3**. The boundaries the gateway relies on are not observable on the 1.2 line. The gateway **refuses to start** on an older runtime. The measurements are in [runtime.md](runtime.md). |
| 21 | The forwarding headers of a client | The standard `forwarded` header is removed in both directions. The `Authorization` header of the caller is forwarded to the upstream as it is, unless the route says otherwise (§7.1). |
| 22 | The host of a request | The effective host is the `x-forwarded-host` of a trusted proxy, and the `Host` header otherwise. It decides the route, the origin and the signature (§7.3). |
| 23 | The limits | Four scopes: the deployment, the caller over all the routes, the caller on one route and the authenticated caller on one route. A scope keyed by an address cannot bound a flood that spreads over many addresses, and it cannot tell two tenants behind the same address apart (§9). |
| 24 | The metrics of the requests | Every answer of the gateway is counted, the refusals included. The labels are bounded: `unmatched` for the requests that matched no route, `other` for a method or a status that is not tracked (§12.1). |
| 25 | The revalidation of a WebSocket | An open connection is revalidated: the route, the session and the access are checked again, and the connection is closed with `1008` when one of them fails (§10). |
| 26 | The number of exchanges at the same time | The exchanges are bounded by `SHUTTLE_MAX_CONCURRENT_REQUESTS`, so a client that opens a request and never sends its body cannot hold the resources of the process (§11.2). |
| 27 | The state of a deployment | The state of a production deployment is shared: `SHUTTLE_SESSION_URL` and `SHUTTLE_SHARED_STATE_URL` must name a Redis server or a Postgres server, or `SHUTTLE_ALLOW_MEMORY_STATE=true` says explicitly that the deployment is a single node that accepts the in-process state (§4). |
| 28 | The policy of the cross site requests | It is a property of the route: `crossSite` refuses the navigations from another site on the routes that declare it, and the policy of the deployment applies to the others (§8). |
| 29 | The `Authorization` header of the caller | It is forwarded to the upstream by default, and a route that does not need it says so with `forwardAuthorization: false` (§7.1). |
| 30 | The latency of a revocation | It is a property of the route: `accessCacheTtlMs` is the lifetime of the cached decisions of that route, and `0` makes the revocation on it immediate (§6). |
| 31 | The handshake of a websocket | It follows the header policy of the http path: the cookies of the gateway never reach an upstream (§7.1, §10). |
| 32 | The TLS of the connections to the upstreams | The gateway verifies the certificate of the upstream with the authority of the deployment and presents the certificate of the deployment when the upstream asks for one (§11.1.2). The upstream of a websocket is served over plain http: the websocket client of the runtime cannot speak TLS. |
| 33 | The backend of the shared state | The sessions, the limits and the cached decisions live in a Redis server or in a Postgres server: the scheme of the url picks one of them, and the two hold the same three things with the same contract (§4, §12.5, §12.6). |
| 34 | The protocol of the access service | It is published: the request, the answer and the statuses are in §6.1, and a conformance suite checks an implementation against it. A reference implementation ships with the project (§6.1). |
| 35 | The policy that is running | The gateway writes the policy it is running in its log, once per generation, and it names the settings that are permissive (§12.2). |
| 36 | The budget of an attempt to an upstream | An attempt that has another upstream behind it is abandoned after `upstreamAttemptMs`, and the next upstream is tried. The budget of the answer still bounds the whole exchange (§11.4). |
| 37 | The body that may be sent again | A body that fits in `replayMaxBytes` is held in memory, so that the request may be sent to a second upstream. A request that changes the state of an upstream is never sent twice (§11.4). |
| 38 | The methods of a route | A route may name the methods it accepts. A route that names the method of the request wins over one that names none, and the one that names none is the fallback of the others (§3.3). |
| 39 | The grace of an outage of the access service | It is off by default, and a decision that is served while the service is down is served only when it allows the caller. A denial that is served instead of the outage would hide the outage from the operator (§6.2). |
| 40 | A route that names no workspace | The access service is asked about it only when the route asks for it with `accessCheck`. A deployment without workspaces is served by the same protocol, and the workspace of the request is then absent (§6.3). |
| 41 | The body of a request that is never sent again | It is not held in memory: it would be held for nothing, and the upstream would only be reached once the whole body arrived (§11.4). |
| 42 | The compatibility of the release | The contracts of §16.1 are extended by a `MINOR` release and changed by a `MAJOR` one. A `0.x` release extends them, and the changelog of the release says what changed (§16). |

---

## 16. The compatibility of the release

Shuttle is a dependency of a deployment: the gateway is in the path of every
request of the applications behind it, and the deployments write their own
access service and their own upstreams against it. The contracts that
those two depend on are therefore **versioned promises**, and this section
says which promise holds for which release.

### 16.1 What is a contract

| The contract | Where it is written |
| --- | --- |
| The behavior of the gateway | This document. |
| The protocol of the access service | §6.1, with its conformance suite. |
| The format of the signature of the identity | §7.4, with the guide of [upstream-identity.md](upstream-identity.md). |
| The format of the route table | §3. |
| The names of the variables of the environment | §4 and [.env.example](../.env.example). |
| The names of the metrics | §12.1. |

Everything else is an implementation detail: the organization of the code
(§14), the names of the internal functions, the libraries, the wording of
the logs and the wording of the answers. A deployment that depends on them
is not supported.

### 16.2 The promise of a release

The version of the release is `MAJOR.MINOR.PATCH`, and the release before
`1.0` is a `0.x`:

- **PATCH**: a fix. The behavior of the contracts does not change.
- **MINOR**: a feature. The contracts are **extended**, never changed: a
  field of the route table is added, a variable of the environment is
  added, a metric is added, a status of the protocol is added. A
  deployment that was written against the previous release keeps working
  without a change.
- **MAJOR**: a change. The contracts may change, and the changes are
  listed in the changelog of the release with the migration of each of
  them. The first `1.0` is the release that fixes the contracts of
  `0.x`: after it, a `MINOR` release never changes one.

The rules that hold in every `0.x` release, and that are kept after the
`1.0`:

1. **The route table is extended, never changed.** A field is added, and
   it has a default. A field that is removed or that changes its meaning
   is a `MAJOR` change. An unknown field is a configuration error, and it
   stays one: a setting that looks active but is not is a security hole
   (§3.1).
2. **The protocol of the access service is extended, never changed.** The
   fields of the request are added, and the answers of the service keep
   their meaning. A field that is removed is a `MAJOR` change, and the
   changelog says how a service migrates.
3. **The format of the signature of the identity is versioned.** The
   version is part of the value (`v4=…`, `v5=…`) and part of the payload,
   so an upstream that knows the version refuses the signature of another
   one instead of misreading it. A new format gets a new version: the
   previous one keeps working until the changelog says that it does not
   (§7.4).
4. **The names of the variables of the environment do not change their
   meaning.** A variable that is renamed keeps its old name until the
   changelog says that it is gone, and the old name warns in the log for a
   release before it disappears.
5. **The metrics are added, never renamed.** A metric that is removed
   keeps its name for a release that announces its replacement, and the
   replacement carries the same labels.
6. **The answers of the gateway keep their status and their shape.** A
   status is added, and it is a status the client did not know: the
   clients that check for the statuses they know keep working. The body of
   an answer keeps the field that carries the error.

### 16.3 The deprecations

A deprecation is announced in the changelog, warned about in the log of the
gateway, and removed in a release that is named in the announcement. The
table is the one of this release:

| What | Deprecated in | Removed in | The way out |
| --- | --- | --- | --- |
| The symmetric format of the signature of the identity (`v4`) | 0.4.0 | the first release that is not a `0.x` | Set `SHUTTLE_IDENTITY_SIGNING_KEY` and give the public key to the upstreams (§7.4). |

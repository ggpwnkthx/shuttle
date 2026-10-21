# Shuttle — Specification

Shuttle is an application gateway. It authenticates a caller against an
OpenID Connect provider, asks an access service whether the caller may use a
workspace, and forwards the request to a single configured upstream.

This document is normative for product behavior and source organization.
[architecture.md](architecture.md) describes how the code is laid out and
which file owns what; [decisions.md](decisions.md) records the decisions
behind the contract. Recommendations in an implementation guide do not
become requirements until they are recorded here.

Status: 0.2.0. Runtime: Bun ≥ 1.4.3 (§15, decision 20). Listener: HTTP and
WebSocket on `SHUTTLE_GATEWAY_HOST:SHUTTLE_GATEWAY_PORT` (default
`0.0.0.0:8080`).

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **caller** | The client of the gateway: a browser or an API client. |
| **principal** | The authenticated caller: `subject`, optional `email`, `roles`, and the `source` of the credential (`session` or `jwt`). |
| **route** | A host and path match with exactly one upstream and one policy. |
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
    `requireUuid` is set, and the access service is asked (§6). Denial →
    `403 workspace_forbidden`.
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
| `trustedProxies` | The ranges whose forwarding headers are honoured (§7.3). The ranges of the environment are added to them. |
| `reservedPaths` | The paths the gateway keeps for itself, on top of §2.2. |
| `routes` | At least one route. |

A route:

| Field | Rule |
| --- | --- |
| `id` | Lowercase kebab-case, at most 63 characters, unique. |
| `match.host` | `example.com`, `*.example.com` (the subdomains, not the domain itself), or `*` for any host. |
| `match.path` | A list of segments. A segment is a literal or a `{placeholder}`. |
| `upstream` | An `http` or `https` url. It may not carry a query string or a fragment. |
| `auth` | The policy of the route. It replaces `defaults.auth`; it is not merged with it. |
| `timeouts` | The budgets of the route. Merged field by field with `defaults.timeouts`. |
| `maxBodyBytes` | The body limit of the route. It wins over `defaults.maxBodyBytes`, which wins over `SHUTTLE_MAX_BODY_BYTES`. |
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

---

## 4. The environment

The environment is read once, at the start of the process, and it is
validated as a whole: a value that cannot be understood stops the gateway,
because a setting that looks active but is not a security hole. The only
exception is the level of the log, which falls back to `info`.

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

The store is in memory (`memory://local`) or in Redis. A deployment with
several replicas needs Redis: a session that lives in the memory of one
replica is unknown to the others.

A store that cannot be reached denies the caller. The gateway never lets
somebody in because the store had a hiccup.

### 5.4 The bearer tokens

The bearer token is validated against the same provider: the signature
(through the remote JWKS set), the issuer, the audience and the expiry. The
accepted algorithms are `RS256`, `ES256`, `RS384`, `RS512`, `ES384` and
`PS256`. The tolerance of the clock is five seconds.

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

The answer is `{"allow": true}` or `{"allow": false, "reason": "…"}`. A
status that is not a success, a body that is not JSON and a decision that is
malformed are all a **denial**.

The reason of the service is never given to the caller: it describes the
policy of the platform and it is not the business of the client.

The decisions are cached for `SHUTTLE_ACCESS_CACHE_TTL_MS` (5 s). Only an
**explicit** decision is cached: a transport failure is not a decision, and
caching it would keep denying a caller that the service would have allowed.
The cache key is the subject, the workspace, the route and the roles, so a
decision made for a caller with a role is never served to a caller without
it.

The **latency of a revocation is the TTL of the cache**. It is the knob an
operator turns when a revocation has to be immediate.

---

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

`Cookie` is rewritten: the cookies of the gateway (`shuttle_session`,
`shuttle_oidc_state`) are removed, the cookies of the application are kept.

Written by the gateway:

| Header | Value |
| --- | --- |
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

**The secret.** The signature is keyed with `SHUTTLE_SESSION_SECRET`. The
signing key is derived from it, so the two purposes can not be confused:

```
key = HMAC-SHA256(secret, "shuttle-identity-signature-v1")
```

If `SHUTTLE_SESSION_SECRET` is unset, a random secret is generated **per
process**: the signatures are then not verifiable by an upstream across
replicas or restarts. The gateway refuses to start in production without
it. The secret is never sent to an upstream; an upstream verifies the
signature with the derived key.

**The payload.** A canonical JSON array, so no value can move from one
field into another:

```
["v3", METHOD, path, query, host, subject, workspaceId, email, sortedRoles]
```

| Field | Value |
| --- | --- |
| `METHOD` | The method, upper-cased. |
| `path` | The path **as the upstream received it**: the base path of the upstream in front of the request path. |
| `query` | The query string as the upstream received it, with its leading `?`. The empty string when there is none. |
| `host` | The effective host (§7.3), lower-cased. |
| `subject` | The subject, sanitized as in §7.1. |
| `workspaceId` | The workspace, sanitized. The empty string when there is none. |
| `email` | The e-mail, sanitized. The empty string when it is not known. |
| `sortedRoles` | The roles, sorted ascending. The order is not part of the meaning. |

The signature covers exactly the values that are written into the headers:
the **sanitized** subject, e-mail and workspace, and the **filtered** roles
(a role that contains a comma or a control character is dropped, because it
would make the comma separated list of `x-shuttle-roles` ambiguous). The
roles that are handed to the access service are not filtered.

**The value.** `v3=<hex>`. The version is part of the value so the format
can change without breaking the verification. The comparison is done in
constant time.

**The test vector** (pinned in `src/domains/forwarding/identity-signature.test.ts`):

```
secret  = "test-secret"
key     = 53060fda6e7406918eb25fc53342d73c12ebd6ff60b20444557bedb92be4ff5c
claims  = { subject: "user-1", email: "user@example.com",
            roles: ["admin","dev"],
            workspaceId: "11111111-1111-4111-8111-111111111111" }
request = { method: "GET", path: "/base/ws/123", query: "?x=1",
            host: "api.example.com" }
payload = ["v3","GET","/base/ws/123","?x=1","api.example.com","user-1",
           "11111111-1111-4111-8111-111111111111","user@example.com",
           ["admin","dev"]]
signature = v3=d10099233a754d22506db9d4a8d397bb8f58c0cbfe93f2782309eea1c49c7e4c
```

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

The allowed origins are the origin of the gateway itself and the origins of
`SHUTTLE_ALLOWED_ORIGINS`. The origin of the gateway is computed from the
**effective host** (§7.3) and the effective protocol.

The guard is applied to every request that carries the session cookie of the
gateway, whatever the credential that authenticated it.

`GET /auth/logout` is refused from another site whatever its method.

---

## 9. The limits

Fixed-window counters.

| Scope | Key | Setting |
| --- | --- | --- |
| The deployment | `deployment:total` | `SHUTTLE_RATE_LIMIT_TOTAL_MAX` |
| A caller over all the routes | `caller:<ip>` | `SHUTTLE_RATE_LIMIT_GLOBAL_MAX` |
| A caller on one route | `route:<id>:<ip>` | `SHUTTLE_RATE_LIMIT_MAX` |
| An authenticated caller on one route | `principal:<id>:<subject>` | `SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX` |
| The requests that match no route | `none:<ip>` | `SHUTTLE_RATE_LIMIT_MAX` |
| The login attempts | `<ip>` | `SHUTTLE_LOGIN_RATE_LIMIT_MAX` |

A limit of `0` disables the limiter.

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
   from the cache.

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
stripped, and the path is not rewritten. The WebSocket url is built the
same way, with `http` → `ws` and `https` → `wss`.

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
| `shuttle_cross_site_refusals_total` | `route` | The requests that came from another site. |
| `shuttle_websocket_connections_total` | `route` | The accepted upgrades. |
| `shuttle_websocket_refusals_total` | `reason` | The refused handshakes. |
| `shuttle_request_duration_seconds` | `route` | The latency of the exchanges. |
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

---

## 13. What Shuttle does not do

Shuttle does not:

- terminate TLS (a proxy in front of it does);
- decide access on its own, or check roles;
- rewrite the path of the request;
- buffer or cache responses;
- aggregate WebSockets;
- support more than one upstream per route;
- retry a failed request or break the circuit of a failing upstream.

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
| `src/domains/rate-limiting/` | The fixed windows, the scopes, the `retry-after`, the bounded memory and the Redis counter. |
| `src/domains/proxying/` | The state of the exchange, the limits of the body, the phase and idle budgets, the cancellation, the commitment outcomes and the registry of the active exchanges. |
| `src/domains/websockets/` | The reservations of the slots, the handshake with the upstream first, the state of the bridge, the buffers, the keepalive, the revalidation and the registry of the pairs. |

### 14.2 The layers

| Path | Owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. It starts the runtime and nothing else. |
| `src/app/` | The Hono application: the thin handlers, the middleware, the order of the pipeline and the mapping of the failures to the answers of the protocol. |
| `src/platform/bun/` | The listener, the actual peer address, the outbound HTTP transport, the upgrade and the socket primitives. |
| `src/platform/redis/` | The construction, the TLS settings and the disposal of the shared Redis clients. |
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
| 20 | The version of the runtime | The runtime is **Bun ≥ 1.4.3**. The boundaries the gateway relies on are not observable on the 1.2 line. The measurements are in [runtime.md](runtime.md). |
| 21 | The forwarding headers of a client | The standard `forwarded` header is removed in both directions. The `Authorization` header of the caller is forwarded to the upstream as it is (§7.1). |
| 22 | The host of a request | The effective host is the `x-forwarded-host` of a trusted proxy, and the `Host` header otherwise. It decides the route, the origin and the signature (§7.3). |
| 23 | The limits | Four scopes: the deployment, the caller over all the routes, the caller on one route and the authenticated caller on one route. A scope keyed by an address cannot bound a flood that spreads over many addresses, and it cannot tell two tenants behind the same address apart (§9). |
| 24 | The metrics of the requests | Every answer of the gateway is counted, the refusals included. The labels are bounded: `unmatched` for the requests that matched no route, `other` for a method or a status that is not tracked (§12.1). |
| 25 | The revalidation of a WebSocket | An open connection is revalidated: the route, the session and the access are checked again, and the connection is closed with `1008` when one of them fails (§10). |
| 26 | The number of exchanges at the same time | The exchanges are bounded by `SHUTTLE_MAX_CONCURRENT_REQUESTS`, so a client that opens a request and never sends its body cannot hold the resources of the process (§11.2). |

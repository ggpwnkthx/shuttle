# Shuttle — Specification

Shuttle is an application gateway. It authenticates a caller against an
OpenID Connect provider, asks an access service whether the caller may use a
workspace, and forwards the request to a single configured upstream.

This document is normative for product behavior and source organization.
[IMPLEMENTATION.md](IMPLEMENTATION.md) defines implementation ownership and
verification; [BUILD_PLAN.md](BUILD_PLAN.md) defines commit order. Domain
boundaries are specified in §14. Production recommendations in the
implementation guide do not become requirements until explicitly recorded
here or in a versioned deployment policy.

This revision reorganizes the code by domain and clarifies inconsistent
wording; it adds no route options or environment variables.

Status: 0.1.0. Runtime: Bun ≥ 1.4.3 (see §15, decision 21). Listener: HTTP
+ WebSocket on `SHUTTLE_GATEWAY_HOST:SHUTTLE_GATEWAY_PORT` (default
`0.0.0.0:8080`).

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **caller** | The client of the gateway (browser, API client). |
| **principal** | The authenticated caller: `subject`, optional `email`, `roles`, and the `source` of the credential (`session` or `jwt`). |
| **route** | A host + path match with exactly one upstream and one policy. |
| **workspace** | The unit of access control, named by a path placeholder (`{workspaceId}`). |
| **upstream** | The application a request is forwarded to. |
| **access service** | The external service that decides whether a subject may use a workspace. |

Invariants (all enforced in code, none configurable):

- Shuttle never decides access on its own — it asks the access service and
  fails closed.
- The identity headers of Shuttle are written only by Shuttle; client copies
  are always stripped.
- The cookies of the gateway never reach an upstream.
- A credential selected by the route's authentication mode that is invalid
  is rejected; the gateway does not fall back to another credential (§5.1).
- The cross-site guard is driven by the **presence of the session cookie**,
  not by the credential that authenticated the request (§8).

---

## 2. Request pipeline

### 2.1 The request identifier

The identifier is a **middleware** that wraps the endpoints of the gateway
and the dispatcher, so every answer of the gateway carries one:

- the `x-request-id` of the request is reused when it matches
  `^[A-Za-z0-9._-]{1,64}$`;
- otherwise a UUID is generated;
- the identifier is written in the `x-request-id` header of the answer;
- it is in every log line of the request, and it is the identifier of a
  websocket connection.

An identifier that is not valid (too long, or holding a character that is
not allowed) is replaced by a generated one: the identifier ends up in a
log line and in a header, so it may not carry anything else.

### 2.2 The endpoints of the gateway

The paths of the gateway itself are matched by their own handlers, before the
route table is consulted. They are never forwarded to an upstream, whatever
the configuration says.

| Endpoint | Behaviour |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok",…}`. Always available. |
| `GET /readyz` | `200` when a configuration is loaded and the session store answers, `503` otherwise (§12.3). |
| `GET /metrics` | Prometheus text; `404` when `SHUTTLE_METRICS_TOKEN` is unset, `401` when the bearer token does not match. |
| `GET /auth/login` | Login limiter → OIDC redirect (§5.2). |
| `GET /auth/callback` | Completes the login (§5.2). |
| `GET /auth/logout` | Cross-site navigation guard → destroys the session → `302 /`. |

`/auth/login` needs the address of the caller for its limiter, so the
handler computes the forwarding context itself (§7.3), exactly like the
dispatcher does. The dispatcher never runs for these paths.

A request that uses another method on one of these paths (for example
`POST /healthz`) falls through to the dispatcher and is refused with
`404 not_found` (the path is reserved).

### 2.3 The dispatcher

For every other request the gateway executes, in this order:

1. **Configuration** — no configuration has ever been loaded → `503
   not_ready`.
2. **Reserved path** — the path is one of the endpoints of §2.2, or one of
   `reservedPaths` of the configuration → `404 not_found`.
3. **Forwarding context** — the peer address, the trusted-proxy evaluation
   and the client address are computed (§7.3).
4. **Route match** — the route is matched (host + path) **before** the
   limiters, so the per-route budget is keyed by the route that would handle
   the request.
5. **Rate limits** — the global limit, then the per-route limit (§9). A
   refusal → `429 too_many_requests` with `retry-after`.
6. **No route** — a request that matched no route → `404 no_route`. It has
   already been counted by the limiters, in the `none:<ip>` bucket: a flood
   of requests to a path that does not exist is a flood like any other.
7. **Authentication** — per the mode of the route (§5). Failure → `401
   unauthorized`, or a `302` to `/auth/login?redirect=…` when the client
   accepts HTML and the mode is not `jwt`-only.
8. **Cross-site guard** — when the request carries the session cookie (§8).
   Refusal → `403 cross_site_request`.
9. **Workspace check** — the placeholder is read, validated as a UUID when
   `requireUuid` is set, and the access service is asked (§6). Denial → `403
   workspace_forbidden`.
10. **Dispatch** — WebSocket upgrade (§10) or HTTP proxying (§11).

Gateway-generated refusal/error bodies are JSON
`{"error": <code>, "message": <text>}`, except the documented redirects,
client-disconnect outcome and upgrade behavior. Successful gateway endpoints
use their documented representation; proxied response bodies pass through.

---

## 3. Configuration file

`SHUTTLE_CONFIG` (default `./config/routes.json`) holds a JSON object,
validated as a whole with zod. Unknown keys are configuration errors.

```jsonc
{
  "version": 1,
  "defaults": {
    "auth": { "mode": "none" },
    "timeouts": { "responseMs": 5000, "firstByteMs": 30000, "bodyMs": 300000 },
    "maxBodyBytes": 10485760
  },
  "reservedPaths": [],
  "trustedProxies": ["127.0.0.1/32", "::1/128"],
  "routes": [
    {
      "id": "workspace-api",
      "match": { "host": "api.example.com", "path": "/ws/{workspaceId}/" },
      "upstream": "http://upstream-b:3000",
      "auth": { "mode": "any", "workspace": { "param": "workspaceId", "requireUuid": true } },
      "timeouts": { "responseMs": 2000 },
      "websocket": true,
      "maxBodyBytes": 5242880
    }
  ]
}
```

### 3.1 Route options

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `id` | string | — | required, unique, `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` |
| `match.host` | string | — | `example.com`, `*.example.com` or `*`; ≤ 253 chars |
| `match.path` | string | — | starts with `/`; segments are literals or `{placeholder}`; ≤ 512 chars |
| `upstream` | url | — | required; `http`/`https`; **no query string, no fragment** |
| `auth` | object | `defaults.auth` | **replaces** the default, it is not merged |
| `timeouts` | object | `defaults.timeouts` | merged field by field; `responseMs`, `firstByteMs`, `bodyMs` (§11.2) |
| `websocket` | boolean | `false` | |
| `maxBodyBytes` | number | `defaults.maxBodyBytes` → `SHUTTLE_MAX_BODY_BYTES` | 0 disables; ≤ 1 GiB |

`defaults.maxBodyBytes` is optional; the route wins over the defaults, which
win over the environment. `reservedPaths` and `trustedProxies` of the file are
**added** to the corresponding environment values.

An upstream that carries a query string or a fragment is rejected at load
time. The query string of the **request** replaces the one of the upstream and
a fragment never reaches the upstream, so such an url would silently do
something else than it says (§11.1).

### 3.2 Auth policy

```json
{ "mode": "any",
  "workspace": { "param": "workspaceId", "requireUuid": true } }
```

`mode` is one of `none`, `session`, `jwt`, `any`; `workspace` is optional.
The object is strict: an unknown key is rejected. A `workspace` check
together with `mode: "none"` is rejected (it could never be satisfied).

### 3.3 Validation and rejection

The configuration is rejected as a whole when it is invalid, when two routes
are ambiguous (same host kind + value and same template skeleton), when a
route id is duplicated, or when a route claims a reserved path (trailing
slashes ignored). The previous configuration stays active; the failure is
reported in the log, in `shuttle_config_reloads_total{result="failed"}` and
in the body of `/readyz`.

### 3.4 Matching and precedence

Host: exact > `*.suffix` > `*`. The port and the trailing dot of the `Host`
header are stripped before the comparison. Path templates match by prefix
(`/ws/{id}/` matches `/ws/abc` and `/ws/abc/assets`); the trailing slash of
the template is optional.

Ties are broken by: (1) host specificity, (2) longer literal prefix, (3)
more template segments, (4) route id, alphabetically. A placeholder value
that cannot be percent-decoded makes the request **unmatched** (404), not a
route match with a broken identifier.

---

## 4. Environment

Read once at startup, validated as a whole. A malformed value stops the
gateway; the only exception is `SHUTTLE_LOG_LEVEL`, which falls back to
`info`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHUTTLE_CONFIG` | `./config/routes.json` | Path of the route table. |
| `SHUTTLE_GATEWAY_HOST` / `SHUTTLE_GATEWAY_PORT` | `0.0.0.0` / `8080` | Listener. |
| `SHUTTLE_OIDC_ISSUER` | dev fixture | OIDC issuer. |
| `SHUTTLE_OIDC_CLIENT_ID` | `shuttle` | OIDC client id. |
| `SHUTTLE_OIDC_CLIENT_SECRET` | — | OIDC client secret. |
| `SHUTTLE_OIDC_REDIRECT_URI` | `http://localhost:8080/auth/callback` | Callback url. |
| `SHUTTLE_OIDC_SCOPES` | `openid,profile,email,groups` | Requested scopes. |
| `SHUTTLE_OIDC_ROLES_CLAIM` | `roles` | Claim that carries the roles. |
| `SHUTTLE_OIDC_AUDIENCE` | the client id | Required audience of a bearer token. |
| `SHUTTLE_OIDC_ALLOW_INSECURE` | `true` outside production | Allow an http issuer. |
| `SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT` | `false` | Allow a client without a secret. |
| `SHUTTLE_ACCESS_URL` | dev fixture | Base url of the access service. |
| `SHUTTLE_ACCESS_TOKEN` | — | Bearer token for the access service. |
| `SHUTTLE_ACCESS_TIMEOUT_MS` | `3000` | Timeout of a decision request. |
| `SHUTTLE_ACCESS_CACHE_TTL_MS` | `5000` | TTL of a cached decision. |
| `SHUTTLE_ACCESS_ALLOW_ANONYMOUS` | `false` | Call the access service without a token. |
| `SHUTTLE_SESSION_URL` | `memory://local` | Store: `memory://…` or `redis://…`. |
| `SHUTTLE_SESSION_KEY_PREFIX` | `shuttle` | Prefix of the session keys. |
| `SHUTTLE_SESSION_TTL_MS` | `28800000` (8 h) | Idle lifetime of a session. |
| `SHUTTLE_SESSION_MAX_AGE_MS` | `86400000` (24 h) | Maximum age of a session, whatever the activity. `0` disables the cap. |
| `SHUTTLE_SESSION_TOUCH_INTERVAL_MS` | `60000` | Sliding expiry interval. |
| `SHUTTLE_SESSION_MAX_SESSIONS` | `5000` | Sessions in the memory store. |
| `SHUTTLE_SESSION_TLS_CA[_BASE64]` | — | CA of the Redis connection. |
| `SHUTTLE_SESSION_SECRET` | random per process | Signs the login state cookie **and** derives the identity signing key; **required in production**. |
| `SHUTTLE_SHARED_STATE_URL` | the Redis session url | Where the rate limits and the decision cache live. |
| `SHUTTLE_SHARED_STATE_KEY_PREFIX` | `shuttle` | Prefix of the shared keys. |
| `SHUTTLE_COOKIE_SECURE` | `true` in production | `Secure` attribute of the cookies. |
| `SHUTTLE_LOG_LEVEL` | `info` | `debug`…`silent`. |
| `SHUTTLE_METRICS_TOKEN` | — | Bearer token required by `/metrics`; without it the endpoint is 404. |
| `SHUTTLE_MAX_BODY_BYTES` | `10485760` | Default body limit (0 disables). |
| `SHUTTLE_TRUSTED_PROXIES` | — | Extra CIDRs/IPs whose forwarding headers are trusted. |
| `SHUTTLE_EXTERNAL_PROTO` | `http` | Protocol the client uses towards the gateway. |
| `SHUTTLE_ALLOWED_ORIGINS` | — | Extra origins allowed by the cross-site guard. |
| `SHUTTLE_CSRF_STRICT` | `false` | Also refuse cross-site navigations. |
| `SHUTTLE_RATE_LIMIT_MAX` / `_WINDOW_MS` | `0` / `60000` | Per route, per caller (0 disables). |
| `SHUTTLE_RATE_LIMIT_GLOBAL_MAX` / `_WINDOW_MS` | `0` / `60000` | Per caller, all routes (0 disables). |
| `SHUTTLE_LOGIN_RATE_LIMIT_MAX` / `_WINDOW_MS` | `30` / `60000` | Login attempts per caller. |
| `SHUTTLE_WS_MAX_CONNECTIONS` | `1000` | Open websockets (0 = no limit). |
| `SHUTTLE_WS_MAX_PAYLOAD_BYTES` | `16777216` | Maximum size of a websocket message. |
| `SHUTTLE_WS_MAX_BUFFERED_BYTES` / `_MESSAGES` | `262144` / `100` | Outbound buffer per connection. |
| `SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES` | `1048576` | Queued bytes before the connection is closed. |
| `SHUTTLE_WS_PING_INTERVAL_MS` / `SHUTTLE_WS_PONG_TIMEOUT_MS` | `30000` / `90000` | Keepalive. |
| `SHUTTLE_WS_IDLE_TIMEOUT_SECONDS` | `120` | Idle timeout of a connection. |
| `SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS` | `10000` | Upstream handshake timeout. |
| `SHUTTLE_SHUTDOWN_TIMEOUT_MS` | `15000` | Drain deadline on SIGTERM/SIGINT. |

In production (`NODE_ENV=production`) the gateway refuses to start unless
`SHUTTLE_SESSION_SECRET`, `SHUTTLE_OIDC_ISSUER`, `SHUTTLE_OIDC_CLIENT_ID`,
`SHUTTLE_OIDC_REDIRECT_URI`, `SHUTTLE_ACCESS_URL` are set, and unless
`SHUTTLE_OIDC_CLIENT_SECRET` or `SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT=true`,
and `SHUTTLE_ACCESS_TOKEN` or `SHUTTLE_ACCESS_ALLOW_ANONYMOUS=true`.

---

## 5. Authentication

### 5.1 Modes

| Mode | Accepted credential |
| --- | --- |
| `none` | none — the request is forwarded unauthenticated. |
| `session` | the session cookie only. |
| `jwt` | the `Authorization: Bearer` token only. |
| `any` | bearer token first, session cookie second. |

The evaluation order is fixed, so the credential that authenticates a request
never depends on the shape of the request. An `Authorization` header that is
not a bearer token is **not** a credential: a route in mode `session` ignores
it, a route in mode `jwt`/`any` rejects the request.

A request may carry **both** credentials. In that case the bearer token
authenticates the request (mode `any`), but the request is still a **browser**
request for the cross-site guard, because the cookie is attached by the
browser without the caller's intent (§8).

### 5.2 Browser login

`GET /auth/login?redirect=/path` → `302` to the provider with `state`,
`nonce` and a PKCE `S256` challenge. The state (state, nonce, PKCE
verifier, post-login target, expiry) is kept in a signed cookie with a 10
minute lifetime. `GET /auth/callback` validates the state, exchanges the
code, creates a server side session and sets the session cookie. The
post-login target must be a relative single-slash path without control
characters; anything else becomes `/` (no open redirect).

`GET /auth/logout` destroys the session, deletes the cookie and redirects to
`/`. It is refused (`403 cross_site_request`) when it comes from another
site, whatever its method.

**The login state is single use.** It is enforced on four levels:

1. The state cookie is deleted as soon as the callback is processed.
2. The `state` parameter of the callback must equal the state of the cookie.
3. The PKCE verifier and the nonce bind the code exchange to this login
   attempt, so a code that was obtained elsewhere is refused.
4. The authorization code itself is single use at the provider, so a replay
   of the callback fails even with a valid cookie.

**The state cookie** (`shuttle_oidc_state`): signed with
`SHUTTLE_SESSION_SECRET`, `HttpOnly`, `Secure` (outside production it
follows `SHUTTLE_COOKIE_SECURE`), `SameSite=Lax`, `Path=/`, `Max-Age=600`,
no `Domain`. A tampered cookie, a cookie signed with another secret, an
expired cookie and a missing cookie are all refused (`400 login_failed`).

### 5.3 Sessions

Server side, opaque id in the `shuttle_session` cookie. The store is chosen
by the scheme of `SHUTTLE_SESSION_URL`: `memory://` (bounded LRU of
`SHUTTLE_SESSION_MAX_SESSIONS`) or `redis://`.

**The session cookie** (`shuttle_session`): `HttpOnly`, `Secure` (outside
production it follows `SHUTTLE_COOKIE_SECURE`), `SameSite=Lax`, `Path=/`,
no `Domain`.

**The cookie follows the session.** The session lives in the store, the
browser only holds its id, so a cookie that is never refreshed would expire
eight hours after the login while the session is still alive. Every request
that is authenticated by a session therefore hands the browser a refreshed
cookie. Its `Max-Age` is

```
min(remaining idle lifetime, remaining maximum age)
```

so the cookie never outlives the session it names. The refreshed cookie is
sent with every answer of the request, including the refusals: the browser
has to learn about the new lifetime even when the request was refused.

A maximum age of `0` means **unlimited**: the cap does not exist, so the
cookie follows the idle lifetime of the session alone. A cap of `0` is never
read as "the session is over now".

**Lifetime.** Two independent bounds:

| Bound | Setting | Meaning |
| --- | --- | --- |
| Idle lifetime | `SHUTTLE_SESSION_TTL_MS` (8 h) | How long a session survives without being used. It is refreshed on a read, at most once per `SHUTTLE_SESSION_TOUCH_INTERVAL_MS` (60 s), so a busy caller is not written to the store on every request. |
| Maximum age | `SHUTTLE_SESSION_MAX_AGE_MS` (24 h) | How long a session may be used at all, counted from its creation, whatever the activity of the caller. |

The idle lifetime alone does **not** bound the lifetime of a session: a
caller that keeps working could hold a session for ever. The maximum age
does. A session that is older than it is refused and deleted from the store,
whatever the activity; the caller has to log in again. A value of `0`
disables the cap: the maximum age is then **unlimited** (it is not "the
session is over now"), and the idle lifetime is the only bound.

A store that cannot be reached denies the caller (fail closed) and yields
`503 session_store_unavailable` during the login.

### 5.4 OIDC validation

Both credential types are validated against the same provider, whose
metadata is discovered from the issuer (cached for 10 minutes) and whose
signing keys are fetched through a remote JWKS set.

**Browser flow** (`/auth/callback`) — the library validates the
authorization response: the `state` must match, the **nonce must match**,
the **id token is required** (`idTokenExpected`), its signature, its issuer
and its audience are verified, and the PKCE verifier is presented. The
exchange always uses the configured redirect uri, never the url the browser
happened to call. An issuer whose discovered value differs from the
configured one is refused.

**Bearer token** — the signature (JWKS), the issuer, the audience (the
client id, or `SHUTTLE_OIDC_AUDIENCE`) and the expiry are verified, with a
clock tolerance of 5 s. Only `RS256`, `ES256`, `RS384`, `RS512`, `ES384` and
`PS256` are accepted. A token without a subject is refused. A nonce is not
required for an API token (it is not bound to a login attempt); when a nonce
is passed, it must match.

The roles are read from the claim named by `SHUTTLE_OIDC_ROLES_CLAIM`, which
may be a list of strings or a single delimited string. A claim that is
neither yields no roles.

---

## 6. Workspace access

When a route declares `auth.workspace`:

1. The identifier is read from the placeholder `param` of the matched path.
   Missing → `400 bad_request`.
2. When `requireUuid` is set, a value that is not a UUID → `400 bad_request`.
3. The gateway asks the access service: `POST {SHUTTLE_ACCESS_URL}/v1/decisions`
   with `{subject, workspaceId, routeId, roles}` and the service token as a
   bearer token, within `SHUTTLE_ACCESS_TIMEOUT_MS`.
4. The answer must be `{allow: boolean, reason?: string}`. Anything else, a
   non-2xx status, a timeout or a network error → denial (fail closed).
5. Decisions are cached for `SHUTTLE_ACCESS_CACHE_TTL_MS`, keyed by
   subject, workspace, route and the **sorted roles** of the caller. A shared
   cache is used when `SHUTTLE_SHARED_STATE_URL` is set, so replicas can
   reuse decisions. TTL caching is not immediate revocation or a guarantee
   that concurrent replicas always observe the same decision; it does not
   reauthorize an existing WebSocket.

The reason of the access service is logged and counted
(`shuttle_auth_failures_total{reason="missing_role"|"access_denied"}`) but is
not given to the caller. Shuttle never evaluates roles itself.

---

## 7. Header policy

### 7.1 Request → upstream

Removed in both directions, never configurable: `connection`, `keep-alive`,
`proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
`transfer-encoding`, `upgrade`, `host`, all `x-forwarded-*`, `x-real-ip`, and
the identity headers `x-shuttle-user`, `x-shuttle-user-id`, `x-shuttle-email`,
`x-shuttle-roles`, `x-shuttle-workspace`, `x-shuttle-workspace-id`,
`x-shuttle-internal`, `x-shuttle-authenticated`, `x-shuttle-signature`,
`x-forwarded-user`, `x-forwarded-email`, `x-forwarded-groups`, `x-remote-user`,
`x-remote-email`. Also remove every header named by `Connection` before
constructing the new forwarding/handshake headers.

`Cookie` is rewritten: the cookies of the gateway (`shuttle_session`,
`shuttle_oidc_state`) are removed, the cookies of the application are kept.

Written by the gateway:

| Header | Value |
| --- | --- |
| `x-forwarded-for` | the chain, client first, peer of the gateway last |
| `x-forwarded-proto` | `http` or `https` (effective protocol) |
| `x-forwarded-host` | the host the client used |
| `x-real-ip` | the client address |
| `x-shuttle-user` | the subject of the caller |
| `x-shuttle-email` | the e-mail of the caller, when known |
| `x-shuttle-roles` | the roles, comma separated, ambiguous roles dropped |
| `x-shuttle-workspace` | the workspace, when the route has one |
| `x-shuttle-signature` | the signature of the identity (§7.4) |

Identity values are stripped of control characters and truncated to 512
characters. A subject that is empty after that cannot be written into a
header at all: the request fails with `500 internal_error` (the upstream
never receives an identity it cannot trust).

### 7.2 Upstream → client

Removed: the hop-by-hop headers, the identity headers of §7.1, the
`x-forwarded-*` and `x-real-ip` headers, and every `Set-Cookie` that sets a
cookie of the gateway (an upstream must not be able to fix the session of the
browser). The `Location` header is made relative when it names the upstream
itself, so the internal hostname never reaches the browser; a location that
names another host is left alone.

### 7.3 Forwarding headers and the client address

The forwarding headers are honoured **only** when the immediate peer is in
`trustedProxies` (config file + `SHUTTLE_TRUSTED_PROXIES`). Otherwise they
are ignored and the peer address is the client address.

The chain of `x-forwarded-for` is read from the right: the right-most entry
that is not a trusted proxy is the client. The entries to its left were
injected by the client and are dropped. The chain that is forwarded upstream
starts at the client and ends at the peer of the gateway.

`x-forwarded-proto` is only honoured from a trusted proxy, and only when it
is `http` or `https`; anything else falls back to the configured protocol.

### 7.4 Identity signature

**The secret.** The signature is keyed with `SHUTTLE_SESSION_SECRET` — the
same variable that signs the login state cookie. The signing key is derived
from it, so the two purposes can not be confused:

```
key = HMAC-SHA256(secret, "shuttle-identity-signature-v1")
```

If `SHUTTLE_SESSION_SECRET` is unset, a random secret is generated **per
process**: the signatures are then not verifiable by an upstream across
replicas or restarts. The gateway therefore refuses to start in production
without it. The secret is never sent to an upstream; an upstream verifies
the signature with the shared secret it was configured with.

**The payload.** A canonical JSON array, so no value can move from one field
into another:

```
["v3", METHOD, path, query, host, subject, workspaceId, email, sortedRoles]
```

| Field | Value |
| --- | --- |
| `METHOD` | the method, upper-cased. |
| `path` | the path **as the upstream received it**: the base path of the upstream in front of the request path, percent-encoded as it is sent. |
| `query` | the query string **as the upstream received it**, with its leading `?`; the empty string when the request has none. |
| `host` | the host the client used (the value of `x-forwarded-host`), lower-cased. |
| `subject` | the subject, sanitized as in §7.1. |
| `workspaceId` | the workspace, sanitized; the empty string when there is none. |
| `email` | the e-mail, sanitized; the empty string when there is none. |
| `sortedRoles` | the roles, sorted ascending — the order is not part of the meaning. |

**Normalization.** The signature covers exactly the values that are written
into the headers: the **sanitized** subject, e-mail and workspace (control
characters removed, at most 512 characters) and the **filtered** roles (a role
that contains a comma or a control character is dropped, because it would
make the comma separated list of `x-shuttle-roles` ambiguous). The roles
that are handed to the access service are **not** filtered; only the header
is.

**The value.** `v3=<hex>`, the version is part of the value so the format can
change later without breaking the verification. Verification compares the
expected and the given value with a constant-time comparison.

**Test vector** (pin in `src/domains/forwarding/identity-signature.test.ts`):

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

## 8. Cross-site requests

**The trigger.** The guard applies when the request **carries the session
cookie**, whether or not that cookie authenticated it. A browser attaches
the cookie on its own, so a request that carries it is a browser request
even when a bearer token was the credential that authenticated it (§5.1).
The guard is not switchable off by adding a header: a cross-site request
that carries a bearer token leaks that token as well, so it is refused all
the more. A request that carries neither the cookie nor a session is not
guarded.

**The rules.** Unsafe methods: `POST`, `PUT`, `PATCH`, `DELETE`.

| Situation | Result |
| --- | --- |
| `Sec-Fetch-Site: cross-site`, foreign origin, unsafe method | refused (`403`) |
| `Sec-Fetch-Site: cross-site`, foreign origin, safe method | allowed by default, refused when `SHUTTLE_CSRF_STRICT` is set |
| `Sec-Fetch-Site: cross-site`, allowed origin | allowed |
| `Sec-Fetch-Site: same-site` with a foreign `Origin`, unsafe method | refused (`same-site` is the same registrable domain, not the same origin) |
| `Sec-Fetch-Site: same-site` with a foreign `Origin`, safe method | allowed by default, refused in strict mode |
| No `Sec-Fetch-Site`, foreign `Origin`, unsafe method | refused |
| No `Sec-Fetch-Site`, foreign `Origin`, safe method | allowed |
| Neither header (a command line client, a service) | allowed |
| Unknown `Sec-Fetch-Site` value | allowed — an unknown value is not a reason to refuse |
| `GET /auth/logout` from another site | refused, whatever the method |

The allowed origins are the origin of the gateway itself and the origins of
`SHUTTLE_ALLOWED_ORIGINS`. The origin of the gateway is derived from the
`Host` header and the effective protocol.

A websocket handshake has its own, stricter rule: a handshake that carries
the session cookie has to name an allowed origin, whatever the method and
whatever `SHUTTLE_CSRF_STRICT` says (§10).

Cross-site **navigations** (safe requests) are allowed by default, because
refusing them breaks every deep link into an application (a link in an
e-mail, a search result). `SHUTTLE_CSRF_STRICT=true` refuses them as well;
it is the mode for a deployment whose upstreams never change the state of
anything on a `GET`.

---

## 9. Limits

Fixed-window counters, keyed by the client address (a caller behind a proxy
is counted once).

| Limiter | Scope | Key |
| --- | --- | --- |
| Global request limit | all routes | `caller:<ip>` |
| Per route request limit | one route | `route:<id>:<ip>` |
| Login attempts | `/auth/login` | `<ip>` |

Unmatched requests count in a `none:<ip>` bucket (§2.3, step 6). A limit of
`0` disables the limiter. The Redis limiter fails **open** (a cache hiccup
is not an outage); the in-process limiter is bounded by an LRU of 10 000 keys.
Refusals → `429 too_many_requests` with `retry-after`, and
`shuttle_rate_limited_total`.

---

## 10. Websockets

A route must set `websocket: true`; otherwise an upgrade → `400
websocket_not_allowed`. The gateway performs its own handshake with the
upstream (with the identity headers and the signature) before it answers the
client, so the client learns the outcome and the subprotocol the upstream
selected. The client handshake headers are not forwarded.

**The origin of the handshake.** A handshake is a `GET`, so the guard of the
cross-site requests lets it through (§8): a `GET` does not change the state
of an upstream. A websocket is not a `GET` though: it opens a bidirectional
connection that stays open, and the page of another site could use it to
talk to the gateway and to the upstream behind it. A browser always sends
the origin of the page in a handshake, so **a handshake that carries the
session cookie of the gateway has to name an allowed origin** (the origin
of the gateway, or one of `SHUTTLE_ALLOWED_ORIGINS`).

- A handshake with a foreign origin → `403 cross_site_request`.
- A handshake without an origin → `403 cross_site_request`.
- A handshake of a client that does not use the session cookie (an API
  client with a bearer token) is not a browser and is not asked for an
  origin.

The check runs **before** the connection to the upstream is opened, and it
is **not** relaxed by `SHUTTLE_CSRF_STRICT`: the strict mode is about the
navigations, this one is about a connection that would be opened in the
name of another site.

Guards: at most `SHUTTLE_WS_MAX_CONNECTIONS` open connections (`503
too_many_connections`), a message larger than `SHUTTLE_WS_MAX_PAYLOAD_BYTES`
is refused, the outbound buffer is bounded
(`SHUTTLE_WS_MAX_BUFFERED_BYTES` / `_MESSAGES`), a client that does not read
closes the connection at `SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES`, and the
keepalive pings every `SHUTTLE_WS_PING_INTERVAL_MS` and closes a connection
that did not answer within `SHUTTLE_WS_PONG_TIMEOUT_MS` or that was idle for
`SHUTTLE_WS_IDLE_TIMEOUT_SECONDS`. The upstream handshake has
`SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS`.

---

## 11. Proxying

### 11.1 The url of the upstream

The upstream url is built from the base url of the route and the request:

1. The **base path** of the upstream is taken, its trailing slashes removed.
2. The **path of the request** is appended (it always starts with `/`).
3. The **query string of the request** is used as the query string of the
   upstream. The query string of the upstream itself is not used (it may not
   exist, §3.1).
4. The **fragment** is never forwarded.

```
upstream http://app:3000        + /ws/123?x=1  →  http://app:3000/ws/123?x=1
upstream http://app:3000/base/  + /ws/123?x=1  →  http://app:3000/base/ws/123?x=1
upstream http://app:3000/base   + /ws/123      →  http://app:3000/base/ws/123
```

The path is forwarded unchanged: the prefix that matched the route is **not**
stripped, and the path is not rewritten. The websocket url is built the same
way, with `http` → `ws` and `https` → `wss`.

### 11.2 The phases and their budgets

Bodies are streamed in both directions (no buffering of the whole body), so
server sent events and large uploads work. Every phase has its own budget,
merged field by field from `defaults.timeouts` and `timeouts` of the route:

| Phase | Budget | Default | Covers | Kind |
| --- | --- | --- | --- | --- |
| upload | `bodyMs` | 300 000 | the time between two chunks of the request body | **idle** |
| response | `responseMs` | 5 000 | everything between the end of the upload and the response headers: the establishment of the connection, the time the upstream needs to look at the request, and the time it needs to produce its answer | **total** |
| first byte | `firstByteMs` | 30 000 | the time between the arrival of the response headers and the first byte of the body | **total** |
| body | `bodyMs` | 300 000 | the time between two chunks of the response body | **idle** |

An **idle** budget is rearmed on every chunk: a client that uploads slowly
or an upstream that streams server sent events for hours is not cut off as
long as it keeps making progress. A client or an upstream that stops making
progress is cut off after the budget.

**The upload is not part of the answer budget.** The `responseMs` budget
starts when the request has been sent completely, so a slow upload is never
defeated by a short answer budget — the upload is governed by the idle
`bodyMs` budget. The same holds for `firstByteMs`: it starts when the
response headers arrived.

**An answer that cannot have a body has no first byte.** The `firstByteMs`
budget is not armed for the answer of a `HEAD` request, nor for the
answers of the statuses of a **final** response that carry no body (`204`,
`205`, `304`): there is no first byte to wait for, and a budget that waits
for one would abort an exchange that was complete when the answer arrived.
The answer is forwarded as it is.

Two statuses are not in that list, because they are not the answer of the
exchange:

- **`103 Early Hints` is an interim response.** The gateway waits for the
  final response and forwards only that response. If the upstream closes
  without final headers, the exchange fails with `502 bad_gateway`. If it
  remains open without final headers until the response budget expires,
  the exchange fails with `504 gateway_timeout`. Interim headers do not
  complete or restart the budget.
- **`101 Switching Protocols` is a protocol switch.** A switch is the
  business of the websocket upgrade: the gateway performs its own handshake
  with the upstream and its own upgrade with the client (§10). The http
  path does not proxy a protocol switch, it refuses it (`502`).

(The two budgets used to be called `connectMs` and `headersMs`. The names
described something else than they did: the first one is the budget of the
**answer** of the upstream, the second one the budget of the **first byte** of
its body. The old names are refused by the configuration.)

The limit of the body is `route.maxBodyBytes` → `defaults.maxBodyBytes` →
`SHUTTLE_MAX_BODY_BYTES`; `0` disables it. A body over the limit → `413
payload_too_large` — both when the limit is already exceeded by
`content-length` and when it is discovered while the body streams. Whether
the failure can be reported as a `413` depends on the answer of the
upstream, not on the upload: see §11.3.

### 11.3 Failures, and what the caller sees

**Before the response headers are sent**, the gateway can still answer with
an error of its own:

| Failure | Status | Body |
| --- | --- | --- |
| The upstream did not answer in time (`responseMs`) | `504 gateway_timeout` | JSON |
| The request body is over the limit, and the upstream had not answered yet | `413 payload_too_large` | JSON |
| The caller went away | `499` | empty |
| The upstream could not be reached | `502 bad_gateway` | JSON |

**After the response headers are sent**, the status line is fixed: the
gateway can no longer replace the answer with a JSON error, and it does not
try. A failure that is discovered while the body streams (the body budget
runs out, the upstream resets the connection, the body is cut) **ends the
response body**: the client sees a truncated stream and a closed connection.
This includes the `firstByteMs` budget: the response headers were already
received, so a timeout before the first byte ends the stream rather than
producing a `504`.

**An upstream may answer before it read the whole request** (an early
response). The gateway does not assume that an unfinished upload means that
nothing was sent: the rule is the one above, and it is applied to the
upload as well.

- If the limit of the body is reached **before** the answer of the upstream
  arrives, the gateway aborts the exchange and answers `413`.
- If the answer of the upstream arrived **first**, that answer is what the
  caller gets: the status line was already sent, so the failure cannot
  replace it. The rest of the upload is dropped, and the body of the answer
  may be truncated.

Consequences of that rule, stated so they are not a surprise:

- The status that is recorded is the status of the upstream (e.g. `200`),
  because that is what the client received; the outcome is recorded
  separately as `aborted`.
- The metric `shuttle_request_duration_seconds` covers exchange lifetime;
  byte counters report observed stream bytes, not advertised Content-Length.
- The log line `request proxied` carries `outcome: "aborted"` and byte counts
  consumed from the request stream / handed to the downstream runtime.
  These counts do not prove acknowledgement or consumption by the peer.
- The upstream request is cancelled when the caller disconnects (the request
  signal aborts the fetch), so a client that goes away does not leave the
  upstream working.

---

## 12. Operations

### 12.1 Health, readiness, metrics

- `GET /healthz` → `200 {"status":"ok",…}`; always available.
- `GET /readyz` → `200` when a configuration is loaded and the session store
  answers, `503` otherwise; the body reports both.
- `GET /metrics` → `200` Prometheus text when its bearer token matches;
  `404` when `SHUTTLE_METRICS_TOKEN` is unset, `401` when the supplied
  token is missing or incorrect. Metrics:
  `shuttle_requests_total{route,method,status}`,
  `shuttle_request_errors_total{route}`,
  `shuttle_auth_failures_total{route,reason}`,
  `shuttle_websocket_connections_total{route}`,
  `shuttle_websocket_refusals_total{reason}`,
  `shuttle_request_duration_seconds{route}`,
  `shuttle_bytes_in_total`, `shuttle_bytes_out_total`,
  `shuttle_active_requests`, `shuttle_config_reloads_total{result}`,
  `shuttle_rate_limited_total`, `shuttle_cross_site_refusals_total{route}`,
  `shuttle_shared_state_errors_total`.

### 12.2 Logs

JSON (pino). `Authorization`, `Cookie`, `Set-Cookie`, `x-api-key` and the
query parameters `access_token`, `code`, `code_verifier`, `id_token`,
`refresh_token` (and the like) are redacted. Every request or connection
log line carries its request id. Process/startup logs have process context
rather than an invented request id.

### 12.3 Reload and readiness

The configuration file is watched. A reload is atomic: the new file is
parsed, validated and checked for ambiguity **before** it replaces the running
one.

**A failed reload does not make the gateway unready.** The last valid
configuration stays active and the gateway keeps serving it. The failure is
reported in the body of `/readyz` (`config.lastError`), in the log, and in
`shuttle_config_reloads_total{result="failed"}`. A broken file on disk must
not take a running deployment out of rotation.

`/readyz` answers `503` only when **no configuration has ever been loaded**
(the gateway just started and the file is not valid yet) or when the session
store cannot be reached (every authenticated request would fail).

### 12.4 Shutdown

On `SIGTERM`/`SIGINT` the listener stops accepting, the open connections are
drained for `SHUTTLE_SHUTDOWN_TIMEOUT_MS`, then the process exits; the
remaining connections are closed.

---

## 13. Out of scope

Shuttle does not: terminate TLS (a proxy in front of it does), decide
access on its own, check roles, rewrite the path of the request (the path is
forwarded unchanged), buffer or cache responses, aggregate websockets, or
support more than one upstream per route.

## 14. Domain organization and repository layout

Build one deployable modular monolith. Domain ownership is part of the
implementation contract: keep a domain's policy, use cases, ports,
domain-specific adapters and unit tests together. Hono and Bun are boundary
technologies and must not determine the business-module layout.

### 14.1 Domain ownership

| Path | Owns |
| --- | --- |
| `src/domains/routing/` | Route identity and match schema/types, host/path matching, parameters, precedence and ambiguity detection. No environment reads or reload lifecycle. |
| `src/domains/configuration/` | Route/file schema, strict validation, effective defaults, immutable compiled snapshots and atomic last-good publication. Reuses routing and authentication's public policy schemas. |
| `src/domains/authentication/` | Principal and auth policy schema/types, credential selection, OIDC/JWKS, browser login/logout, signed state, sessions, expiry and gateway cookie creation. |
| `src/domains/workspace-access/` | Workspace validation, access-service requests/decisions, decision cache keys, TTL and cache adapters. Never evaluates roles locally. |
| `src/domains/forwarding/` | Peer/proxy trust, cross-site/origin policy, header/cookie filtering, target URL, sanitized identity and signature canonicalization. Shared by HTTP and WebSockets. |
| `src/domains/rate-limiting/` | Fixed-window limits, global/route/unmatched/login scopes, retry-after, bounded memory and Redis counter adapters. |
| `src/domains/proxying/` | HTTP exchange state, upload limits, phase/idle budgets, cancellation, commitment outcomes and active exchange registry. |
| `src/domains/websockets/` | Capacity reservations, upstream-first handshake orchestration, bridge state, buffers, keepalive and paired-connection registry. |

### 14.2 Application and runtime boundaries

| Path | Owns |
| --- | --- |
| `src/main.ts` | Minimal runtime entry point. |
| `src/app/` | Hono app factory, thin endpoint handlers/middleware, typed request state, pipeline order and HTTP error mapping. No resource construction or business policy implementation. |
| `src/platform/bun/` | Listener, actual peer address, outbound HTTP transport, upgrade/socket primitives and Bun event adapters implementing domain ports. |
| `src/platform/redis/` | Shared client construction, connection/TLS settings and disposal. Domain key formats, Lua scripts and store/cache behavior remain with the owning domain. |
| `src/runtime/` | Startup environment validation, composition root, filesystem watching, signals, admission/drain and resource cleanup. |
| `src/observability/` | Framework-independent observation interfaces plus logging/redaction and metrics adapters; bounded labels and idempotent exchange finalization. |
| `services/` | Deterministic OIDC, access, HTTP and WebSocket fixtures. |
| `test/architecture/`, `test/contract/` | Import-boundary checks and gateway/pipeline contract tests. |
| `test/integration/`, `test/network/` | Real Redis/service checks and real-socket capability/transport checks. |
| `test/browser/`, `test/load/` | Browser behavior, capacity and soak scenarios. Domain unit tests are colocated as `*.test.ts`. |

### 14.3 Dependency rules

1. A domain exposes a deliberate `index.ts` for public types, ports and use
   cases. Cross-domain consumers import that entry point, never internal
   files. Concrete adapters expose a separate `adapters/index.ts` for runtime
   composition and adapter tests. Entry points have no startup side effects.
2. Routing, authentication and rate limiting have no dependencies on other
   domains. Configuration may use routing and authentication's public
   schemas/types. Workspace access may use authentication principal and
   routing identifier types. Forwarding may use the authentication principal
   type. Proxying and WebSockets may use forwarding plans/types. The app
   orchestrates combinations; domains do not import it.
3. Core domain code does not import Hono, Bun APIs, concrete adapters,
   `app`, `platform` or `runtime`. It receives options and injected ports
   (stores, clients, transport, clock/entropy and observation as needed).
   Concrete adapters may use third-party libraries and implement their
   domain's ports. All production environment reads occur in `runtime`.
4. `app` uses domain entry points and observation interfaces, never concrete
   adapters. `platform` implements public domain ports without making policy
   decisions. `runtime` is the composition root allowed to assemble `app`,
   domain adapters, platform adapters and observability. Observability does
   not import domains, app, platform or runtime.
5. Keep types/errors and tests with the domain that owns them; map typed
   outcomes to protocol responses at the boundary. Avoid catch-all shared
   `services`, `utils`, `types` or `repositories` directories. Do not create
   empty layers or one interface per function.
6. CI checks these rules, including type-only imports and cycles. Tests
   within a domain may access their own internals; integration tests consume
   public APIs or explicitly exercise the relevant adapter. Keep all checks
   separate from product request handling.

### 14.4 Resource ownership

Runtime constructs and closes shared clients, watchers and process timers.
Configuration owns the last-good immutable generation. Each request captures
one generation for all policy and forwarding decisions. The HTTP exchange
owns its streams, phase timers and cancellation; a WebSocket pair owns both
legs, its buffers, keepalive timers and capacity reservation. Request
middleware never starts a watcher, opens a shared Redis client or registers
a process signal handler.

A single owner finalizes each exchange/connection exactly once. Middleware
completion does not imply stream completion. Shutdown drains through domain
lifecycle APIs and force-cancels remaining work at the deadline; low-level
socket and stream operations stay in the Bun adapters.

---

## 15. Decision log

Decisions retained from specification 0.1.0, followed by the organization
decision and wording clarifications in this revision. Unresolved production
policies remain explicitly listed in IMPLEMENTATION §10.

| # | Question | Decision | Where |
| --- | --- | --- | --- |
| 1 | Session cookie **and** bearer token in the same request | The bearer token authenticates the request, but the request is guarded by the cross-site rules, because the cookie was attached by the browser. | §5.1, §8 |
| 2 | Cross-site requests refused, cross-site navigations allowed | Different things: state-changing requests from another site are refused; safe navigations are allowed unless `SHUTTLE_CSRF_STRICT` is set. `/auth/logout` is refused from another site whatever its method. | §8 |
| 3 | Order of the pipeline | The endpoints of the gateway are matched before the dispatcher and compute their own forwarding context; in the dispatcher the route is matched **before** the limiters, and a request that matches no route is counted by the limiters and then refused. | §2 |
| 4 | Upstream url with a base path | The base path of the upstream is prefixed to the path of the request; the query string of the request replaces the one of the upstream; fragments are dropped; an upstream that carries a query or a fragment is rejected at load time. | §3.1, §11.1 |
| 5 | Failure while the body streams | The status line is already sent: the body stream ends, the client sees a truncated answer, the outcome is recorded as `aborted`. No JSON error is invented for a response that already started. | §11.3 |
| 6 | Meaning of `bodyMs` | An **idle** budget, rearmed on every chunk — not a total duration. `responseMs` and `firstByteMs` are total budgets of their phase. The upload is governed by the idle body budget and is **not** part of `responseMs`. | §11.2 |
| 7 | Names of the budgets | `connectMs` → `responseMs` (the answer of the upstream), `headersMs` → `firstByteMs` (the first byte of its body). The old names described something else than they did and are refused by the configuration. | §11.2 |
| 8 | An upstream that answers before the upload is over | The answer of the upstream wins: the status line was already sent, so the failure (a body over the limit) ends the body instead of replacing the answer. The `413` is only for a failure that is discovered before the answer arrives. | §11.3 |
| 9 | Origin of a websocket handshake | A handshake that carries the session cookie has to name an allowed origin; one without an origin is refused. The check is not relaxed by `SHUTTLE_CSRF_STRICT` and happens before the upstream is contacted. | §8, §10 |
| 10 | The cookie of the browser | It follows the session: every request that is authenticated by a session refreshes it, with a `Max-Age` of `min(remaining idle lifetime, remaining maximum age)`. | §5.3 |
| 11 | Request identifier | A middleware around the gateway endpoints and the dispatcher: the `x-request-id` of the request is reused when it is valid, a UUID is generated otherwise, and the answer carries it. | §2.1 |
| 12 | A maximum age of `0` | Unlimited: the cap does not exist. The session is not refused because of its age, and the cookie of the browser follows the idle lifetime of the session alone. | §5.3 |
| 13 | An answer without a body | The `firstByteMs` budget is not armed for a `HEAD` request nor for the statuses of a final response that carry no body (`204`, `205`, `304`): the answer is forwarded as it is. | §11.2 |
| 14 | `103` and `101` | `103` is interim: the gateway waits for the final response and forwards it, and never passes an interim response on. `101` is a protocol switch: it belongs to the websocket upgrade, and the http path refuses it. | §11.2, §10 |
| 15 | OIDC validation | The nonce, the state, the PKCE verifier and the id token are required in the browser flow; the state is single use; the cookie attributes are fixed (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`). | §5.2, §5.4 |
| 16 | Maximum lifetime of a session | The idle lifetime (8 h, sliding) **and** a maximum age (24 h from the creation, whatever the activity). The maximum age is the real bound. | §5.3 |
| 17 | Secret of the identity signature | `SHUTTLE_SESSION_SECRET`, from which the key is derived; unset means a random per-process secret, which is refused in production. The signature covers the sanitized values that are written into the headers. | §7.4 |
| 18 | Readiness after a failed reload | The gateway stays ready and keeps the last valid configuration; the failure is visible in `/readyz`, in the log and in the metrics. | §12.3 |
| 19 | Domain organization | Feature policy, ports, domain adapters and unit tests live together; app/platform/runtime are explicit boundaries. Public imports and dependency directions are checked in CI. | §14 |
| 20 | Inconsistent operational wording | Selected-credential rejection, valid metrics-token success, interim-only response failure, cache reuse and observation byte boundaries are explicit. These clarify the existing contract; they add no configuration fields. | §1, §6, §11.2–11.3, §12.1–12.2 |
| 21 | The version of the runtime | The runtime is **Bun ≥ 1.4.3**. The boundaries the gateway relies on (an early answer while the upload runs, the cancellation of the upload, the refusal of an upstream websocket handshake, the upgrade of the caller with the headers of the gateway) are not observable on the 1.2 line of the runtime. The behavioral requirements of this specification are unchanged; the version of the platform they are implemented on is part of the contract. The measurements are in `docs/transport-capabilities.md`. | §Status, §10, §11.3 |

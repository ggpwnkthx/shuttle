# Shuttle implementation guide

[SPECS.md](SPECS.md) is authoritative for behavior and domain boundaries. [BUILD_PLAN.md](BUILD_PLAN.md) defines commit order. This guide defines implementation ownership, dependency rules and verification. It accompanies specification 0.1.0; recommendations marked as decisions are not additional defaults.

## 1. Organize by domain

Use a modular monolith. Keep a feature's policy, use cases, ports, domain-specific adapters and unit tests together. Hono middleware delegates to those use cases. Bun adapters own transport primitives. Avoid generic `services`, `utils`, `types` or `repositories` directories that collect unrelated behavior.

| Domain | Owns | Public dependencies on other domains |
| --- | --- | --- |
| `routing` | Route identity and match schema/types, host/path matching, placeholder extraction, precedence and ambiguity detection | None |
| `configuration` | Route/file schema, whole-file validation, effective defaults, compiled generations and atomic last-good publication | Routing and authentication public schemas/types |
| `authentication` | Principal and auth policy schema/types, credential selection, OIDC/JWKS, login state, sessions, expiry and gateway cookie creation | None |
| `workspace-access` | Workspace validation, access-service decisions, decision keys and caches | Authentication principal and routing identifier types only |
| `forwarding` | Trusted-proxy context, origin policy, header/cookie filtering, target construction, sanitized identity and signatures | Authentication principal type only |
| `rate-limiting` | Fixed-window policy, global/route/login scopes, memory and Redis counter adapters | None |
| `proxying` | HTTP exchange state, upload limits, phase/idle timers, cancellation and active exchange registry | Forwarding plan/types only |
| `websockets` | Capacity reservations, upstream-first negotiation, bridge state, buffers, keepalive and paired connection registry | Forwarding plan/types only |

The canonical paths and import rules are in SPECS §14. There is no dependency from routing to configuration, from authentication to workspace access, or between the HTTP and WebSocket domains. The application orchestrates those combinations.

Keep each domain shallow. Add internal subfolders only when several related files justify them. For example, `authentication/index.ts` exports principal types, use cases and storage ports; `sessions.ts` owns lifetime rules; `adapters/redis-sessions.ts` implements the session port; and `sessions.test.ts` tests the rules. Do not create an interface for every function.

Cross-domain imports go through the domain's `index.ts`. Concrete adapters have a separate `adapters/index.ts` consumed by the composition root. Entry points expose no initialized clients or global singletons. Unit tests may inspect their own domain's internals; consumers test through public entry points.

Core domain code uses plain values, standard Web APIs where useful, and injected ports. It does not import Hono, Bun APIs, concrete adapters, `app`, `platform` or `runtime`, or read environment variables. Domain-specific Redis scripts, key formats, OIDC calls and access HTTP clients stay in their domain's adapters. `platform/redis` only constructs/configures shared clients; `platform/bun` implements transport ports. No adapter acquires policy ownership.

Enforce the allowed import graph in CI, including type-only imports, public entry points and the composition-root exception for adapters. Keep business types with their owner: the authenticated principal and the sanitized forwarding identity are distinct. Never put raw credentials into a shared request-context dump.

## 2. Composition and request ownership

`runtime/composition.ts` parses environment settings, creates clients/stores/domain services, builds the application and starts the listener. It passes domain option objects rather than environment names. `runtime/lifecycle.ts` owns watcher, timer and client disposal. The application owns neither process signals nor shared resource creation.

| Lifetime | Owner | Responsibilities |
| --- | --- | --- |
| Process | Runtime composition/lifecycle | Environment, clients, watchers, signal handling, admission and cleanup |
| Configuration generation | Configuration domain | Immutable compiled snapshot; last error is separate from last-good state |
| Policy request | App with domain use cases | ID, snapshot, forwarding context, route/parameters, principal, cookie presence, workspace and pending response headers |
| HTTP exchange | Proxying service with Bun transport | Independent upload/response progress, timers, cancellation and finalization |
| WebSocket pair | WebSocket service with Bun transport | Reservation, both legs, buffers, timers, close and capacity release |

Create one observation handle per request. Streaming and socket owners finalize it exactly once; middleware return is not exchange completion. Use idempotent cleanup so timeout, disconnect, upstream error and shutdown can race safely.

Register the request-ID/observation wrapper first. Terminal handlers for gateway endpoints run before proxy middleware. Login computes its own forwarding context and limiter; callback/logout call authentication use cases; logout applies its cross-site rule. Do not accidentally inherit proxy authentication or automatic HEAD behavior for these handlers.

The proxy application pipeline follows SPECS §2.3 exactly: capture configuration, reject reserved paths, resolve forwarding context, match route, apply global then route/unmatched limits, reject unmatched, authenticate, apply the cookie-presence cross-site guard, authorize workspace, then dispatch HTTP or WebSocket. Adapters map typed domain failures to the specified status and code.

Capture one immutable configuration generation for the entire request. It supplies trusted proxies, effective route policy, budgets and target. Login uses last-good trust settings, or validated startup trust settings before the first valid configuration. Existing exchanges keep their captured generation after reload.

Do not install body parsers, body logging/cloning, compression, caching, ETags, path normalization or generic total-timeout middleware on proxied traffic. Avoid generic auth/CSRF middleware whose behavior changes the specified credential/origin matrix. Apply WebSocket handshake headers through the upgrade adapter rather than response middleware after upgrade.

## 3. Configuration and pure policy

Routing owns match schema, route identity, matching and precedence. Configuration composes routing and authentication's public policy schemas with defaults, trust settings and reserved paths, validates the whole file, and publishes a fully compiled generation. Define required public policy types with their owning domain before dependent behavior. Validate workspace placeholder references, duplicate IDs, ambiguous routes and reserved namespace conflicts before publication. Reject unknown keys and obsolete timeout names.

Test segment boundaries, wildcard host depth, literal-prefix ties, IPv6/ports, trailing dots/slashes and invalid escapes. Decode placeholder values after identifying segments; do not decode and normalize the entire path. Preserve the request target for forwarding and signing.

Runtime watches the configured file and feeds configuration's reload use case. Handle atomic file replacement as well as writes, debounce bursts and serialize loads so an older asynchronous read cannot overwrite a newer generation. Invalid initial configuration leaves health/readiness handlers available and proxy dispatch unavailable. Invalid later configuration preserves last-good readiness and exposes the reload error.

Forwarding policy is shared by HTTP and WebSockets. Build an immutable forwarding plan from the captured route and validated request facts:

1. Evaluate the real peer against trusted proxies; drop injected forwarding-chain entries.
2. Remove fixed hop-by-hop fields and every field nominated by `Connection`; strip incoming identity/forwarding values before rebuilding trusted values.
3. Remove every occurrence of gateway cookies while retaining application cookies; cookie names are case sensitive.
4. Construct the base-path-prefixed target without changing encoded path/query semantics. Do not follow upstream redirects or automatically retry requests.
5. Generate sanitized identity headers and sign exactly their canonical values and the target actually used by the transport. Authorization uses the original principal/roles.

Preserve separate response `Set-Cookie` fields and remove upstream gateway-cookie attempts. Test origin-aware Location rewriting, including the injected upstream base prefix. Pin UTF-8 serialization, sorting and lowercase hex with the specification vector and adversarial cases. Header representation/size limits and Authorization forwarding require the decisions in §10.

## 4. Prove the transport before building around it

Pin exact Bun, Hono, adapter and dependency versions. The specification's minimum-version statement needs CI evidence before it becomes a supported-version claim. Keep capability tests as regression tests; in-process Hono requests cannot prove network behavior.

| Capability | Required real-network evidence |
| --- | --- |
| Streaming upload | Upstream receives bytes before upload EOF; memory stays bounded |
| Upload timing | Identify the observed event: stream EOF, transport acceptance or bytes sent; do not call them equivalent |
| Response phases | Observe final headers separately from first body bytes; ignore interim responses |
| Early response | Upstream can answer before upload completes; status and cancellation honor commitment |
| Disconnect | Both directions cancel; timers, upstreams and registries are released |
| Upgrade headers | Successful handshake carries request ID and refreshed gateway cookie |
| WebSocket negotiation | Selected subprotocol, non-101 response visibility, binary frames, ping/pong and backpressure are observable |
| Drain | Admission stops and real streams/socket pairs close within the configured deadline |

If the runtime cannot expose a required boundary, implement a transport adapter or record an explicit, tested specification change. A timer around a generic fetch call does not establish separate phase control. Parsing runtime error-message strings does not establish a handshake refusal contract.

## 5. HTTP exchanges

The proxying domain defines the `HttpTransport` port. The Bun adapter accepts a prepared target/headers, request stream, effective limits, abort signal and observation callbacks. It reports transport events and exposes a controlled response stream; it does not match routes, authenticate or authorize.

Use manual redirect handling, preserve compressed bytes and metadata, and disable transparent decompression when necessary. Prove these behaviors on the pinned transport. Never replay a partially transmitted upload automatically.

Track upload and response state independently:

| Event | Action |
| --- | --- |
| Dispatch without request body | Arm `responseMs` |
| Upload progress | Count actual bytes and rearm upload idle budget |
| Upload complete | Clear upload timer; arm `responseMs` if final headers have not arrived |
| Final headers | Clear response timer, select/handoff final response, then arm `firstByteMs` when a body is expected |
| First response bytes | Clear first-byte budget; monitor response idle progress |
| HEAD, 204, 205, 304 or completed empty body | Complete without waiting for an impossible first byte |
| Failure/disconnect | Cancel affected work; use commitment to choose error response versus aborted stream |
| Both directions finished or cancelled | Finalize once; clear timers and remove registry entry |

Use monotonic durations. `responseMs` and `firstByteMs` are total phase budgets; `bodyMs` is idle, separately tracked in both directions. Do not charge the upload to `responseMs`. A finite connection-establishment ceiling for uploads is an unresolved production decision, not a replacement for these budgets.

Final upstream headers should be handed downstream promptly, preserving the specification's early-response-wins rule. Document the adapter's conservative response handoff/commit event. Upstream-header receipt and actual network delivery are different observations; do not claim wire acknowledgement. After handoff, first-byte/body failures error or terminate the stream and record `aborted`; they cannot become a new JSON response.

Before handoff, classify body excess as 413, timeout as 504 and upstream transport failure as 502 according to the specification. A disconnected caller is observed as 499 when no status was committed; no response can be delivered to that caller. An HTTP 101 is a failure, not a proxied protocol switch. An interim-only exchange fails when it closes without final headers or times out while waiting.

Check valid Content-Length early, then count actual streamed upload bytes, including unknown-length requests. Cancel at excess without buffering the body. The request body limit does not cap SSE responses. Preserve backpressure: paused reads caused by a slow downstream must not be mislabeled as upstream inactivity; record a separate write-stall policy if needed.

Align Bun and ingress limits with route policy, including disabled body limits and long-lived streams. Byte metrics describe bytes consumed from upload streams and handed to the downstream runtime, not proven peer receipt.

## 6. Authentication, workspace decisions and limits

Authentication owns credential precedence and cookie/session use cases. Use established OIDC/JWT libraries behind injected adapters. Validate browser state, nonce, PKCE, required ID token, signature, issuer and audience. Bearer validation includes the specified algorithms, issuer, audience, temporal rules and subject. Bound discovery/JWKS calls and unknown-key refreshes; failed discovery must never validate an unverified token.

Test every credential/mode combination. An invalid selected bearer cannot fall back to a valid session; session mode ignores bearer authentication; mode none does not invent a principal. Cookie presence remains independent from the credential that succeeds.

Use random opaque session IDs and create a new ID at login. Validate signed login state and expiry; clear its cookie on every callback outcome. A signed cookie is not encrypted. Strict atomic transaction consumption across replicas is a separate decision; deleting a browser cookie alone cannot atomically consume concurrent callbacks.

Model creation time, idle expiry and absolute expiry separately. Redis touch must be atomic, interval-limited, capped by absolute age and unable to recreate a session deleted by logout. A maximum age of zero is unlimited. Stage renewed cookies for every session-authenticated response, including refusals and upgrades, with bounded integer-second Max-Age. Never create a session after a failed lookup.

Workspace access sends the exact validated subject, workspace, route and original roles. Require an explicit boolean decision; malformed/non-2xx responses and dependency failures deny. Use structured collision-resistant cache keys with sorted roles. Scope/invalidate keys by configuration generation where a reload changes policy meaning. Bound memory caches and any in-flight deduplication map.

Cache TTL bounds reuse, not immediate revocation or authorization of existing sockets. Record whether only explicit decisions are cached and how a shared-cache outage falls back; a fresh bounded decision call with no stale-allow fallback is recommended. Log a bounded reason category without disclosing the service's arbitrary reason to callers.

Rate limiting owns fixed-window keys and failure behavior. Redis increment/expiry must be one atomic operation; retry-after uses the actual remaining window. Do not blindly retry ambiguous writes. Keep global, route, unmatched and login scopes distinct, preserve Redis fail-open behavior, and bound the in-process LRU to the specified size.

## 7. WebSocket pairs

The WebSocket domain defines ports for the upstream handshake and both connected legs; Bun adapters expose socket primitives/events. The domain owns reservation and bridge state; the runtime only initiates drain through its public lifecycle API.

1. Complete route, authentication, cookie-origin and workspace checks before contacting upstream. A session cookie requires an explicit allowed Origin, including on bearer-authenticated requests.
2. Reserve capacity atomically, counting pending handshakes. The cap is per process unless a distributed reservation policy is explicitly added.
3. Build the shared forwarding plan. Regenerate each leg's handshake keys/extensions; offer only requested subprotocols.
4. Connect upstream within the handshake deadline and validate its selected subprotocol. Apply the recorded non-101/refusal mapping before upgrading the caller.
5. Upgrade the caller with staged request ID/cookie headers. If it disappears or upgrade fails, close upstream and release capacity.
6. Bridge text/binary faithfully, bounding early frames, domain queues and runtime buffered bytes together.
7. On failure or close, finalize both legs, clear timers/buffers and release capacity exactly once.

Enforce payload limits in both directions, including decompressed messages if compression is negotiated. Define soft buffer/message limits versus the hard backpressure close threshold. Do not enqueue data twice after a runtime reports backpressure. Monitor pongs per leg; define whether application idle time excludes control frames. Never transmit reserved close codes such as 1006.

The existing contract authorizes at handshake. Closing/revalidating live connections on credential expiry, logout, access revocation or reload is a production policy decision and must be specified before claiming bounded revocation.

## 8. Lifecycle and observation

Runtime owns admission and shutdown. Stop admission before drain, including new upgrades and work on reused connections. Ask HTTP and WebSocket registries to drain, enforce `SHUTTLE_SHUTDOWN_TIMEOUT_MS`, then abort remaining work. Stop watchers/timers, close clients and flush logs within a bounded cleanup allowance. Coordinate the ingress/orchestrator grace period and direct signal delivery.

Readiness follows the specification: a failed reload keeps the last-good generation ready; missing initial configuration or an unavailable session store is unready. Drain readiness and rejection responses need an explicit operations decision.

Observability provides injected request/exchange observers and logger/metric adapters. Record status separately from outcome, and handshake duration separately from connection lifetime. Finalize after real completion/cancellation. Use bounded labels: route ID or fixed unmatched value, normalized method, fixed failure category. Never label metrics by workspace, subject, URL, request ID or arbitrary provider reason.

Redact credentials, gateway cookies, signed state, session IDs, secret-bearing URLs and nested provider/transport errors. Process-level logs have no invented request ID; all request/connection logs carry their correlation ID. Dependency probes and metrics authentication must be bounded.

| Failure | Required behavior |
| --- | --- |
| Session store unavailable | Session authentication fails closed; login returns 503; readiness fails |
| Access service unavailable | Workspace request denied; no stale-allow fallback |
| Decision cache unavailable | Recorded bounded fresh-call strategy; authorization still fails closed |
| Redis limiter unavailable | Fail open and emit shared-state degradation metric |
| OIDC/JWKS unavailable | Bounded failure; no unverified authentication |
| Invalid reload | Keep last-good configuration and report the error |
| Upstream failure after handoff | Abort stream, retain committed status, finalize once |

## 9. Verification placement

Keep pure/domain unit tests beside implementation. Put architecture checks in `test/architecture`, application contracts in `test/contract`, real Redis/service checks in `test/integration`, transport tests in `test/network`, browser flows in `test/browser`, and capacity/soak scenarios in `test/load`. Shared deterministic providers/upstreams belong in `services/`.

| Owner | Minimum evidence beyond happy paths |
| --- | --- |
| Routing/configuration | Precedence, malformed encodings, reserved namespaces, failed reload, stable request generation |
| Forwarding | Spoofed chains/identity, Connection-nominated headers, duplicate cookies, origin matrix, signature vector and exact target |
| Authentication | Full credential matrix, provider validation, expiry/touch/logout races, redirect attacks, renewal on refusals/upgrades |
| Workspace access/limits | Canonical keys, malformed replies, TTL/outage behavior, concurrent Redis windows, bounded local state |
| HTTP | Unknown-length/large uploads, SSE, delayed headers/first byte, bodyless responses, early answers, compression, slow readers and phase disconnects |
| WebSockets | Forbidden/foreign-origin attempts, concurrent reservations, subprotocol/refusal, early frames, payload/buffer bounds, pong failure and close races |
| App/runtime | Endpoint isolation/wrong methods, production validation, mounted-file replacement, signals during all transport phases |
| Observation | Redaction on failures, bounded labels, accurate status/outcome, one finalization and gauges returning to baseline |

Use real browsers for cookie attributes, redirects, cross-site behavior and WebSocket Origin. Use two independent clients/processes for shared-state races. Network tests must assert resource cleanup, not just status. Record load targets before measuring the pinned release behind the intended ingress: throughput, p95/p99, concurrent sockets, memory, CPU and error rate. Soak with reloads/reconnects; memory, descriptors, connections and timers must settle after traffic stops.

## 10. Decisions to record before release

Do not silently turn these recommendations into behavior. Resolve a decision before its dependent implementation/commit; update SPECS or a versioned deployment policy, plus acceptance evidence. Runtime capability findings block commit 02; the remaining applicable production decisions block release.

| Decision | Recommended resolution / owner |
| --- | --- |
| Upload and response commitment boundaries | Prove observable events; select an adapter or explicitly revise the timing contract. Proxying/platform. |
| Upstream WebSocket non-101/refusal mapping | Specify status/body/header handling, timeout/network mapping and bounds; prove the client exposes needed data. WebSockets/app. |
| Connection establishment during upload | Finite independent ceiling; five seconds is a starting policy to validate. Proxying/runtime. |
| Caller Authorization and standard Forwarded | Define forwarding by route/auth mode; remove competing untrusted client-identity metadata. Forwarding. |
| Header representation | Define empty roles, non-ASCII encoding and aggregate role/header bounds without changing authorization identity. Forwarding. |
| Token purpose | Define API access-token type validation where the provider supports it. Authentication. |
| Login transaction consumption | Use atomic expiring shared transactions if stronger single use than provider-code replay protection is required. Authentication. |
| Decision-cache outage/failure entries | Cache explicit decisions, not transport failures; fresh bounded call on cache outage; deny if that fails. Workspace access. |
| Live WebSocket authorization | Specify handshake-only versus expiry closure/revalidation and the actual revocation window. WebSockets/authentication/access. |
| HMAC verifier provisioning | Give trusted upstreams the derived identity key rather than the session master secret; version the verifier contract. Forwarding/runtime. |
| External host and response caching | Accepted host/origin list; private/non-cacheable auth and cookie-bearing responses. App/runtime/deployment. |
| Replica topology and Redis TLS | Shared stores/common secrets for replicas; verified TLS; document per-process caps. Runtime/deployment. |
| Drain policy | Readiness/admission outcomes and WebSocket close behavior during drain. Runtime/app. |

## 11. Release gate

- Every normative specification requirement has an owner and meaningful acceptance evidence; import-boundary checks pass.
- Exact versions, lockfile and image are recorded; claimed compatibility matches tested versions.
- Transport capability, domain, contract, Redis, network and browser checks pass; applicable decisions above are recorded and tested.
- Route auth modes, accepted hosts, trusted proxies, private upstream access, metrics protection and secret provisioning are reviewed against the deployment.
- Ingress preserves streaming/WebSockets and respects body/time limits; measured capacity and resource limits are recorded.
- Multi-replica state, redaction, dependency degradation and reload recovery are exercised where applicable.
- Shutdown/forced cleanup and rollback pass with active uploads, SSE and sockets; rotation/session-invalidation procedures are documented.

No document or passing mock suite certifies production readiness without this evidence.

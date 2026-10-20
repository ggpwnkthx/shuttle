# The changelog of Shuttle

## 0.1.0

The first release of the application gateway. The behavior of the gateway is
described in [SPECS.md](SPECS.md); the code is organized by domain, as
[ARCHITECTURE.md](ARCHITECTURE.md) describes it.

### What it does

- **Routing**: one upstream per route, matched on host and path, with a fixed
  precedence and an ambiguity check at load time.
- **Authentication**: OpenID Connect with PKCE for the browser, bearer tokens
  for the API clients, in four modes that decide predictably which credential
  a route accepts. A credential that the mode selected and that is invalid is
  refused: the request does not fall back to another credential.
- **Authorization**: the access service decides who may use a workspace; the
  gateway asks and fails closed. The reason of the service is never given to
  the caller.
- **Proxying**: streamed bodies, server sent events, uploads, a budget per
  phase of the upstream exchange (`responseMs`, `firstByteMs` and the idle
  `bodyMs`), a limit on the body and the websockets.
- **Header policy**: the hop-by-hop headers, the headers they nominate and
  the spoofable identity headers are removed, the cookies of the gateway
  never reach an upstream and an upstream can never write a cookie of the
  gateway.
- **Cross site requests**: the guard is driven by the presence of the cookie
  of the session and it refuses the requests that change the state of an
  upstream. A websocket handshake that carries the cookie has to name an
  allowed origin.
- **Sessions**: server side, in the process or in a Redis compatible store,
  with an idle lifetime and a maximum age. The cookie of the browser follows
  the session.
- **Operations**: health and readiness probes, Prometheus metrics, structured
  logs with redaction, a hot reload of the configuration and a graceful
  shutdown.

### The organization of the code

The domains own their policy, their ports, their adapters and their tests:
`routing`, `configuration`, `authentication`, `workspace-access`,
`forwarding`, `rate-limiting`, `proxying` and `websockets`. The application
is thin, the platform owns the sockets and the runtime is the only place
where the concrete pieces are assembled. The import boundaries are checked
by `scripts/architecture.ts` and by the CI workflow.

### The deployment

- The image is built from a pinned runtime, it carries the version and the
  revision of the build as labels, it runs as a non-root user and it holds
  the dependencies of the gateway alone (the development dependencies of the
  fixtures are not part of it).
- The manifests of Kubernetes are in `deploy/kubernetes/`: the deployment
  (the probes, the resources, the hardening, the grace period of the drain),
  the service, the autoscaling, the budget of the disruptions, the network
  policy, the ingress (without the buffering of the bodies) and the route
  table. The secret of the deployment is applied from the secret store of
  the platform, never from the repository.
- The stack of a single host is in `deploy/compose.production.yaml`: the
  gateway and the shared state, without the fixtures of the development.
- The review of a deployment is in `docs/deployment-review.md`: the modes of
  the authentication, the hosts, the trusted proxies, the access to the
  upstreams, the protection of the metrics, the secrets, the limits and the
  capacity.
- The manifests are checked by the test suite: a manifest that does not
  parse, a deployment without the probes, a secret written in a manifest or
  an ingress that buffers the bodies fail the build.

### The decisions of the release

They are recorded in [DECISIONS.md](DECISIONS.md). Two of them change the
contract and are recorded in the specification itself:

- the runtime is **Bun ≥ 1.4.3**: the boundaries the gateway relies on (an
  early answer while the upload runs, the cancellation of the upload, the
  refusal of an upstream websocket handshake, the upgrade of the caller with
  the headers of the gateway) are not observable on the 1.2 line of the
  runtime. The measurements are in
  [docs/transport-capabilities.md](docs/transport-capabilities.md).
- the standard `forwarded` header is removed in both directions: it is the
  claim of a client about the request it made and it competes with the chain
  the gateway writes.

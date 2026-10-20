# The review of a deployment

The release gate of IMPLEMENTATION.md §11 asks for a review of the deployment
against the settings of the gateway. This document is that review: it is
ticked once per deployment, and the answers are the evidence of the release.

Every item names the place where the setting lives, so a reviewer can check
it without reading the code.

## 1. The modes of the authentication of the routes

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which routes accept a session cookie, which accept a bearer token and which accept both? | `auth.mode` of the route table | |
| Which routes need a workspace and which placeholder carries it? | `auth.workspace` of the route table | |
| Does any route accept no credential at all (`mode: none`)? | `auth.mode` of the route table | |
| Is the upstream of a route with `mode: none` the one that authenticates the caller? | the route table and the application behind it | |

**The rule**: a route with `mode: none` hands the `Authorization` header of
the caller to its upstream unchanged. The upstream of such a route is the
one that authenticates the caller.

## 2. The hosts that are accepted

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which hosts does the gateway answer for? | `match.host` of the route table | |
| Is there a route that matches every host (`*`)? What does it serve? | the route table | |
| Do the hosts of the routes match the hosts the callers use? | the route table and the ingress | |

**The rule**: the paths of the gateway itself (`/healthz`, `/readyz`,
`/metrics`, `/auth/login`, `/auth/callback`, `/auth/logout`) are reserved
whatever the configuration says, and a route that claims one of them is
refused when the configuration is loaded.

## 3. The trusted proxies

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which ranges may send the forwarding headers? | `trustedProxies` of the file and `SHUTTLE_TRUSTED_PROXIES` | |
| Is the ingress the only one that talks to the gateway? | the network policy | |
| Is the client address of a caller the one the rate limiter counts? | `x-forwarded-for` and the trusted proxies | |

**The rule**: the forwarding headers of a request that does not come from a
trusted proxy are ignored, and the address of the peer is the address of the
caller. A range that is too wide lets a caller choose the key of the rate
limiter.

## 4. The access to the upstreams

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which upstream is behind which route? | the route table | |
| Are the upstreams reachable from the internet? | the network policy and the services | |
| Does the gateway reach the upstreams over tls? | the url of the upstream | |
| Are the upstreams of the different routes in different trust domains? | the namespace of the services | |

**The rule**: the upstreams are only reachable from the gateway. The identity
headers of the gateway are only trustworthy when the upstream cannot be
reached from anywhere else.

## 5. The protection of the metrics

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Is `SHUTTLE_METRICS_TOKEN` set? | the secret of the platform | |
| Who reads the metrics and with which token? | the configuration of the scraper | |
| Is the metrics endpoint reachable from outside the cluster? | the service and the network policy | |

**The rule**: without a token the endpoint answers `404`; with a wrong token
it answers `401`. The metrics carry the routes, the methods, the statuses
and a closed set of reasons: never a workspace, a subject, an url or a
request id.

## 6. The secrets

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

## 7. The limits and the budgets

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| What is the limit of the body of a request, and does the ingress agree with it? | `maxBodyBytes` of the routes, `SHUTTLE_MAX_BODY_BYTES` and the ingress | |
| Which phase has which budget? | `timeouts` of the routes and of the defaults | |
| Are the budgets of the routes longer than the timeouts of the ingress? | the ingress | |
| Is the limiter of the deployment enabled? | `SHUTTLE_RATE_LIMIT_MAX`, `SHUTTLE_RATE_LIMIT_GLOBAL_MAX` | |
| How many websockets may a replica hold? | `SHUTTLE_WS_MAX_CONNECTIONS` and the memory of the pod | |

**The rule**: the ingress must not buffer the bodies and must not have a
write timeout that is shorter than a stream of events.

## 8. The capacity

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| What is the measured capacity of a replica? | [capacity.md](capacity.md) | |
| How many replicas does the deployment have? | the autoscaling | |
| What is the capacity of the shared state? | the server of the state | |
| What is the memory of a replica under the load of the deployment? | the limit of the pod | |

**The rule**: the numbers of the capacity document are the ones of the
gateway alone. The capacity of a deployment is bounded by its ingress and by
its upstreams, and it has to be measured there.

## 9. The operations

| Question | Where | The answer of the deployment |
| --- | --- | --- |
| Which probe is the liveness and which one is the readiness? | the deployment | |
| Is the grace period of the pod longer than the deadline of the drain? | the deployment | |
| Who is paged when the readiness fails? | the alerts | |
| How is a broken configuration file rolled back? | the configuration in the version control | |
| How are the sessions invalidated? | [operations.md](operations.md) | |

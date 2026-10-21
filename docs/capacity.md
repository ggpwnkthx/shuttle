# The capacity of the gateway

The targets of this document are the requirements of the deployment. The
measurements are what one machine of the reference environment did; they are
a lower bound, because the gateway and the upstream run in the same process
and there is no ingress, no TLS and no network in between.

The script that measures is `scripts/load.ts`. It can also measure a
gateway that is already running:

```bash
bun run load -- --requests 20000 --concurrency 100
bun run load -- --websockets 500
bun run load -- --url http://localhost:8080 --host api.example.com
```

## The targets

| What | Target | Why |
| --- | --- | --- |
| The requests of a route | 1000 requests/second per replica, with a p99 below 100 ms | The calls of the platform are small and mostly internal. |
| The global limit | The limits of the deployment are the limits of the configuration, not of a replica | The limiter is shared through Redis. |
| The WebSockets | 1000 open connections per replica, 500 opened/second | The connections of the editors of the platform. |
| The memory | Below 512 MiB per replica with 1000 open WebSockets | The pod of the deployment has a limit of 1 GiB. |
| The errors | Below 0.1 % of the requests | A gateway that answers with an error is an outage of the application behind it. |
| The drain | The connections are closed within `SHUTTLE_SHUTDOWN_TIMEOUT_MS` | The orchestrator waits for the pod to go away. |

The limits of the deployment that are **not** the capacity of the process:
the ingress (the number of connections it opens), the limits of the upstream
and the budgets of the routes.

## The measurements

The reference environment: AMD Ryzen 7 5800X (8 cores, 16 threads), 31 GiB
of memory, Linux 7.2, Bun 1.4.3. The gateway and the upstream run in one
process and the traffic is plain http over the loopback interface.

| Measurement | Result |
| --- | --- |
| 3000 requests, 50 in flight | 7541 req/s, p50 6.4 ms, p90 7.7 ms, p99 8.8 ms, 0 errors |
| 20000 requests, 100 in flight | 7683 req/s, p50 13.5 ms, p90 16.7 ms, p99 19.3 ms, max 21.6 ms, 0 errors |
| 500 WebSockets | 415 connections/second, p99 193 ms for the handshake, 0 errors |

What the numbers say:

- the gateway forwards about **7600 requests/second** per core-set of the
  reference machine when the upstream is in the same process. With a real
  upstream the number is lower, and the ingress is the limit of a
  deployment in any case;
- the latency grows with the number of the requests in flight (p50 6.4 ms
  with 50 in flight, p50 13.5 ms with 100 in flight): the queue of the
  runtime is the bottleneck, not the gateway;
- the handshake of a WebSocket costs about 2 ms of the gateway; the limit of
  the connections is the configuration, not the runtime.

## The comparison of the backends of the shared state

The gateway holds its shared state in a **Redis server** or in a **Postgres
server**. The two are interchangeable and the gateway measures them side by
side, with the script `scripts/benchmark.ts`:

```bash
bun run benchmark -- --redis redis://127.0.0.1:6399/0 \
                     --postgres postgres://127.0.0.1:5432/shuttle
```

The scenarios are the paths of a request. Each of them pays a different
number of round trips to the shared state:

| Scenario | What it pays |
| --- | --- |
| `no-state` | nothing: the state is in the process. The baseline. |
| `limits` | three limiter checks: the deployment, the caller and the route. |
| `session` | the limits and the read of the session of the caller. |
| `full` | the limits, the session and the cached decision of the access service. |

The last run: 20 000 requests at 50 in flight, two rounds, on the
reference environment, with the gateway, the upstream, the Redis server
and the Postgres server in the same machine and the traffic over the
loopback interface.

| Scenario | Backend | req/s | p50 | p99 |
| --- | --- | --- | --- | --- |
| `no-state` | in the process | 7244 | 6.9 ms | 11.7 ms |
| `limits` | in the process | 6834 | 7.2 ms | 11.7 ms |
| `limits` | Redis | 5884 | 8.4 ms | 12.9 ms |
| `limits` | Postgres | 3811 | 13.0 ms | 18.4 ms |
| `session` | in the process | 6226 | 7.8 ms | 13.5 ms |
| `session` | Redis | 4144 | 11.7 ms | 26.4 ms |
| `session` | Postgres | 2747 | 18.0 ms | 25.3 ms |
| `full` | in the process | 5610 | 8.4 ms | 14.2 ms |
| `full` | Redis | 3680 | 13.4 ms | 20.1 ms |
| `full` | Postgres | 2414 | 20.6 ms | 27.9 ms |

What the numbers say:

- **Redis costs about a tenth of the throughput** of the baseline on the
  path of the limiter, and about a third on the path of the whole request;
- **Postgres costs about half of the throughput** on the same paths, and
  its p50 is about twice the p50 of Redis;
- the difference grows with the number of round trips: every round trip is
  a round trip, and a transaction of a database is a round trip that
  waits for the server;
- the cost is **not** the disk: with
  `SHUTTLE_POSTGRES_SYNCHRONOUS_COMMIT=off`, which is the default, a
  transaction of the limiter costs about 0.2 ms instead of about 1.8 ms.
  With `on`, the `limits` scenario of Postgres falls to about 420 req/s
  and its p50 reaches 120 ms, because the scope of the deployment
  serializes the requests of the whole deployment and every one of them
  waits for the disk;
- **the size of the pool is not the lever**: a pool of forty connections
  per replica measures *slower* than a pool of ten (about 3 600 req/s
  against about 4 100 req/s on the `limits` scenario). The bottleneck is
  the serialization of the scope of the deployment and not the number of
  the connections that wait for it, so a bigger pool only adds contention
  on the server. The default of ten connections per replica is the right
  one, and a deployment with many replicas needs a pooler in front of the
  server rather than a bigger pool.

What they do not say:

- the numbers are the numbers of **one machine that runs everything**: a
  deployment that puts the database on its own host, or that reaches it
  over the network, pays the latency of the network on every round trip;
- a **managed** Redis and a **managed** Postgres do not have the same
  latency: the measurement has to be made against the servers of the
  deployment;
- the pool of the connections is a deployment decision: ten connections
  per replica is the default, and a server with a low limit of
  connections needs a pooler in front of it.

The choice is not made by the gateway. The script exists so that the
choice is an informed one.

---

## The soak

`bun test test/load` runs the traffic, the WebSockets and the reloads of
the configuration in between, and checks that the resources settle
afterwards: the requests that are in flight, the connections of the
WebSockets and the memory of the process.

The last run of the soak (5 rounds of 50 requests, a WebSocket and a
reload) settled in 1.1 s with a growth of the heap below 64 MiB.

A deployment that is rolled out with a leak runs out of memory at the worst
moment, so the soak is part of the release gate: the memory, the
descriptors, the connections and the timers have to settle after the
traffic stops.

## What was not measured here

| What | Why |
| --- | --- |
| The capacity behind an ingress | There is no ingress in the build environment; the settings that matter are documented in [operations.md](operations.md). |
| The capacity with TLS | The gateway does not terminate TLS: the ingress does, and the cost is the one of the ingress. |
| The capacity with Redis | The shared state was not reachable in the build environment; the limiter and the store of the sessions are covered by the tests of the integration. |
| Several replicas | The tests of the shared state prove that the counters are exact; the capacity of a deployment is the sum of the capacities of its replicas. |

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

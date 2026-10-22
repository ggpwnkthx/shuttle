# The security of Shuttle

Shuttle is a gateway: it sits in front of the applications of a deployment
and it decides who reaches them. A bug in it is a hole in front of every
application behind it, so the report of a problem is treated as a report of
a vulnerability.

## The supported versions

| Version | Supported |
| --- | --- |
| 0.5.x | Yes |

The gateway is at 0.5.0 and the contract of the release is in
[docs/spec.md](docs/spec.md). The behaviour of a release does not change
under an operator: a fix that changes the contract is a new release.

## How to report a problem

Write to the maintainers of the repository, in a private channel: a public
issue is a public disclosure. The report should carry:

- the version of the gateway and the runtime it runs on;
- what an attacker can do, and what they need to do it;
- the steps to reproduce it, and the configuration that reproduces it;
- the logs of the gateway, **with the credentials removed**.

The maintainers acknowledge the report within three working days, and they
say what they expect to happen. A fix that needs a release is released as
soon as it is ready, and the report is published with it — the reporter is
named, unless they ask not to be.

## What is in scope

Everything that lets a caller reach an upstream, or an upstream reach
something it should not:

- the authentication of the callers and the modes of the credentials;
- the authorization of the workspace and the protocol of the access service;
- the header policy, the identity headers and the signature of the identity;
- the cookies of the gateway and the sessions;
- the cross-site guard;
- the limits and the shared state of the replicas;
- the proxying of the requests, the uploads, the answers and the websockets;
- the configuration of the deployment and its reload;
- the secrets of the deployment.

## What is out of scope

- The applications behind the gateway: they are the responsibility of the
  deployment that owns them.
- The identity provider, the access service and the shared state: they are
  dependencies of the gateway, and a problem in one of them is a problem in
  it. The protocol of the access service is published in
  [docs/spec.md](docs/spec.md) §6.1, and its conformance suite is in
  `test/integration/access-conformance.ts`.
- The ingress in front of the gateway: it terminates the TLS and it is
  configured by the deployment.
- A denial of service by a volume of traffic: the gateway bounds the
  resources it uses and the limits of the deployment bound the traffic, but
  a deployment that does not set the limits of §9 of the specification is
  not protected against a flood.
- The runtime of the gateway: the contract of the release names the version
  it needs, and the gateway refuses to start on an older one.

## The rules of the release

- The contract of the gateway is [docs/spec.md](docs/spec.md). A change of
  the behaviour is a change of the contract, and it is recorded there and in
  [CHANGELOG.md](CHANGELOG.md).
- The decisions behind the contract are in
  [docs/decisions.md](docs/decisions.md), with the evidence that led to
  them.
- The identity of the callers is signed with a private key that only the
  gateway holds: an upstream that verifies an identity cannot mint one.
- The access service is asked and the gateway fails closed: without a
  decision, the request is refused.
- The gateway writes the policy it is running in its log, and it names the
  settings that are permissive.

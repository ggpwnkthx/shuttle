# The identity of a request, for an upstream

The gateway writes the identity of the caller into the headers of the
request it forwards, and it signs it. An upstream that wants to be sure
that the request went through the gateway verifies the signature.

The specification is [spec.md](spec.md) §7.1 and §7.4; this document is
the guide for the upstream, with the code.

## The headers

| Header | Value |
| --- | --- |
| `x-shuttle-user` | The subject of the caller. |
| `x-shuttle-email` | The e-mail address of the caller, when it is known. |
| `x-shuttle-roles` | The roles of the caller, separated by commas. |
| `x-shuttle-workspace` | The workspace of the caller, when the route has one. |
| `x-shuttle-signature` | The signature of the identity: `v5=<the compact JWS>`. |

The gateway writes these headers and nothing else does: a client that
sends them has them removed. An upstream that trusts the headers without
verifying the signature trusts the network.

## The key

The gateway holds the **private** key of the deployment and the upstreams
are given the **public** key:

```bash
bun run identity:key              # a new pair
bun run identity:key --public     # the public key of the key in the environment
```

The public key is a PEM of an elliptic curve key on the curve P-256, and
the signature is an `ES256` one. An upstream that verifies an identity
with the public key cannot mint one.

## The verification

The upstream:

1. reads the identity headers and the signature;
2. rebuilds the payload of the signature from the request and from the
   identity headers;
3. rebuilds the compact serialization of the JWS around its own payload —
   the payload of the signature is **detached**, so the middle segment is
   empty and the upstream puts its own payload there;
4. verifies it with the public key.

The payload is a canonical JSON object, and the fields are written in this
order:

```json
{"v":"v5","method":"GET","path":"/v1/assets","query":"?x=1","host":"api.example.com","subject":"user-1","workspaceId":"…","email":"…","roles":["admin","dev"]}
```

| Field | Value |
| --- | --- |
| `v` | The version of the format: `v5`. |
| `method` | The method, upper-cased. |
| `path` | The path **as the upstream received it**: the path the gateway forwarded, after the rewrite of the route (§11.1.1). |
| `query` | The query string as the upstream received it, with its leading `?`. The empty string when there is none. |
| `host` | The effective host, as the gateway wrote it in `x-forwarded-host`, lower-cased. |
| `subject` | The subject of the caller. |
| `workspaceId` | The workspace, or the empty string. |
| `email` | The e-mail of the caller, or the empty string. |
| `roles` | The roles of the caller, sorted ascending. |

The roles are the ones of the header `x-shuttle-roles`: a role that would
make the comma separated list ambiguous is dropped by the gateway, and the
signature covers exactly the roles of the header.

The verification is one call of a standard library. The reference
implementation is in
[examples/upstream-identity/verify.ts](../examples/upstream-identity/verify.ts),
and it is **standalone**: it imports nothing of the gateway.

## The code

### TypeScript

```ts
import { importSPKI } from 'jose'
import { verifyIdentity } from './verify'

const key = await importSPKI(publicKeyPem, 'ES256')

const result = await verifyIdentity({
  request: { method: request.method, path: request.path, query: request.query, host: request.headers['x-forwarded-host'] ?? '' },
  headers: {
    'x-shuttle-user': request.headers['x-shuttle-user'] ?? '',
    'x-shuttle-email': request.headers['x-shuttle-email'],
    'x-shuttle-roles': request.headers['x-shuttle-roles'],
    'x-shuttle-workspace': request.headers['x-shuttle-workspace'],
    'x-shuttle-signature': request.headers['x-shuttle-signature'],
  },
  publicKey: key,
})

if (!result.ok) {
  // The request did not go through the gateway, or it was tampered with.
  return new Response('forbidden', { status: 403 })
}
const identity = result.identity
```

### Go

```go
import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"strings"

	"github.com/go-jose/go-jose/v4"
)

type payload struct {
	V          string   `json:"v"`
	Method     string   `json:"method"`
	Path       string   `json:"path"`
	Query      string   `json:"query"`
	Host       string   `json:"host"`
	Subject    string   `json:"subject"`
	WorkspaceID string  `json:"workspaceId"`
	Email      string   `json:"email"`
	Roles      []string `json:"roles"`
}
```

The payload is rebuilt the same way: the fields in the same order, the
roles sorted, and the values as they are in the headers. The signature is
verified with the public key:

```go
object, err := jose.ParseSigned(signature[3:]) // the part after "v5="
if err != nil { return err }
body, err := object.Verify(key)
```

The `jose` package expects the payload of the JWS, so the detached payload
is put back before the verification: `object.DetachedPayload(canonical)`.

## What to do when the verification fails

The request did not go through the gateway, or it was tampered with. The
upstream refuses it: `403` is the answer that says "the identity of this
request is not one I can trust".

The gateway never sends a request without a signature to an upstream that
asked for one: the signature is written whenever the request carries an
identity. A request that was not authenticated is forwarded without an
identity and without a signature — the route says whether it needs one.

## The versions

| Version | The format | The key |
| --- | --- | --- |
| `v5` | A JWS with a detached payload, signed with `ES256`. | The private key of the deployment; the upstreams hold the public one. |
| `v4` | The same format, signed with `HS256`. | The key that is derived from the secret of the sessions. The upstreams hold it, so an upstream that verifies an identity can mint one as well. |

An upstream that verifies `v4` has to be changed before the gateway signs
`v5`: it reads the version of the value and verifies with the public key
of the deployment.

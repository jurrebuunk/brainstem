# HTTP JSON Destination

Sends each matching Brainstem output event as JSON to an HTTP endpoint.

## Module

```js
"./plugins/http-json/index.mjs"
```

## Example

Send envelopes to the backend API telemetry history:

```js
destinations: [
  {
    module: "./plugins/http-json/index.mjs",
    destination: "default",
    decisions: "all",
    routes: "all",
    sources: "all",
    types: "all",
    config: {
      url: "http://127.0.0.1:5174/api/events"
    }
  }
]
```

Or start the standalone local logging server:

```sh
npm run http-log-server
```

and send to:

```js
config: {
  url: "http://127.0.0.1:8787"
}
```

## Options

```js
url      // required
method   // default: POST
headers  // optional extra request headers
```

## Envelope

The destination POSTs:

```js
{
  version: "1",
  kind: "brainstem.output",
  payload: {
    timestamp,        // when the decision was made
    pollId,
    idempotencyKey,
    decision,
    observation,
    input:       { id, plugin, name, module },
    destination: { id, plugin, name, module }
  }
}
```

Each request carries an `Idempotency-Key` header with the delivery's idempotency key. A retried delivery sends the same key and the same body, so the receiver can drop duplicates.

A non-2xx response fails the delivery, and it is retried with backoff (see [Delivery pipeline](../delivery-pipeline.md)).

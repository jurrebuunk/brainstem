# HTTP JSON Destination

Sends each matching Brainstem output event as JSON to an HTTP endpoint.

## Module

```js
"./plugins/http-json/index.mjs"
```

## Example

Start the local logging server:

```sh
npm run http-log-server
```

Configure the destination:

```js
destinations: [
  {
    module: "./plugins/http-json/index.mjs",
    destination: "default",
    decisions: "all",
    config: {
      url: "http://127.0.0.1:8787"
    }
  }
]
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
    timestamp,
    decision,
    observation,
    input,
    destination
  }
}
```

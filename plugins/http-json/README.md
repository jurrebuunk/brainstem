# @brainstem-dev/plugin-http-json

POST the decision envelope as JSON to a webhook, with an Idempotency-Key.

A [Brainstem](https://github.com/jurrebuunk/brainstem) destination plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-http-json
```

## Use

```js
destinations: [{
  id: "my-http-json",
  module: "@brainstem-dev/plugin-http-json",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/plugins/http-json.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/plugins/http-json.md).

# @brainstem-dev/plugin-http-health

Poll HTTP endpoints and report health changes (status, latency, failures).

A [Brainstem](https://github.com/jurrebuunk/brainstem) input plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-http-health
```

## Use

```js
inputs: [{
  id: "my-http-health",
  module: "@brainstem-dev/plugin-http-health",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/http-health.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/http-health.md).

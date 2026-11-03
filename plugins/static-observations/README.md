# @brainstem-dev/plugin-static-observations

Emit fixed observations from config; for tests and demos.

A [Brainstem](https://github.com/jurrebuunk/brainstem) input plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-static-observations
```

## Use

```js
inputs: [{
  id: "my-static-observations",
  module: "@brainstem-dev/plugin-static-observations",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/plugins/static-observations.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/plugins/static-observations.md).

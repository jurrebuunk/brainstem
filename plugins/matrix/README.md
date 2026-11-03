# @brainstem-dev/plugin-matrix

Notify a Matrix room, with suppression and recovery messages.

A [Brainstem](https://github.com/jurrebuunk/brainstem) destination plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-matrix
```

## Use

```js
destinations: [{
  id: "my-matrix",
  module: "@brainstem-dev/plugin-matrix",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/matrix-destination.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/matrix-destination.md).

# @brainstem-dev/plugin-log-file

Watch a log file and report new matching lines (errors by default).

A [Brainstem](https://github.com/jurrebuunk/brainstem) input plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-log-file
```

## Use

```js
inputs: [{
  id: "my-log-file",
  module: "@brainstem-dev/plugin-log-file",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/plugins/log-file.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/plugins/log-file.md).

# @brainstem-dev/plugin-agentos-runner

Run small bounded agent tasks in an agentOS VM (log triage, issue summaries).

A [Brainstem](https://github.com/jurrebuunk/brainstem) destination plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-agentos-runner
```

## Use

```js
destinations: [{
  id: "my-agentos-runner",
  module: "@brainstem-dev/plugin-agentos-runner",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/plugins/agentos-runner.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/plugins/agentos-runner.md).

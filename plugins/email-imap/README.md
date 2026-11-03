# @brainstem-dev/plugin-email-imap

Read new email over IMAP as observations.

A [Brainstem](https://github.com/jurrebuunk/brainstem) input plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-email-imap
```

## Use

```js
inputs: [{
  id: "my-email-imap",
  module: "@brainstem-dev/plugin-email-imap",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/email-imap.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/email-imap.md).

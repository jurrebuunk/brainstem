# @brainstem-dev/plugin-tls-certificate

Watch TLS certificates and report upcoming expiry.

A [Brainstem](https://github.com/jurrebuunk/brainstem) input plugin.

## Install

```sh
brainstem plugins add @brainstem-dev/plugin-tls-certificate
```

## Use

```js
inputs: [{
  id: "my-tls-certificate",
  module: "@brainstem-dev/plugin-tls-certificate",
  config: { /* see the documentation */ }
}]
```

Configuration and examples: [docs/tls-certificate.md](https://github.com/jurrebuunk/brainstem/blob/main/docs/tls-certificate.md).

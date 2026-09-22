# Email IMAP Input

The Email IMAP input polls an IMAP mailbox and emits new email messages as Brainstem observations.

## Module

```js
"./plugins/email-imap/index.mjs"
```

## Config

```js
inputs: [
  {
    id: "inbox",
    module: "./plugins/email-imap/index.mjs",
    input: "messages",
    config: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      user: "user@example.com",
      passwordEnv: "EMAIL_PASSWORD",
      mailbox: "INBOX",
      startFromNow: true,
      maxMessages: 25,
      timeoutMs: 10000
    }
  }
]
```

## Options

```js
host           // IMAP host
port           // default: 993
secure         // default: true
user           // email account username
passwordEnv    // env var containing password
password       // string or { env: "EMAIL_PASSWORD" }
mailbox        // default: INBOX
startFromNow   // default: true; do not emit old mail on first run
maxMessages    // default: 25 per poll
maxBytes       // default: 8192 snippet bytes
timeoutMs      // default: 10000 connection/socket timeout
```

## Checkpoints

The plugin stores mailbox UID state in the standard input checkpoint system.

On first run with `startFromNow: true`, it records the current mailbox UID and emits no historical email. Future polls emit only messages after that checkpoint.

## Emitted observations

```js
source.type = "email"
type = "message"
state = "new"
```

Observation ID:

```text
email:<user>:<uid>
```

## Matrix routing

To let Brainstem decide which emails are actionable and send those to Matrix:

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: "all",
    sources: ["email"],
    types: ["message"],
    config: {
      homeserver: "https://matrix.example.org",
      roomId: "!roomid:example.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN",
      notify: {
        actionableDecisions: ["queue", "dispatch", "escalate"],
        repeatAfterMs: null,
        onRecovery: false
      }
    }
  }
]
```

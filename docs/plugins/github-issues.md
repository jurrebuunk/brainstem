# GitHub Issues Input

Polls GitHub issues and emits Brainstem observations.

## Module

```js
"./plugins/github-issues/index.mjs"
```

## Config

```js
inputs: [
  {
    id: "github-my-repo-issues",
    module: "./plugins/github-issues/index.mjs",
    input: "issues",
    config: {
      repo: "owner/repo",
      tokenEnv: "GITHUB_TOKEN",
      state: "open",
      perPage: 100
    }
  }
]
```

## Options

```js
repo       // required, owner/repo
state      // default: open
perPage    // default: 100
labels     // optional GitHub labels query
tokenEnv   // env var containing token
token      // string or { env: "GITHUB_TOKEN" }
```

## Emitted observations

```js
source.type = "github"
type = "issue"
state = issue.state
```

Observation ID:

```text
github:<owner/repo>:issue:<number>
```

If an issue has a `security` label, the plugin sets:

```js
facts.minimum_decision = "dispatch"
```

## Tokens

Public repositories may work without a token, but GitHub rate limits are stricter.

For private repositories or higher rate limits, set:

```sh
GITHUB_TOKEN=...
```

and configure:

```js
tokenEnv: "GITHUB_TOKEN"
```

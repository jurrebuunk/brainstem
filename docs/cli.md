# CLI

## Setup

Create local config and environment files:

```sh
cp brainstem.config.example.mjs brainstem.config.mjs
cp .env.example .env
```

`brainstem.config.mjs` and `.env` are local files and should not be committed.

`brainstem.mjs` loads `.env` automatically. Environment variables that are already set in the shell take precedence over values in `.env`.

## Commands

Run continuously:

```sh
npm start
```

Poll each configured input once and exit:

```sh
npm run start:once
```

Poll once and print ignored decisions through log destinations too:

```sh
npm run start:once:all
```

Use a different config file:

```sh
node brainstem.mjs --config ./my.config.mjs --once
```

Override runtime logging:

```sh
node brainstem.mjs --log-level debug --log-format json
```

Log levels: `debug`, `info`, `warn`, `error`, `silent`.

Log formats: `pretty`, `json`.

Show help:

```sh
node brainstem.mjs --help
```

## Tokens

Do not put tokens directly in committed config files. Prefer env references:

```js
config: {
  tokenEnv: "GITHUB_TOKEN"
}
```

or:

```js
config: {
  token: { env: "MATRIX_ACCESS_TOKEN" }
}
```

If a required token is missing, the relevant plugin should fail with a clear error.

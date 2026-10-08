# Brainstem Web

Minimal read-only Brainstem live view.

It runs separately from the Brainstem runtime and receives events over HTTP:

- runtime logs: `brainstem.log`
- destination envelopes: `brainstem.output`

## Run

```sh
npm --prefix web install
npm run web
```

Open:

```text
http://127.0.0.1:5173
```

In another terminal run Brainstem:

```sh
npm start
```

The local `brainstem.config.mjs` is configured to send runtime logs and HTTP JSON destination envelopes to:

```text
http://127.0.0.1:5173/api/events
```

## Notes

This is intentionally read-only. It does not edit Brainstem config and does not run the core.

# Brainstem Docs

Documentation is kept in the repository so it is versioned with the code.

## User docs

- [CLI](cli.md) — commands, config loading, and `.env` behavior.
- [Docker](docker.md) — run Brainstem with Docker or Docker Compose.
- [Configuration](configuration.md) — full config file structure and common examples.
- [Architecture](architecture.md) — how inputs, core, runtime, state, and destinations fit together.
- [State](state.md) — SQLite records and input checkpoints.

## Plugin docs

- [Plugins overview](plugins.md) — all built-in plugins shipped with Brainstem.
- [Input plugin API](input-plugins.md) — how to write input plugins.
- [Destination adapter API](destination-adapters.md) — how to write destination plugins.

Built-in plugin pages:

- [GitHub Issues input](plugins/github-issues.md)
- [HTTP Health input](http-health.md)
- [TLS Certificate input](tls-certificate.md)
- [Static Observations input](plugins/static-observations.md)
- [Log Decisions destination](plugins/log-decisions.md)
- [Matrix destination](matrix-destination.md)

## Maintainer docs

- [Release checklist](release.md)

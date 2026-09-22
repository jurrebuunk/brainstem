# Docker

Brainstem publishes Docker images to GitHub Container Registry:

```text
ghcr.io/jurrebuunk/brainstem
```

## Run with Docker

Create local config and environment files:

```sh
cp brainstem.config.example.mjs brainstem.config.mjs
cp .env.example .env
```

Run once:

```sh
docker run --rm \
  --env-file .env \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs:ro" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.0 \
  node brainstem.mjs --once
```

Run continuously:

```sh
docker run -d \
  --name brainstem \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs:ro" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.0
```

View logs:

```sh
docker logs -f brainstem
```

## Docker Compose

Copy the example compose file:

```sh
cp docker-compose.example.yml docker-compose.yml
```

Start Brainstem:

```sh
docker compose up -d
```

Run once for testing:

```sh
docker compose run --rm brainstem node brainstem.mjs --once --all
```

Stop:

```sh
docker compose down
```

## Volumes

Mount these paths:

```text
/app/brainstem.config.mjs  local config file
/app/data                  SQLite records, checkpoints, notification state
```

Do not bake secrets into the image. Use `.env` or environment variables.

## Build locally

```sh
docker build -t brainstem:local .
```

Then run:

```sh
docker run --rm brainstem:local node brainstem.mjs --help
```

## Published tags

The GitHub Actions workflow publishes:

- `latest` from `main`
- branch tags such as `main`
- git tags such as `v0.1.0-alpha.0`
- SHA tags such as `sha-...`

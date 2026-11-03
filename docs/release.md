# Release checklist

One version for everything: `@brainstem-dev/brainstem`, `@brainstem-dev/sdk`, every `@brainstem-dev/plugin-*`, the Helm chart and the Docker images. A `v*` tag publishes all of them.

## Before

1. Local files must not be staged:

   ```sh
   git status --ignored=matching
   ```

   `brainstem.config.mjs`, `.env`, `data/`, `brainstem-plugins/` and `node_modules/` should be ignored.

2. Run the checks (CI runs them too):

   ```sh
   npm run check
   npm test
   npm run plugin:test           # every plugin package loads; versions match
   npm run test:acceptance       # needs BRAINSTEM_TEST_PG_URL for Postgres
   npm run test:chaos            # Postgres only
   node scripts/npm-smoke.mjs    # publish to a local registry, install, init, poll
   ```

3. Set the version everywhere:

   ```sh
   npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version
   ```

   Then set the app's dependency on `@brainstem-dev/sdk` to `X.Y.Z`, the plugins' `@brainstem-dev/sdk` peer range to `^X.Y.Z` when the plugin API changed, and `version`/`appVersion` in `charts/brainstem/Chart.yaml`. `npm run plugin:test` fails when they disagree.

4. Add the CHANGELOG entry and open the release PR.

## Release

After the PR is merged:

```sh
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
gh release create vX.Y.Z --latest --title vX.Y.Z --notes-file <changelog section>
```

The tag runs:

- **npm** (`.github/workflows/npm.yml`): `scripts/npm-publish.mjs` publishes the SDK, the plugins, then the app, with provenance. Versions already on npm are skipped, so a re-run finishes a partial publish. Prerelease versions (`-rc.1`) get the `next` dist-tag.
- **Docker**: multi-arch images, signed with cosign, plus the models image.
- **Helm chart**: installed on kind, then pushed to `oci://ghcr.io/jurrebuunk/charts`.

Check afterwards:

```sh
npm view @brainstem-dev/brainstem version
npm view @brainstem-dev/plugin-matrix version
helm show chart oci://ghcr.io/jurrebuunk/charts/brainstem --version X.Y.Z
cosign verify ghcr.io/jurrebuunk/brainstem:vX.Y.Z --certificate-identity-regexp 'https://github.com/jurrebuunk/brainstem/' --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`workflow_dispatch` on the npm workflow, with dry-run on, packs everything without publishing.

## npm setup (once)

The packages live in the `@brainstem-dev` npm organization.

1. Two-factor authentication on the npm account (Authorization and Publishing).
2. **First publish of a package:** npmjs.com → Access Tokens → Generate New Token → Granular, read and write on the `@brainstem-dev` organization's packages, short expiry. Store it as the GitHub Actions secret `NPM_TOKEN`.
3. **After the first publish:** on each package's npm page → Settings → Trusted publishing, add GitHub Actions with repository `jurrebuunk/brainstem` and workflow `npm.yml`. Then delete the `NPM_TOKEN` secret and revoke the token. The workflow then publishes through OIDC, with no stored secret.

A new plugin package needs step 2 for its first release (or a manual first `npm publish`), then step 3.

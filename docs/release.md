# Release Checklist

Before publishing an alpha release:

1. Ensure local files are not staged:

   ```sh
   git status --ignored=matching
   ```

   `brainstem.config.mjs`, `.env`, `data/`, and `node_modules/` should be ignored.

2. Run checks:

   ```sh
   npm run check
   npm test
   npm run plugin:test
   ```

3. Inspect the package contents:

   ```sh
   npm pack --dry-run
   ```

4. Verify the version in `package.json` and `CHANGELOG.md`.

5. Create a git tag:

   ```sh
   git tag v0.1.0-alpha.0
   ```

6. Push commit and tag:

   ```sh
   git push
   git push origin v0.1.0-alpha.0
   ```

# Releasing

Publishing to npm is done by the `Release` workflow
(`.github/workflows/release.yml`) when a release is published on GitHub.

## Each release

1. **Version and changelog.** On a branch, set the new version and describe the
   release, then merge to `main`:

   ```bash
   npm version 0.1.1 --no-git-tag-version   # updates package.json and package-lock.json
   ```

   Add a section for it at the top of `CHANGELOG.md`.

2. **Prices.** The package ships a copy of the official price lists of
   Anthropic, OpenAI and Google, and every release should carry current
   prices. The weekly `Pricing` workflow keeps `main` up to date; to be sure,
   run it right before releasing: *Actions > Pricing > Run workflow* on
   `main`. When prices changed, it commits the new lists to `main` — release
   from that commit. The release checks this too and stops if a list is out
   of date.

3. **Release.** On GitHub: *Releases > Draft a new release*, create the tag
   `v0.1.1` (the version from step 1) on `main`, paste the changelog section as
   the description, and publish it. The `Release` workflow then checks that the
   tag matches `package.json`, that the prices are current, and that the type
   check and tests pass — and publishes to npm. Nothing is published if any of
   these fail.

## One-time setup: access to npm

The workflow needs permission to publish `@jovan158/vantage`. Either:

- **Trusted publishing (recommended, no secret to keep).** On npmjs.com, open
  the package's *Settings*, and under *Trusted Publisher* choose *GitHub
  Actions*. Enter `Jovan158` as organization or user, `vantage.ai` as
  repository and `release.yml` as workflow filename; leave the environment
  empty. Under *Allowed actions*, also allow `npm publish` — new entries only
  allow staged publishing otherwise, and the workflow fails. Afterwards, under
  *Publishing access*, *Require two-factor authentication and disallow
  tokens* keeps anyone with a leaked token from publishing.
- **An access token.** On npmjs.com, create a granular access token with read
  and write access to the `@jovan158` scope, and store it in this repository
  under *Settings > Secrets and variables > Actions* as `NPM_TOKEN`.

The first release can also be published by hand from a checkout of `main`:

```bash
npm install
npm login
npm publish
```

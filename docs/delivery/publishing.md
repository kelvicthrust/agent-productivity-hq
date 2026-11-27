# Publish Agent Productivity HQ

## Release with GitHub Actions

The [Release workflow](../../.github/workflows/release.yml) builds both packages on a GitHub-hosted Apple Silicon runner. It runs `pnpm verify` and both package smoke tests, then uploads the tarballs and `SHA256SUMS` to the workflow run. Use **Actions → Release → Run workflow** to build and download these assets without publishing.

### Configure npm once

In npm package settings, add a GitHub Actions [trusted publisher](https://docs.npmjs.com/trusted-publishers/#for-github-actions) for each of `@kelvicthrust/agent-productivity-hq` and `@kelvicthrust/paseo-agent-productivity-hq`. Set the owner to `kelvicthrust`, the repository to `agent-productivity-hq`, and the workflow filename to `release.yml`. Leave the environment blank. Enable **Allow npm publish** and **Allow npm dist-tag**. npm requires the package maintainer's two-factor authentication for these settings. The workflow uses OpenID Connect for publishing.

Configure both publishers when the first new release is ready. Each configuration expires unless it completes its first new publish within two days. A manual build or a comparison with an already published version leaves the configuration unvalidated. [npm expiry rules](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry)

### Prepare a release from labels

Add `release:patch` for a compatible fix, `release:minor` for a compatible feature, or `release:major` for a breaking change to any change PR before merging it into `main`. **Prepare release** uses the highest label on merged PRs since the last published release to maintain one draft PR on `automation/hq-release`. Unlabeled changes can also appear in the draft notes. Use **Actions → Prepare release → Run workflow** on `main` to reconcile labels changed after a PR merged.

Review the version and edit the generated [What's new](#draft-whats-new) file in the draft. The workflow preserves those edits when it refreshes the draft. If GitHub shows **Approve workflows to run**, approve the checks, then mark the PR ready and merge it once **Check release version** passes. GitHub requires **Allow GitHub Actions to create and approve pull requests** in the repository's Actions settings for the draft creation. [GitHub workflow approval](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)

If a higher-labeled change merges ahead of a stale release PR, **Release** blocks the lower version before building or publishing. **Prepare release** queues a correction PR with the higher version. Review and merge that PR to continue.

### Publish a new version

1. In the release PR, check that the stable version matches in `package.json`, `packages/cli/package.json`, `plugins/paseo-agent-productivity/package.json`, and both entries in `plugins/paseo-agent-productivity/package-lock.json`. For a manual release PR, update those versions together and include the matching [What's new](#draft-whats-new) Markdown.
2. Confirm **Check release version** passes before merging the reviewed PR into `main`. The higher version starts the Release workflow and serves as the release signal. Merges that leave the version unchanged skip publication. **Run workflow** still builds archives for testing.
3. Follow the workflow run. It publishes both packages under `next`, verifies the downloaded bytes from npm, promotes both to `latest`, and tags the tested commit. GitHub uses the reviewed Markdown as the release body and attaches it alongside both tarballs and `SHA256SUMS`. A new npm package version can take several minutes to become downloadable after acceptance.

If publishing fails after one package reaches npm, rerun failed jobs to reuse the original artifacts. The workflow reuses a published version only when its integrity matches the original archive. If the artifacts expire or the bytes differ, use a new version. For a GitHub release that already exists, verify its tag and assets before completing it manually.

### Draft What's new

Compare the release candidate with the last published tag. Include relevant changes from PRs
that merged between package version bumps, and check each claim against the candidate. Write for
someone upgrading Agent Productivity HQ or its Paseo plugin. Lead with what they can do now and
where to find it. Include fixes users can recognize and any compatibility changes, upgrade steps,
or known limits that affect them. Link to PRs or guides when they help.

Create `docs/releases/vX.Y.Z.md` with a first heading of `# What's new in vX.Y.Z` using the actual
version. Write a short summary or a few bullets below the heading. Include the file in the
version-bump PR for review. Run `node scripts/check-release-version.ts <previous-package-version>`
from the candidate checkout using the previous app version from `main`. The release check requires
matching notes for version bumps. Manually dispatched build-only runs work without a notes file.

## Manual release

Use this procedure when you need to exercise installed packages on your own Mac and Paseo daemon before promotion. The automated workflow exercises the local archives on its runner and checks the downloads against those tested bytes. Wait for any active release workflow to finish before moving npm tags manually.

### Prepare the GitHub release

1. Use the approved `1.0.0` build from the reviewed commit in the
   [release repository](https://github.com/kelvicthrust/agent-productivity-hq). Record its
   commit SHA and gather these files from the build in one directory:

   - `kelvicthrust-agent-productivity-hq-1.0.0.tgz`
   - `kelvicthrust-paseo-agent-productivity-hq-1.0.0.tgz`
   - `SHA256SUMS` covering both tarballs

2. In that directory, run `shasum -a 256 -c SHA256SUMS` and require both archives to report `OK`.
   Check the packed `package/package.json` in each tarball for its expected scoped name, version
   `1.0.0`, public repository URL, and publishable manifest. Read the exact files with
   `tar -xOf <tarball> package/package.json`. Check that the CLI includes its binary, and that
   the Paseo archive includes its manifest, runtime entries, `npm-shrinkwrap.json`, `OVERVIEW.md`,
   icon and synthetic screenshot. Both carry the dashboard runtime, bundled dependencies and license notices.
3. Open or create the GitHub draft titled **Agent Productivity HQ v1.0.0**. Set `v1.0.0` to the reviewed
   commit SHA and attach the three verified files. For a new release, use its reviewed
   [What's new Markdown](#draft-whats-new) as the release body, include its checksum in
   `SHA256SUMS`, and attach the Markdown file with the archives.
   [GitHub release instructions](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

4. Verify that the [release repository](https://github.com/kelvicthrust/agent-productivity-hq)
   loads in a signed-out session.

Rebuild with `pnpm pack:cli` and `pnpm pack:paseo` on Apple Silicon if the approved source changes.
Use Node.js 26 or newer for the source build and npm 11 on `PATH` to pack the Paseo publication lock.
Publish the generated tarballs from `dist/cli` and `dist/paseo`.

### Publish and verify npm packages

Run these commands from the directory with the verified tarballs. Sign in to npm with publishing
rights for `@kelvicthrust` and confirm `npm whoami` returns the intended account. If
`npm config get @kelvicthrust:registry` shows a scope override, ensure it points to
`https://registry.npmjs.org/`. npm may prompt for a second factor during publication.

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/

npm publish ./kelvicthrust-agent-productivity-hq-1.0.0.tgz \
  --registry=https://registry.npmjs.org/ --access public --tag next
npm publish ./kelvicthrust-paseo-agent-productivity-hq-1.0.0.tgz \
  --registry=https://registry.npmjs.org/ --access public --tag next
```

From a clean test directory containing the approved `SHA256SUMS` but neither tarball, fetch the
published versions from the public registry and compare their bytes with the approved build:

```sh
npm pack @kelvicthrust/agent-productivity-hq@1.0.0 --registry=https://registry.npmjs.org/
npm pack @kelvicthrust/paseo-agent-productivity-hq@1.0.0 --registry=https://registry.npmjs.org/
shasum -a 256 -c SHA256SUMS
```

On a supported test Mac with a fresh account or installation, run the pinned CLI. Open the
printed URL, confirm Setup loads, and stop the test instance. On a test Paseo daemon, install the
exact plugin version. Check that `paseo plugin ls agent-productivity` shows `1.0.0` running, then
open **Agent HQ** and confirm the dashboard loads through the expected private connection.
Put a supported Node.js runtime and its npm on the daemon's `PATH` for npm installation.
Use the [host prerequisites](setup.md#open-agent-hq-from-paseo-desktop) for the daemon.

```sh
npx --yes @kelvicthrust/agent-productivity-hq@1.0.0
npx --yes @kelvicthrust/agent-productivity-hq@1.0.0 stop

paseo plugin install npm:@kelvicthrust/paseo-agent-productivity-hq@1.0.0
paseo plugin ls agent-productivity
```

After both pinned installs pass, promote both versions to `latest` and check that both `latest`
and `next` resolve to `1.0.0` for each package:

```sh
npm dist-tag add @kelvicthrust/agent-productivity-hq@1.0.0 latest --registry=https://registry.npmjs.org/
npm dist-tag add @kelvicthrust/paseo-agent-productivity-hq@1.0.0 latest --registry=https://registry.npmjs.org/
npm dist-tag ls @kelvicthrust/agent-productivity-hq --registry=https://registry.npmjs.org/
npm dist-tag ls @kelvicthrust/paseo-agent-productivity-hq --registry=https://registry.npmjs.org/
```

If one publish succeeds and the other fails, verify the published archive against the approved
checksum before retrying the missing package. npm reserves a package name and version once
published. If the build needs different bytes after `1.0.0` has been published, prepare and
review `1.0.1` with new checksums and a new tag, then repeat the verification before moving the
dist-tags. Preserve the `v1.0.0` tag and any published assets.
[npm publish reference](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
[npm dist-tag guide](https://docs.npmjs.com/adding-dist-tags-to-packages/)

Publish the GitHub draft as the stable release. In a signed-out session, confirm that the
`v1.0.0` release is visible and all its assets download. Verify the tag resolves to the
recorded commit and run `shasum -a 256 -c SHA256SUMS` on the downloaded assets.

## Submit and verify the Paseo listing

1. Open the [Paseo submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml).
   Use **Agent HQ** as the issue title, `npm:@kelvicthrust/paseo-agent-productivity-hq@1.0.0` as
   the source, and **Sidebar** as the primary category. The packed overview, icon and screenshot
   supply the listing content. [Paseo publishing guide](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/publishing.md)
2. Follow the linked review PR. Confirm the record pins the exact npm version and that the
   artifact integrity matches the registry metadata. Supply corrections in the review thread.
   Wait for approval and publication in the [Paseo catalog](https://paseo.sh/plugins).
   [Registry review process](https://github.com/getpaseo/plugins#submit-a-plugin)
3. Check the public listing's title, screenshot, overview, source link and version. On a test
   daemon without the direct npm test install, run `paseo plugin add <owner/slug>` using the
   identifier copied from the listing. Run `paseo plugin ls agent-productivity` to confirm the
   registry source, approved version and running status, then launch **Agent HQ**. Keep the
   manifest's runtime ID `agent-productivity` for lifecycle commands.
4. For later releases, verify the new npm tarball and promote its `latest` tag. Follow the
   registry's automatic bump PR and verify its pin when the catalog updates. On a daemon with
   the registry install, use `paseo plugin update agent-productivity`, approve the reviewed
   version, and verify the installed version and dashboard launch.
   [Paseo plugin commands](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md#cli-reference)

Record the public release URL, checksum results, npm tags, and Paseo
review and listing links. Update the public README with install and uninstall instructions once
the maintainer confirms the published paths work.

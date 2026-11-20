# Publish Agent Productivity HQ

Public product distribution remains on hold pending resolution of the provider-authorization
requirement in the [public release review](public-release-review.md). The maintainer runs this
procedure after that hold is cleared and public release is authorized.

## Prepare the GitHub release

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
   commit SHA and attach the three verified files. Summarize host prerequisites and known limits
   in the notes. Keep the private RC kit in its existing draft. The public skill comes from
   the GitHub repository. [GitHub release instructions](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

4. Once the distribution hold is cleared, make `kelvicthrust/agent-productivity-hq` public
   under **Settings → General → Danger Zone → Change repository visibility**. Verify that
   the source loads in a signed-out session. [GitHub visibility instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)

Rebuild with `pnpm pack:cli` and `pnpm pack:paseo` on Apple Silicon if the approved source changes.
Use Node.js 26 or newer for the source build and npm 11 on `PATH` to pack the Paseo publication lock.
Publish the generated tarballs from `dist/cli` and `dist/paseo`.

## Publish and verify npm packages

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
`v1.0.0` release is visible and all three assets download. Verify the tag resolves to the
recorded commit and run `shasum -a 256 -c SHA256SUMS` on the downloaded assets.

## Verify the public skill

Keep [SKILL.md](../../skills/agent-productivity-hq/SKILL.md) on the public repository's default
branch. From a clean test project on Node.js 22.20.0 or newer, enumerate the repository's skills and install
`agent-productivity-hq` for Claude Code and Codex:

```sh
npx skills add kelvicthrust/agent-productivity-hq --list
npx skills add kelvicthrust/agent-productivity-hq \
  --skill agent-productivity-hq --agent claude-code codex
```

Open a new session in each agent. Invoke `/agent-productivity-hq` in Claude Code and
`$agent-productivity-hq` in Codex. Confirm each invokes the npm launcher and reports the working
local dashboard URL. Search for `agent-productivity-hq` on Skills after indexing. Discovery in
the directory is driven by CLI install telemetry and can lag an independently verified install.
[Skills FAQ](https://www.skills.sh/docs/faq)

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

Record the public release URL, checksum results, npm tags, skill install results, and Paseo
review and listing links. Update the public README with install and uninstall instructions once
the maintainer confirms the published paths work.

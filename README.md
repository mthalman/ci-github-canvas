# ci-github-canvas

A [canvas extension](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions) for the [GitHub Copilot app](https://github.com/github/app) that surfaces a side-panel dashboard of:

1. **Copilot tab** — pull requests currently in scope as Copilot project sessions on this machine, read directly from `~/.copilot/data.db`.
2. **All my PRs tab** — every open pull request you authored across GitHub, with their **Azure Pipelines** check status grouped by build, deep-linked into each AzDO job log.
3. **Watched tab** — a manually curated list of any GitHub PRs (yours or not) you want to keep an eye on. Paste a PR URL to start tracking its CI; remove with the ✕ button. Watched PRs participate in the failure / completion notifier the same way authored PRs do.

PRs that appear in both tabs get an `in session` badge in the "All my PRs" view so you can see at a glance which of your open PRs already have a Copilot session waiting on them.

## Requirements

- The [GitHub Copilot app](https://github.com/github/app)
- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth status`).

## Install

User-scoped install (works across all your Copilot projects). Canvas
extensions live under `~/.copilot/extensions` for user scope, or
`.github/extensions` if you want to commit a team-shared copy into a
repo. This extension is a multi-file layout (`extension.mjs` +
`lib/*.mjs`), so make sure you copy the whole folder, not just
`extension.mjs`:

```powershell
# From the directory containing this README
$dest = "$env:USERPROFILE\.copilot\extensions\ci-runs"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item .\extension.mjs $dest -Force
Copy-Item .\lib           $dest -Recurse -Force
```

### Install from this repo via the CLI tool

Install this extension from Copilot CLI with this prompt:

> install the canvas extension from https://github.com/mthalman/ci-github-canvas as `ci-runs`

## Local development

If you're working on this extension, the copy-on-every-change loop above gets
annoying fast. Use the dev-link script instead — it creates a symlink from the
Copilot extensions directory back to this repo so your edits are picked up by
the next `extensions_reload` (or session restart):

```powershell
pwsh .\install-dev-link.ps1
```

Edit `extension.mjs` (the thin canvas-wiring shell) or any module under
`lib/` in the repo, then ask the agent to **reload extensions**. No file
copy step.

To remove the symlink:

```powershell
pwsh .\uninstall-dev-link.ps1
```

> **Windows note:** creating symbolic links without elevation requires
> Developer Mode (Settings &rarr; For developers). Without it, run the install
> script from an elevated PowerShell prompt.

### Tests

Unit tests for everything under `lib/` live in `test/` and use Node's
built-in test runner — no `npm install` step. With Node 24+:

```powershell
npm test
# or, equivalently:
node --test test/*.test.mjs
```

CI runs the same command on push and pull-request via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) across Linux, macOS,
and Windows on Node 24 and 25.

## Usage

Ask the agent something like:

> show me my PR CI runs

The agent will open the `ci-runs` canvas in a side panel. From there:

- Click `↻ Refresh` to re-read the local session DB and re-query GitHub.
- Click the AzDO build link to open the run in `dev.azure.com`.
- Expand `show jobs` on a build to see per-job status with deep links to each job log.

## Limitations

- **Schema drift**: the GitHub Copilot app's `data.db` schema is internal and may change between app versions. The SQL queries fail gracefully and surface the error in the panel.
- **No deep-link into a Copilot session**: the GitHub Copilot app does not expose a URL scheme, so the "Copilot tab" links to the PR on GitHub rather than the session itself.

## License

MIT — see [LICENSE](./LICENSE).

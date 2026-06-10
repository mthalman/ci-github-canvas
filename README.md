# ci-github-canvas

A [GitHub Copilot CLI](https://github.com/github/copilot-cli) canvas extension that surfaces a side-panel dashboard of:

1. **Copilot tab** — pull requests currently in scope as Copilot project sessions on this machine, read directly from `~/.copilot/data.db`.
2. **All my PRs tab** — every open pull request you authored across GitHub, with their **Azure Pipelines** check status grouped by build, deep-linked into each AzDO job log.

PRs that appear in both tabs get an `in session` badge in the "All my PRs" view so you can see at a glance which of your open PRs already have a Copilot session waiting on them.

## Requirements

- GitHub Copilot CLI / desktop app (extension API).
- The bundled Copilot runtime ships Node 24+, which provides the experimental `node:sqlite` module used here — **no `npm install` step is needed**.
- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth status`).

## Install

User-scoped (works across all your Copilot projects). The extension is a
multi-file layout (`extension.mjs` + `lib/*.mjs`), so make sure you copy
the whole folder, not just `extension.mjs`:

```powershell
# From the directory containing this README
$dest = "$env:USERPROFILE\.copilot\extensions\ci-runs"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item .\extension.mjs $dest -Force
Copy-Item .\lib           $dest -Recurse -Force
```

Then, inside any Copilot CLI session, reload extensions:

> /reload-extensions

or just restart the session.

### Install from this repo via the CLI tool

If you've published this folder to a GitHub repo, anyone can install with:

```
install_extension({
  url:   "https://github.com/<owner>/ci-github-canvas",
  scope: "user",
  name:  "ci-runs"
})
```

`install_extension` clones the whole repo (including the `lib/` folder), so
this works for the multi-file layout.

> **Note on `share_extension`:** the `share_extension` tool publishes the
> extension folder as a flat GitHub gist, which can't represent
> subdirectories. The `lib/` modules would be silently dropped, so
> `share_extension` is no longer a supported install path for this extension.
> Use `install_extension` with the repo URL above instead.

## Local development

If you're hacking on this extension, the copy-on-every-change loop above gets
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

> show me my PR pipelines

The agent will open the `ci-runs` canvas in a side panel. From there:

- Click `↻ Refresh` to re-read the local session DB and re-query GitHub.
- Click the AzDO build link to open the run in `dev.azure.com`.
- Expand `show jobs` on a build to see per-job status with deep links to each job log.

## Architecture

```
┌───────────────────────────────────────────┐
│  extension.mjs  (thin SDK-wiring shell)   │
│  - joinSession({ canvases: [...] })       │
│  - canvas.open() → startServer() per panel│
│  - host-side notify poll loop             │
└───────────────────────────────────────────┘
             │ imports
             ▼
┌───────────────────────────────────────────┐
│  lib/                                     │
│   constants.mjs   TTLs, regexes, paths    │
│   page.mjs        single-page HTML/JS UI  │
│   sessions.mjs    node:sqlite → data.db   │
│   github.mjs      spawn `gh api graphql`  │
│   azdo.mjs        AzDO timeline fetch     │
│   gha.mjs         GHA check-run summary   │
│   git-sync.mjs    worktree sync badges    │
│   notify.mjs      run-completion / fail   │
│                   alerts via session.send │
│   server.mjs      127.0.0.1 HTTP routes   │
└───────────────────────────────────────────┘
```

- **Sessions** come from `~/.copilot/data.db` (`workspaces` + `workspace_repo_contexts` + `workspace_pr_sync_status` tables), opened read-only via `node:sqlite`.
- **PRs + check runs** come from a single GraphQL request (`gh api graphql`) for `author:@me state:open is:pr`. Results are cached for 90 seconds.
- **Azure Pipelines runs** are identified by matching the `detailsUrl` of each check run against `dev.azure.com/<org>/.../_build/results?buildId=N` or `<org>.visualstudio.com/...`. Runs are grouped by `buildId` so a multi-leg pipeline collapses to one card. This URL-based approach is **resilient to SAML enforcement** on GitHub's `app` field.

## Limitations

- **PR scope**: caps at 50 open PRs (GraphQL node-budget). Pagination would be needed for users with more open PRs.
- **No CI write actions yet**: re-run / cancel are not implemented. (Adding them needs either `gh api ... -X POST` for GH Actions or `az pipelines runs` for AzDO.)
- **Schema drift**: the Copilot desktop app's `data.db` schema is internal and may change between app versions. The SQL queries fail gracefully and surface the error in the panel.
- **No deep-link into a Copilot session**: the desktop app does not expose a URL scheme, so the "Copilot tab" links to the PR on GitHub rather than the session itself.

## License

MIT — see [LICENSE](./LICENSE).

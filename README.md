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

User-scoped (works across all your Copilot projects):

```powershell
# From the directory containing this README
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.copilot\extensions\pr-pipelines" | Out-Null
Copy-Item .\extension.mjs "$env:USERPROFILE\.copilot\extensions\pr-pipelines\extension.mjs" -Force
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
  name:  "pr-pipelines"
})
```

## Usage

Ask the agent something like:

> show me my PR pipelines

The agent will open the `pr-pipelines` canvas in a side panel. From there:

- Click `↻ Refresh` to re-read the local session DB and re-query GitHub.
- Click the AzDO build link to open the run in `dev.azure.com`.
- Expand `show jobs` on a build to see per-job status with deep links to each job log.

## Architecture

```
┌──────────────────────────────────┐
│  extension.mjs (forked process)  │
│                                  │
│  joinSession({ canvases: [...] })│
│           │                      │
│   canvas.open()                  │
│           │                      │
│   ▼                              │
│   local HTTP server (ephemeral   │
│   port on 127.0.0.1)             │
│           │                      │
│   ├── /api/sessions  ──► node:sqlite ──► ~/.copilot/data.db
│   └── /api/prs-with-checks ──► spawn `gh api graphql` ──► GitHub
│                                  │
│   ▼                              │
│   single-page dashboard (vanilla │
│   HTML/JS, no framework)         │
└──────────────────────────────────┘
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

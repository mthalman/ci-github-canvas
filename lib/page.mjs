// PAGE_HTML constant: the full single-page dashboard served by the in-process
// HTTP server. Plain HTML/CSS/JS, no framework or build step. All template-
// literal interpolation tokens that appear inside the string are escaped
// (backslash-dollar-brace) so they stay verbatim inside the page's own
// <script> tag rather than being interpolated by Node when this module loads.
export const PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>CI Runs</title>
  <style>
    /* ------------------------------------------------------------------ *
     * Design tokens. The canvas iframe is cross-origin so we can't read   *
     * the host's CSS variables; instead we mirror GitHub Primer's         *
     * light/dark palettes and switch on prefers-color-scheme. Every       *
     * visual color resolves through a token so the panel reskins cleanly  *
     * when the system theme changes.                                      *
     * ------------------------------------------------------------------ */
    :root {
      color-scheme: light dark;
      /* Light mode (Primer light) */
      --canvas-default:  #ffffff;
      --canvas-subtle:   #f6f8fa;
      --canvas-inset:    #eef1f4;
      --fg-default:      #1f2328;
      --fg-muted:        #59636e;
      --fg-subtle:       #818b98;
      --border-default:  #d1d9e0;
      --border-muted:    #d8dee4;
      --accent-fg:       #0969da;
      --accent-emphasis: #0969da;
      --success-fg:      #1a7f37;
      --attention-fg:    #9a6700;
      --danger-fg:       #d1242f;
      --done-fg:         #8250df;
      --neutral-fg:      #59636e;

      --radius:     12px;
      --radius-sm:  8px;
      --radius-pill: 999px;
      --shadow-sm:  0 1px 2px rgba(31, 35, 40, 0.05);
      --shadow-md:  0 6px 18px rgba(31, 35, 40, 0.10);
      --shadow-pop: 0 16px 40px rgba(31, 35, 40, 0.20);
      --row-hover:  #f9fafb;
      --header-bg:  rgba(255, 255, 255, 0.78);
      --ease:       cubic-bezier(0.4, 0, 0.2, 1);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --canvas-default:  #0d1117;
        --canvas-subtle:   #161b22;
        --canvas-inset:    #010409;
        --fg-default:      #f0f6fc;
        --fg-muted:        #9198a1;
        --fg-subtle:       #6e7681;
        --border-default:  #3d444d;
        --border-muted:    #2a2f37;
        --accent-fg:       #4493f7;
        --accent-emphasis: #1f6feb;
        --success-fg:      #3fb950;
        --attention-fg:    #d29922;
        --danger-fg:       #f85149;
        --done-fg:         #a371f7;
        --neutral-fg:      #9198a1;

        --shadow-sm:  0 1px 2px rgba(1, 4, 9, 0.4);
        --shadow-md:  0 8px 22px rgba(1, 4, 9, 0.55);
        --shadow-pop: 0 18px 44px rgba(1, 4, 9, 0.7);
        --row-hover:  #1a2029;
        --header-bg:  rgba(13, 17, 23, 0.72);
      }
    }

    * { box-sizing: border-box; }

    body {
      font: 13.5px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      margin: 0;
      padding: 0 1rem 1.5rem;
      background:
        radial-gradient(1200px 400px at 100% -10%, color-mix(in srgb, var(--accent-fg) 7%, transparent), transparent 70%),
        var(--canvas-subtle);
      color: var(--fg-default);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    /* ---- Header: sticky, frosted, with a brand mark ---- */
    header {
      position: sticky;
      top: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0 -1rem 0.85rem;
      padding: 0.85rem 1rem 0.7rem;
      background: var(--header-bg);
      backdrop-filter: saturate(1.6) blur(12px);
      -webkit-backdrop-filter: saturate(1.6) blur(12px);
      border-bottom: 1px solid var(--border-muted);
    }
    .brand { display: flex; align-items: center; gap: 0.55rem; flex: 1; min-width: 0; }
    .brand-mark {
      flex: 0 0 auto;
      width: 1.6rem; height: 1.6rem;
      border-radius: 8px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 0.95rem;
      color: #fff;
      background: linear-gradient(135deg, var(--accent-fg), var(--done-fg));
      box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255,255,255,0.25);
    }
    .brand-text { display: flex; flex-direction: column; line-height: 1.1; min-width: 0; }
    h1 { margin: 0; font-size: 0.98rem; font-weight: 650; letter-spacing: -0.01em; }
    .brand-sub { font-size: 0.68rem; color: var(--fg-subtle); font-weight: 500; }

    /* ---- Toolbar icon buttons ---- */
    .icon-btn {
      cursor: pointer;
      background: none;
      border: 1px solid transparent;
      color: var(--fg-muted);
      padding: 0;
      border-radius: 8px;
      font: inherit;
      font-size: 1.05rem;
      line-height: 1;
      width: 2.1rem; height: 2.1rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s var(--ease), color 0.15s var(--ease), border-color 0.15s var(--ease), transform 0.15s var(--ease);
    }
    .icon-btn:hover { background: var(--canvas-subtle); border-color: var(--border-muted); color: var(--fg-default); }
    .icon-btn:active { transform: scale(0.94); }
    .icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .icon-btn[aria-expanded="true"] { background: var(--canvas-subtle); border-color: var(--border-muted); color: var(--fg-default); }
    #refresh.spinning span { display: inline-block; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Settings popover ---- */
    .menu-anchor { position: relative; display: inline-flex; }
    .menu {
      position: absolute;
      top: calc(100% + 0.4rem);
      right: 0;
      z-index: 50;
      min-width: 240px;
      max-height: 70vh;
      overflow-y: auto;
      padding: 0.4rem;
      background: var(--canvas-default);
      border: 1px solid var(--border-default);
      border-radius: 12px;
      box-shadow: var(--shadow-pop);
      display: flex;
      flex-direction: column;
      transform-origin: top right;
      animation: pop 0.13s var(--ease);
    }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
    .menu[hidden] { display: none; }
    .menu-section { display: flex; flex-direction: column; padding: 0.15rem 0; }
    .menu-section-label {
      padding: 0.35rem 0.55rem 0.3rem;
      font-size: 0.68rem;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--fg-subtle);
    }
    .menu-divider { border: none; border-top: 1px solid var(--border-muted); margin: 0.2rem 0.1rem; }
    .menu-item {
      display: grid;
      grid-template-columns: 1.1rem 1fr;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.55rem;
      background: none;
      border: none;
      color: var(--fg-default);
      font: inherit;
      font-size: 0.83rem;
      text-align: left;
      cursor: pointer;
      border-radius: 8px;
      width: 100%;
      transition: background 0.12s var(--ease);
    }
    .menu-item:hover { background: var(--canvas-subtle); }
    .menu-item:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: -2px; }
    .menu-item:disabled { opacity: 0.6; cursor: not-allowed; }
    .menu-check {
      display: inline-flex; width: 1rem; height: 1rem;
      align-items: center; justify-content: center;
      font-size: 0.66rem; color: transparent;
      border-radius: 5px;
      border: 1.5px solid var(--border-default);
      background: transparent;
      transition: background 0.12s var(--ease), border-color 0.12s var(--ease), color 0.12s var(--ease);
    }
    .menu-item[aria-checked="true"] .menu-check {
      background: var(--accent-emphasis);
      border-color: var(--accent-emphasis);
      color: #fff;
    }

    /* ---- Segmented-control tabs ---- */
    .tabs {
      display: inline-flex;
      gap: 0.15rem;
      padding: 0.25rem;
      margin-bottom: 0.9rem;
      background: var(--canvas-inset);
      border: 1px solid var(--border-muted);
      border-radius: var(--radius-pill);
    }
    .tab {
      padding: 0.32rem 0.85rem;
      cursor: pointer;
      border: none;
      background: none;
      color: var(--fg-muted);
      font: inherit;
      font-size: 0.82rem;
      font-weight: 550;
      border-radius: var(--radius-pill);
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      transition: background 0.18s var(--ease), color 0.18s var(--ease), box-shadow 0.18s var(--ease);
    }
    .tab:hover { color: var(--fg-default); }
    .tab.active {
      background: var(--canvas-default);
      color: var(--fg-default);
      font-weight: 650;
      box-shadow: var(--shadow-sm);
    }
    .tab .count {
      color: var(--fg-subtle);
      font-size: 0.72rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .tab.active .count { color: var(--accent-fg); }

    .panel { display: none; animation: fade 0.2s var(--ease); }
    .panel.active { display: block; }
    @keyframes fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

    /* ---- PR row cards ---- */
    ul.list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
    li.row {
      border: 1px solid var(--border-muted);
      border-radius: var(--radius);
      padding: 0.7rem 0.85rem;
      background: var(--canvas-default);
      box-shadow: var(--shadow-sm);
      transition: border-color 0.18s var(--ease), box-shadow 0.18s var(--ease), transform 0.18s var(--ease);
    }
    li.row:hover {
      border-color: color-mix(in srgb, var(--accent-fg) 35%, var(--border-default));
      box-shadow: var(--shadow-md);
    }
    .row-head { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; font-size: 0.85rem; }
    .row-title { font-weight: 600; margin-top: 0.3rem; letter-spacing: -0.005em; line-height: 1.4; }
    .row-meta { color: var(--fg-muted); font-size: 0.76rem; margin-top: 0.25rem; }

    /* ---- Badges & repo label ---- */
    .project, .repo, .badge { padding: 0.05rem 0.4rem; border-radius: var(--radius-pill); font-size: 0.7rem; }
    .project { background: var(--canvas-subtle); font-size: 0.75rem; }
    .repo {
      color: var(--fg-muted);
      font-size: 0.78rem;
      font-weight: 550;
      background: none;
      padding: 0;
    }
    a.repo-link, .row-head > a:not(.badge) { color: var(--accent-fg); font-weight: 600; font-variant-numeric: tabular-nums; }
    .badge {
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 650;
      font-size: 0.64rem;
      padding: 0.1rem 0.45rem;
      border: 1px solid transparent;
      line-height: 1.5;
    }
    /* Badge fills derive from their fg token via color-mix so the tint tracks
       the hue across theme switches. */
    .badge.draft   { background: color-mix(in srgb, var(--neutral-fg)   16%, transparent); color: var(--neutral-fg);   border-color: color-mix(in srgb, var(--neutral-fg)   30%, transparent); }
    .badge.session { background: color-mix(in srgb, var(--attention-fg) 16%, transparent); color: var(--attention-fg); border-color: color-mix(in srgb, var(--attention-fg) 35%, transparent); }
    .badge.closed  { background: color-mix(in srgb, var(--danger-fg)    16%, transparent); color: var(--danger-fg);    border-color: color-mix(in srgb, var(--danger-fg)    32%, transparent); }
    .badge.merged  { background: color-mix(in srgb, var(--done-fg)      16%, transparent); color: var(--done-fg);      border-color: color-mix(in srgb, var(--done-fg)      32%, transparent); }
    .badge.sync-up_to_date { background: color-mix(in srgb, var(--success-fg)   13%, transparent); color: var(--success-fg);   border-color: color-mix(in srgb, var(--success-fg)   30%, transparent); }
    .badge.sync-behind     { background: color-mix(in srgb, var(--attention-fg) 16%, transparent); color: var(--attention-fg); border-color: color-mix(in srgb, var(--attention-fg) 35%, transparent); }
    .badge.sync-ahead      { background: color-mix(in srgb, var(--accent-fg)    16%, transparent); color: var(--accent-fg);    border-color: color-mix(in srgb, var(--accent-fg)    32%, transparent); }
    .badge.sync-diverged   { background: color-mix(in srgb, var(--danger-fg)    16%, transparent); color: var(--danger-fg);    border-color: color-mix(in srgb, var(--danger-fg)    32%, transparent); }
    a.badge.session:hover { text-decoration: none; filter: brightness(1.05); }

    /* ---- CI groups (Azure Pipelines / GitHub Actions) ---- */
    .azdo {
      margin-top: 0.55rem;
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      padding: 0.5rem 0.6rem;
      background: var(--canvas-subtle);
      border: 1px solid var(--border-muted);
      border-radius: var(--radius-sm);
    }
    .azdo + .azdo { margin-top: 0.4rem; }
    .azdo-build { display: flex; flex-direction: column; gap: 0.15rem; }
    .azdo-line { display: flex; gap: 0.4rem; align-items: center; font-size: 0.79rem; flex-wrap: wrap; }
    .azdo-line strong { font-weight: 650; letter-spacing: -0.005em; }
    .azdo-line .label { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
    .azdo-line .count-fail { color: var(--danger-fg); font-weight: 600; }
    .azdo-line .count-progress { color: var(--attention-fg); font-weight: 600; }
    .azdo-line .count-skip { color: var(--fg-subtle); }
    .azdo-line .ci-counts { display: inline-flex; align-items: center; gap: 0.6rem; }

    /* ---- Status dots with a soft halo ---- */
    .ci-dot {
      width: 0.6rem; height: 0.6rem;
      border-radius: 50%;
      display: inline-block;
      flex: 0 0 auto;
    }
    .ci-dot.success     { background: var(--success-fg); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success-fg) 18%, transparent); }
    .ci-dot.failure     { background: var(--danger-fg);  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger-fg) 18%, transparent); }
    .ci-dot.in_progress { background: var(--attention-fg); box-shadow: 0 0 0 3px color-mix(in srgb, var(--attention-fg) 20%, transparent); animation: pulse 1.5s ease-in-out infinite; }
    .ci-dot.skipped     { background: transparent; box-shadow: inset 0 0 0 2px var(--fg-subtle); }
    .ci-dot.other       { background: var(--neutral-fg); box-shadow: 0 0 0 3px color-mix(in srgb, var(--neutral-fg) 16%, transparent); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

    .toggle { cursor: pointer; background: none; border: none; color: var(--accent-fg); font: inherit; font-size: 0.8rem; padding: 0; }
    .toggle:hover { text-decoration: underline; }

    details.azdo-jobs { margin-top: 0.3rem; }
    details.azdo-jobs summary {
      cursor: pointer;
      list-style: none; user-select: none;
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.1rem 0.15rem; border-radius: 5px;
      width: fit-content;
    }
    details.azdo-jobs summary::-webkit-details-marker { display: none; }
    details.azdo-jobs summary::before { content: '▸'; font-size: 0.95rem; line-height: 1; color: var(--fg-muted); transition: transform 0.15s var(--ease); }
    details.azdo-jobs[open] summary::before { transform: rotate(90deg); }
    details.azdo-jobs summary:hover { background: var(--row-hover); }
    /* Inline rows (skipped pipelines / non-workflow checks have no expander):
       pad + spacer so their name aligns with the caret-indented group names. */
    .azdo-line.azdo-flush { padding: 0.1rem 0.15rem; gap: 0.3rem; }
    .azdo-flush .caret-spacer { width: 0.62rem; flex: none; }
    details.azdo-jobs ul { list-style: none; padding-left: 0.95rem; margin: 0.3rem 0 0; display: flex; flex-direction: column; gap: 0.1rem; }
    details.azdo-jobs li { font-size: 0.79rem; padding: 0.12rem 0; display: flex; gap: 0.4rem; align-items: center; }
    details.azdo-jobs li .label { color: var(--fg-subtle); }
    .azdo-timeline { margin: 0.3rem 0 0; }
    .azdo-timeline .tl-fallback-note { color: var(--attention-fg); font-size: 0.7rem; padding: 0.2rem 0; }
    .azdo-timeline .tl-loading { color: var(--fg-muted); font-size: 0.74rem; padding: 0.2rem 0; }
    .azdo-timeline .tl-error { color: var(--danger-fg); font-size: 0.74rem; padding: 0.2rem 0; white-space: pre-wrap; }

    /* ---- Collapsible PR rows ---- */
    li.row-collapsible { padding: 0; overflow: hidden; }
    li.row-collapsible > details > summary {
      cursor: pointer; list-style: none;
      padding: 0.7rem 0.85rem;
      display: flex; gap: 0.55rem; align-items: flex-start;
      transition: background 0.15s var(--ease);
    }
    li.row-collapsible > details > summary:hover { background: var(--row-hover); }
    li.row-collapsible > details > summary::-webkit-details-marker { display: none; }
    li.row-collapsible > details > summary::marker { content: ''; }
    li.row-collapsible .caret {
      flex: 0 0 auto; color: var(--fg-subtle); font-size: 0.62rem; line-height: 1.7;
      transition: transform 0.18s var(--ease);
      transform: rotate(0deg);
      width: 0.7rem;
    }
    li.row-collapsible > details[open] > summary .caret { transform: rotate(90deg); }
    li.row-collapsible .row-summary-content { flex: 1 1 auto; min-width: 0; }
    li.row-collapsible > details > .row-body { padding: 0 0.85rem 0.75rem 2.1rem; }
    li.row-collapsible .ci-dot.overall { width: 0.7rem; height: 0.7rem; margin-left: auto; }

    a { color: var(--accent-fg); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ---- Empty / error / loading states ---- */
    .empty, .error, .loading {
      color: var(--fg-muted);
      padding: 2.5rem 1rem;
      text-align: center;
      font-size: 0.85rem;
    }
    .loading { color: var(--fg-subtle); }
    .loading::before {
      content: '';
      display: block;
      width: 1.4rem; height: 1.4rem;
      margin: 0 auto 0.6rem;
      border: 2px solid var(--border-default);
      border-top-color: var(--accent-fg);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    .empty {
      border: 1px dashed var(--border-default);
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--canvas-default) 60%, transparent);
    }
    .error {
      color: var(--danger-fg);
      text-align: left;
      white-space: pre-wrap;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.78rem;
      padding: 0.7rem 0.85rem;
      background: color-mix(in srgb, var(--danger-fg) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent);
      border-radius: var(--radius-sm);
      margin-bottom: 0.5rem;
    }

    /* ---- Watched tab: add form + remove affordance ---- */
    .watched-add { display: flex; gap: 0.5rem; margin-bottom: 0.65rem; }
    .watched-add input[type="url"] {
      flex: 1 1 auto;
      min-width: 0;
      padding: 0.5rem 0.7rem;
      font: inherit;
      font-size: 0.83rem;
      color: var(--fg-default);
      background: var(--canvas-default);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
    }
    .watched-add input[type="url"]::placeholder { color: var(--fg-subtle); }
    .watched-add input[type="url"]:focus {
      outline: none;
      border-color: var(--accent-fg);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-fg) 22%, transparent);
    }
    .watched-add-btn {
      cursor: pointer;
      padding: 0.5rem 1rem;
      font: inherit;
      font-size: 0.83rem;
      font-weight: 600;
      color: #fff;
      background: var(--accent-emphasis);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      transition: filter 0.15s var(--ease), transform 0.12s var(--ease);
    }
    .watched-add-btn:hover { filter: brightness(1.08); }
    .watched-add-btn:active { transform: scale(0.97); }
    .watched-add-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .watched-error {
      color: var(--danger-fg);
      font-size: 0.8rem;
      padding: 0.45rem 0.6rem;
      margin-bottom: 0.5rem;
      background: color-mix(in srgb, var(--danger-fg) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent);
      border-radius: var(--radius-sm);
    }
    .watched-remove {
      cursor: pointer;
      background: none;
      border: 1px solid transparent;
      color: var(--fg-subtle);
      font: inherit;
      font-size: 0.82rem;
      line-height: 1;
      padding: 0.2rem 0.4rem;
      border-radius: 6px;
      transition: background 0.15s var(--ease), color 0.15s var(--ease), border-color 0.15s var(--ease);
    }
    .watched-remove:hover { background: color-mix(in srgb, var(--danger-fg) 16%, transparent); color: var(--danger-fg); border-color: color-mix(in srgb, var(--danger-fg) 35%, transparent); }
  </style>

</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">◎</span>
      <span class="brand-text">
        <h1>CI Runs</h1>
        <span class="brand-sub">Pull request CI at a glance</span>
      </span>
    </div>
    <button type="button" class="icon-btn" id="refresh" title="Refresh"><span aria-hidden="true">↻</span></button>
    <div class="menu-anchor">
      <button type="button" class="icon-btn" id="settings-btn"
              aria-expanded="false" aria-haspopup="true" aria-controls="settings-menu"
              title="Settings">
        <span aria-hidden="true">⚙</span>
      </button>
      <div class="menu" id="settings-menu" role="menu" aria-label="CI Runs settings" hidden>
        <div class="menu-section" role="group" aria-label="Notifications">
          <div class="menu-section-label">Notifications</div>
          <button type="button" class="menu-item" id="opt-completion" role="menuitemcheckbox" aria-checked="false">
            <span class="menu-check" aria-hidden="true">✓</span>
            <span class="menu-text">Notify on run completion</span>
          </button>
          <button type="button" class="menu-item" id="opt-failure" role="menuitemcheckbox" aria-checked="false">
            <span class="menu-check" aria-hidden="true">✓</span>
            <span class="menu-text">Notify on job failure</span>
          </button>
        </div>
      </div>
    </div>
  </header>
  <div class="tabs">
    <button class="tab active" data-tab="copilot" title="Pull requests currently open as Copilot project sessions on this machine">Copilot<span class="count" id="copilot-count"></span></button>
    <button class="tab" data-tab="all" title="Every open pull request you authored across GitHub">All my PRs<span class="count" id="all-count"></span></button>
    <button class="tab" data-tab="watched" title="PRs you've manually added by URL to keep an eye on.">Watched<span class="count" id="watched-count"></span></button>
  </div>
  <div class="panel active" id="panel-copilot"><div class="loading">Loading…</div></div>
  <div class="panel" id="panel-all"><div class="loading">Loading…</div></div>
  <div class="panel" id="panel-watched">
    <form class="watched-add" id="watched-add">
      <input type="url" id="watched-url" placeholder="https://github.com/owner/repo/pull/123" autocomplete="off" required />
      <button type="submit" class="watched-add-btn">Add</button>
    </form>
    <div class="watched-error" id="watched-error" hidden></div>
    <div id="watched-list" class="loading">Loading…</div>
  </div>

  <script>
    const esc = (s) => s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    // Allow-list URL schemes for anchor hrefs. esc() stops attribute breakout
    // but does NOT neutralize a "javascript:"/"data:"/"vbscript:" URL, so a
    // hostile value reaching an href would still execute on click. Restrict to
    // http(s)/mailto and collapse anything else to an inert "#".
    const safeUrl = (u) => {
      if (u == null) return '#';
      const s = String(u).trim();
      return /^(https?:|mailto:)/i.test(s) ? s : '#';
    };

    const syncTooltips = {
      'up_to_date': 'Local session matches its tracked upstream (as of the last fetch)',
      'behind':     'Tracked upstream has commits not in your local branch (as of the last fetch)',
      'ahead':      'Local branch has commits not yet pushed to its tracked upstream (as of the last fetch)',
      'diverged':   'Local and upstream have diverged with different commits (as of the last fetch)',
    };

    const overallCiTooltips = {
      success: 'All CI checks passed',
      failure: 'One or more CI checks failed',
      in_progress: 'CI checks are running',
      skipped: 'CI checks were skipped',
      other: 'CI checks in an unknown or mixed state',
    };

    // Combine GHA + AzDO summaries into a single worst-wins state.
    function overallCiState(gha, azdo) {
      const states = [];
      if (gha?.hasAny)  states.push(gha.summary.overall);
      if (azdo?.hasAny) states.push(azdo.summary.overall);
      if (!states.length) return null;
      if (states.includes('failure'))     return 'failure';
      if (states.includes('in_progress')) return 'in_progress';
      if (states.includes('other'))       return 'other';
      if (states.includes('success'))     return 'success';
      return 'skipped';
    }

    // Build a PR row that's collapsible when CI is present. Default-open unless
    // every check has passed. prKey (e.g. owner/repo#123) gives the details
    // element a stable identity so open/closed state survives auto-refresh
    // re-renders via snapshotPrRowState/restorePrRowState.
    function renderPrRow({ headerHtml, titleHtml, metaHtml, gha, azdo, prKey, trailingHtml }) {
      const overall = overallCiState(gha, azdo);
      const overallDot = overall
        ? \`<span class="ci-dot \${overall} overall" title="\${esc(overallCiTooltips[overall] ?? '')}"></span>\`
        : '';
      const trailing = trailingHtml ?? '';
      const head = \`<div class="row-head">\${headerHtml}\${overallDot}\${trailing}</div>\`;
      const title = \`<div class="row-title">\${titleHtml}</div>\`;
      const meta = metaHtml ? \`<div class="row-meta">\${metaHtml}</div>\` : '';
      if (!overall) {
        return \`<li class="row">\${head}\${title}\${meta}</li>\`;
      }
      const openAttr = overall === 'success' ? '' : 'open';
      const keyAttr = prKey ? \` data-pr-key="\${esc(prKey)}"\` : '';
      const body = \`\${renderGha(gha)}\${renderAzdo(azdo)}\`;
      return \`<li class="row row-collapsible"><details\${keyAttr} \${openAttr}>
        <summary>
          <span class="caret">▶</span>
          <div class="row-summary-content">\${head}\${title}\${meta}</div>
        </summary>
        <div class="row-body">\${body}</div>
      </details></li>\`;
    }

    // Common sort key so both tabs order PRs identically: PR updatedAt (from
    // GitHub) descending, falling back to the local workspace updated_at when
    // the live PR data isn't joined in (e.g. CI fetch failed).
    function prSortTime(row) {
      const t = row._liveUpdatedAt ?? row.updatedAt ?? row.updated_at;
      const ms = t ? Date.parse(t) : NaN;
      return Number.isFinite(ms) ? ms : 0;
    }
    function sortByUpdatedDesc(rows) {
      return [...rows].sort((a, b) => prSortTime(b) - prSortTime(a));
    }

    function renderCopilot(rows) {
      if (!rows.length) return '<div class="empty">No active Copilot sessions with PRs.</div>';
      return '<ul class="list">' + sortByUpdatedDesc(rows).map(s => {
        const num   = s.source_pr_number ?? s.created_pr_number;
        const url   = s.source_pr_html_url ?? s.created_pr_html_url;
        const repo  = s.repo_full_name ?? s.created_pr_repo ?? '(unknown repo)';
        const title = s._liveTitle ?? s.source_pr_title ?? '(untitled)';
        const head  = s.source_pr_head_ref ? \`\${esc(s.source_pr_head_ref)} → \${esc(s.source_pr_base_ref ?? '')}\` : esc(s.branch ?? '');
        const draftBadge = s._liveDraft ? '<span class="badge draft" title="This PR is still in draft">draft</span>' : '';
        const syncBadge  = s.sync_state ? \`<span class="badge sync-\${esc(s.sync_state)}" title="\${esc(syncTooltips[s.sync_state] ?? '')}">\${esc(s.sync_state.replace(/_/g,' '))}</span>\` : '';
        const link = url ? \`<a href="\${esc(safeUrl(url))}" target="_blank" rel="noopener">#\${esc(num)}</a>\` : (num ? \`#\${esc(num)}\` : '');
        const sessionInfo = s._taskUrl
          ? \`<a class="badge session" href="\${esc(safeUrl(s._taskUrl))}" target="_blank" rel="noopener" title="Open this session on github.com">session ↗</a>\`
          : (s.workspace_id ? \`<span class="badge session" title="Workspace ID: \${esc(s.workspace_id)}">session</span>\` : '');
        const updated = s._liveUpdatedAt ? \`updated \${new Date(s._liveUpdatedAt).toLocaleString()}\` : '';
        const meta = [head, updated].filter(Boolean).join(' · ');
        const prKey = repo && num ? (repo + '#' + num).toLowerCase() : null;
        return renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span>\${link}\${draftBadge}\${syncBadge}\${sessionInfo}\`,
          titleHtml: esc(title),
          metaHtml: '',
          gha: s._gha,
          azdo: s._azdo,
          prKey,
        });
      }).join('') + '</ul>';
    }

    function runStatusLabel(r) {
      if (r.status !== 'COMPLETED') return (r.status || 'pending').toLowerCase().replace(/_/g,' ');
      if (r.conclusion === 'NEUTRAL' || r.conclusion === 'SKIPPED') return 'skipped';
      return (r.conclusion || 'unknown').toLowerCase().replace(/_/g,' ');
    }
    function runDotClass(r) {
      if (r.status !== 'COMPLETED') return 'in_progress';
      if (r.conclusion === 'NEUTRAL' || r.conclusion === 'SKIPPED') return 'skipped';
      if (r.conclusion === 'SUCCESS') return 'success';
      if (r.conclusion === 'FAILURE' || r.conclusion === 'TIMED_OUT' || r.conclusion === 'STARTUP_FAILURE' || r.conclusion === 'ACTION_REQUIRED') return 'failure';
      return 'other';
    }

    // Order jobs so failures surface first, then alphabetically by name.
    // classFn maps an entry to its ci-dot class ('failure' | ...). Works for
    // both GitHub check-run objects (runDotClass) and AzDO timeline records.
    function sortJobsByFailureThenName(arr, classFn) {
      return (arr || []).slice().sort((a, b) => {
        const fa = classFn(a) === 'failure' ? 0 : 1;
        const fb = classFn(b) === 'failure' ? 0 : 1;
        if (fa !== fb) return fa - fb;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
    }

    // Display name for an AzDO build group: the pipeline name. AzDO check-run
    // names look like "<pipeline> (<job>)" (plus a bare "<pipeline>" parent
    // check), so stripping the trailing "(...)" job suffix and de-duping yields
    // the pipeline name. Used for both real builds and definition-only groups.
    function azdoBuildName(b) {
      const bases = [...new Set((b.runs || [])
        .map(r => (r.name || '').replace(/\\s*\\([^()]*\\)\\s*$/, '').trim())
        .filter(Boolean))];
      return bases.length === 1 ? bases[0] : (bases[0] || 'Azure Pipelines');
    }
    function renderAzdo(azdo) {
      if (!azdo || !azdo.hasAny) return '';
      const s = azdo.summary;
      const overallDot = '<span class="ci-dot ' + s.overall + '"></span>';
      const counts = [
        s.success     ? \`<span title="passed">✓ \${s.success}</span>\` : '',
        s.failure     ? \`<span title="failed" class="count-fail">✕ \${s.failure}</span>\` : '',
        s.inProgress  ? \`<span title="in progress" class="count-progress">⟳ \${s.inProgress}</span>\` : '',
        s.skipped     ? \`<span title="skipped" class="count-skip">⊘ \${s.skipped}</span>\` : '',
        s.other       ? \`<span title="other">· \${s.other}</span>\` : '',
      ].filter(Boolean).join(' ');
      const buildLines = azdo.builds.map(b => {
        const ghJobs = sortJobsByFailureThenName(b.runs, runDotClass).map(r => \`<li><span class="ci-dot \${runDotClass(r)}"></span><a href="\${esc(safeUrl(r.detailsUrl))}" target="_blank" rel="noopener">\${esc(r.name)}</a> <span class="label">\${esc(runStatusLabel(r))}</span></li>\`).join('');
        // Definition-only group (no buildId): the pipeline never produced a
        // build, so its check run IS the pipeline-level status (e.g. the whole
        // pipeline was skipped). There are no real jobs to expand, so show the
        // status inline and omit the job count + "show jobs" expander.
        if (!b.buildId) {
          const r = b.runs[0];
          const statusInline = r
            ? \`<span class="ci-dot \${runDotClass(r)}"></span><span class="label">\${esc(runStatusLabel(r))}</span>\`
            : '';
          const linkUrl = b.githubUrl || b.summaryUrl;
          return \`<div class="azdo-build">
            <div class="azdo-line azdo-flush"><span class="caret-spacer"></span><a href="\${esc(safeUrl(linkUrl))}" target="_blank" rel="noopener">\${esc(azdoBuildName(b))}</a> \${statusInline}</div>
          </div>\`;
        }
        const label = \`<a href="\${esc(safeUrl(b.summaryUrl))}" target="_blank" rel="noopener">\${esc(azdoBuildName(b))}</a>\`;
        // The <details> block is timeline-capable when we have org+project+buildId.
        // Inner content starts as the GitHub-derived list (immediate fallback);
        // on first open, the lazy loader replaces it with the live AzDO timeline.
        // If the AzDO call fails the loader puts the fallback list back with an
        // explanatory note.
        const timelineAttrs = (b.org && b.project && b.buildId)
          ? \` data-tl-org="\${esc(b.org)}" data-tl-project="\${esc(b.project)}" data-tl-build-id="\${esc(b.buildId)}" data-tl-summary-url="\${esc(b.summaryUrl)}"\`
          : '';
        const jobsKey = \`azdo:\${esc(b.org || '')}|\${esc(b.buildId || azdoBuildName(b))}\`;
        return \`<div class="azdo-build">
          <details class="azdo-jobs" data-jobs-key="\${jobsKey}"\${timelineAttrs}><summary><span class="azdo-line">\${label} <span class="label">· \${b.runs.length} job\${b.runs.length === 1 ? '' : 's'}</span></span></summary><div class="azdo-jobs-content"><ul>\${ghJobs}</ul></div></details>
        </div>\`;
      }).join('');
      return \`<div class="azdo">
        <div class="azdo-line">\${overallDot}<strong>Azure Pipelines</strong> <span class="label ci-counts">\${counts}</span></div>
        \${buildLines}
      </div>\`;
    }

    function renderGha(gha) {
      if (!gha || !gha.hasAny) return '';
      const s = gha.summary;
      const overallDot = '<span class="ci-dot ' + s.overall + '"></span>';
      const counts = [
        s.success     ? \`<span title="passed">✓ \${s.success}</span>\` : '',
        s.failure     ? \`<span title="failed" class="count-fail">✕ \${s.failure}</span>\` : '',
        s.inProgress  ? \`<span title="in progress" class="count-progress">⟳ \${s.inProgress}</span>\` : '',
        s.skipped     ? \`<span title="skipped" class="count-skip">⊘ \${s.skipped}</span>\` : '',
        s.other       ? \`<span title="other">· \${s.other}</span>\` : '',
      ].filter(Boolean).join(' ');
      // Mirror AzDO: one card per workflow with an expandable job list.
      // Standalone GitHub App checks (license/cla, etc.) have no workflow, so
      // they render inline with their status, like definition-only AzDO builds.
      const workflows = gha.workflows || (gha.runs ? [{ name: 'GitHub Actions', url: null, isWorkflow: true, runs: gha.runs }] : []);
      const wfLines = workflows.map(w => {
        const jobs = sortJobsByFailureThenName(w.runs, runDotClass).map(r => \`<li><span class="ci-dot \${runDotClass(r)}"></span><a href="\${esc(safeUrl(r.detailsUrl))}" target="_blank" rel="noopener">\${esc(r.name)}</a> <span class="label">\${esc(runStatusLabel(r))}</span></li>\`).join('');
        if (!w.isWorkflow) {
          const r = w.runs[0];
          const statusInline = r
            ? \`<span class="ci-dot \${runDotClass(r)}"></span><span class="label">\${esc(runStatusLabel(r))}</span>\`
            : '';
          const linkUrl = (r && r.detailsUrl) || w.url || '#';
          return \`<div class="azdo-build">
            <div class="azdo-line azdo-flush"><span class="caret-spacer"></span><a href="\${esc(safeUrl(linkUrl))}" target="_blank" rel="noopener">\${esc(w.name)}</a> \${statusInline}</div>
          </div>\`;
        }
        const label = w.url
          ? \`<a href="\${esc(safeUrl(w.url))}" target="_blank" rel="noopener">\${esc(w.name)}</a>\`
          : \`<span>\${esc(w.name)}</span>\`;
        return \`<div class="azdo-build">
          <details class="azdo-jobs" data-jobs-key="gha:\${esc(w.name)}"><summary><span class="azdo-line">\${label} <span class="label">· \${w.runs.length} job\${w.runs.length === 1 ? '' : 's'}</span></span></summary><div class="azdo-jobs-content"><ul>\${jobs}</ul></div></details>
        </div>\`;
      }).join('');
      return \`<div class="azdo">
        <div class="azdo-line">\${overallDot}<strong>GitHub Actions</strong> <span class="label ci-counts">\${counts}</span></div>
        \${wfLines}
      </div>\`;
    }

    function renderAll(prs, sessionIndex) {
      const withChecks = sortByUpdatedDesc(prs.filter(p => p.azdo?.hasAny || p.gha?.hasAny));
      if (!withChecks.length) return '<div class="empty">No open PRs with CI checks.</div>';
      return '<ul class="list">' + withChecks.map(p => {
        const repo = p.repository.nameWithOwner;
        const key  = (repo + '#' + p.number).toLowerCase();
        const session = sessionIndex.get(key);
        const draft = p.isDraft ? '<span class="badge draft" title="This PR is still in draft">draft</span>' : '';
        const sessionBadge = session
          ? (session._taskUrl
              ? \`<a class="badge session" href="\${esc(safeUrl(session._taskUrl))}" target="_blank" rel="noopener" title="Open this session on github.com">session ↗</a>\`
              : \`<span class="badge session" title="A Copilot session is open for this PR (workspace \${esc(session.workspace_id)})">session</span>\`)
          : '';
        const syncBadge = session?.sync_state ? \`<span class="badge sync-\${esc(session.sync_state)}" title="\${esc(syncTooltips[session.sync_state] ?? '')}">\${esc(session.sync_state.replace(/_/g,' '))}</span>\` : '';
        const head = session?.source_pr_head_ref ? \`\${esc(session.source_pr_head_ref)} → \${esc(session.source_pr_base_ref ?? '')}\` : '';
        const updated = new Date(p.updatedAt).toLocaleString();
        const meta = [head, \`updated \${updated}\`].filter(Boolean).join(' · ');
        return renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span><a href="\${esc(safeUrl(p.url))}" target="_blank" rel="noopener">#\${esc(p.number)}</a>\${draft}\${syncBadge}\${sessionBadge}\`,
          titleHtml: esc(p.title),
          metaHtml: '',
          gha: p.gha,
          azdo: p.azdo,
          prKey: key,
        });
      }).join('') + '</ul>';
    }

    // Watched tab. Rows look like "All my PRs" but each carries an ✕ button
    // anchored to the right that posts DELETE /api/watched. Items present in
    // the persisted list but missing from the checks response (e.g. private
    // repo, deleted PR, GraphQL error) still render so the user can see and
    // remove them.
    function renderWatched(items, rowsByKey) {
      if (!items.length) {
        return '<div class="empty">No watched PRs yet. Paste a GitHub PR URL above to start tracking its CI.</div>';
      }
      // Sort: PRs with live CI/updatedAt info by updated desc, then the rest
      // by addedAt desc so unseen entries surface predictably.
      const enriched = items.map(it => ({ item: it, row: rowsByKey.get(it.key) ?? null }));
      enriched.sort((a, b) => {
        const ta = a.row ? prSortTime(a.row) : Date.parse(a.item.addedAt) || 0;
        const tb = b.row ? prSortTime(b.row) : Date.parse(b.item.addedAt) || 0;
        return tb - ta;
      });
      return '<ul class="list">' + enriched.map(({ item, row }) => {
        const repo = row?.repository?.nameWithOwner ?? \`\${item.owner}/\${item.repo}\`;
        const removeBtn = \`<button type="button" class="watched-remove" data-watch-key="\${esc(item.key)}" title="Stop watching this PR" aria-label="Stop watching">✕</button>\`;
        if (!row) {
          // No live PR data — show a placeholder row so the user can still
          // remove it. Could be a private repo, a deleted PR, or a temporary
          // GraphQL failure.
          const removeFloating = \`<button type="button" class="watched-remove" data-watch-key="\${esc(item.key)}" title="Stop watching this PR" aria-label="Stop watching" style="margin-left:auto">✕</button>\`;
          return \`<li class="row"><div class="row-head"><span class="repo">\${esc(repo)}</span><a href="\${esc(safeUrl(item.url))}" target="_blank" rel="noopener">#\${esc(item.number)}</a><span class="badge draft">unavailable</span>\${removeFloating}</div><div class="row-meta">Couldn't load this PR (private repo, deleted, or GraphQL failure)</div></li>\`;
        }
        const draft = row.isDraft ? '<span class="badge draft" title="This PR is still in draft">draft</span>' : '';
        const updated = row.updatedAt ? \`updated \${new Date(row.updatedAt).toLocaleString()}\` : '';
        const meta = [updated].filter(Boolean).join(' · ');
        return renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span><a href="\${esc(safeUrl(row.url))}" target="_blank" rel="noopener">#\${esc(row.number)}</a>\${draft}\`,
          titleHtml: esc(row.title),
          metaHtml: meta,
          gha: row.gha,
          azdo: row.azdo,
          prKey: item.key,
          trailingHtml: removeBtn,
        });
      }).join('') + '</ul>';
    }

    let lastSessions = [];
    let lastChecks = [];

    // Avoid flashing on auto-refresh: only touch the DOM when the freshly
    // rendered HTML for a panel actually differs from what's already shown.
    // Most 60s polls produce identical markup, so this skips the teardown/
    // repaint (and avatar image reloads) entirely when nothing changed.
    const __panelHtmlCache = new Map();
    function applyPanelHtml(el, html) {
      if (!el) return false;
      const key = el.id || el;
      if (__panelHtmlCache.get(key) === html) return false;
      __panelHtmlCache.set(key, html);
      el.innerHTML = html;
      return true;
    }

    async function loadCopilot() {
      const res = await fetch('/api/sessions').then(r => r.json());
      if (res.error) {
        applyPanelHtml(document.getElementById('panel-copilot'), \`<div class="error">\${esc(res.error)}</div>\`);
        document.getElementById('copilot-count').textContent = '';
        lastSessions = [];
        return;
      }
      lastSessions = res.rows;
      // Cross-reference CI data from the checks cache and task URLs from the tasks API
      const [checksRes, tasksRes] = await Promise.all([
        fetch('/api/prs-with-checks').then(r => r.json()),
        fetch('/api/tasks').then(r => r.json()),
      ]);
      lastChecks = checksRes.rows ?? [];
      const ciIndex = new Map();
      for (const p of lastChecks) {
        const key = (p.repository.nameWithOwner + '#' + p.number).toLowerCase();
        ciIndex.set(key, p);
      }
      const taskMap = new Map(Object.entries(tasksRes.tasks ?? {}));
      // Attach CI data and remote task URL to each session row
      const enriched = res.rows.map(s => {
        const prNum = s.source_pr_number ?? s.created_pr_number;
        const repo = s.repo_full_name ?? s.created_pr_repo;
        const key = repo && prNum ? (repo + '#' + prNum).toLowerCase() : null;
        const ci = key ? ciIndex.get(key) : null;
        const taskId = s.session_id ? taskMap.get(s.session_id) : null;
        const taskUrl = taskId && repo ? \`https://github.com/\${repo}/tasks/\${taskId}\` : null;
        return { ...s, _gha: ci?.gha ?? null, _azdo: ci?.azdo ?? null, _liveTitle: ci?.title ?? s._liveTitle ?? null, _liveUpdatedAt: ci?.updatedAt ?? null, _liveDraft: ci?.isDraft ?? s._liveDraft ?? false, _taskUrl: taskUrl };
      });
      // Stash the task map on the session rows for renderAll cross-reference
      window.__taskMap = taskMap;
      const html = renderCopilot(enriched);
      const el = document.getElementById('panel-copilot');
      if (__panelHtmlCache.get('panel-copilot') !== html) {
        const openTimelines = snapshotOpenAzdoTimelines();
        const prRowState = snapshotPrRowState();
        applyPanelHtml(el, html);
        restorePrRowState(prRowState);
        restoreOpenAzdoTimelines(openTimelines);
      }
      document.getElementById('copilot-count').textContent = ' (' + res.rows.length + ')';
    }

    async function loadAll(force=false) {
      const res = await fetch('/api/prs-with-checks' + (force ? '?force=1' : '')).then(r => r.json());
      const sessionIndex = new Map();
      const taskMap = window.__taskMap ?? new Map();
      for (const s of lastSessions) {
        const taskId = s.session_id ? taskMap.get(s.session_id) : null;
        const repoForTask = s.repo_full_name ?? s.created_pr_repo;
        const taskUrl = taskId && repoForTask ? \`https://github.com/\${repoForTask}/tasks/\${taskId}\` : null;
        const enriched = { ...s, _taskUrl: taskUrl };
        if (s.repo_full_name && s.source_pr_number)  sessionIndex.set((s.repo_full_name + '#' + s.source_pr_number).toLowerCase(), enriched);
        if (s.created_pr_repo && s.created_pr_number) sessionIndex.set((s.created_pr_repo + '#' + s.created_pr_number).toLowerCase(), enriched);
      }
      const errorBanner = res.error ? \`<div class="error">\${esc(res.error)}</div>\` : '';
      const html = errorBanner + renderAll(res.rows ?? [], sessionIndex);
      const el = document.getElementById('panel-all');
      if (__panelHtmlCache.get('panel-all') !== html) {
        const openTimelines = snapshotOpenAzdoTimelines();
        const prRowState = snapshotPrRowState();
        applyPanelHtml(el, html);
        restorePrRowState(prRowState);
        restoreOpenAzdoTimelines(openTimelines);
      }
      const visibleCount = (res.rows ?? []).filter(p => p.azdo?.hasAny || p.gha?.hasAny).length;
      document.getElementById('all-count').textContent = res.rows ? ' (' + visibleCount + ')' : '';
    }

    async function loadWatched(force=false) {
      const list = document.getElementById('watched-list');
      const res = await fetch('/api/watched' + (force ? '?force=1' : '')).then(r => r.json());
      const items = res.items ?? [];
      const rowsByKey = new Map();
      for (const r of res.rows ?? []) {
        if (!r?.repository?.nameWithOwner || !r.number) continue;
        rowsByKey.set((r.repository.nameWithOwner + '#' + r.number).toLowerCase(), r);
      }
      const errorBanner = res.error ? \`<div class="error">\${esc(res.error)}</div>\` : '';
      const html = errorBanner + renderWatched(items, rowsByKey);
      list.classList.remove('loading');
      if (__panelHtmlCache.get('watched-list') !== html) {
        const openTimelines = snapshotOpenAzdoTimelines();
        const prRowState = snapshotPrRowState();
        applyPanelHtml(list, html);
        restorePrRowState(prRowState);
        restoreOpenAzdoTimelines(openTimelines);
      }
      document.getElementById('watched-count').textContent = items.length ? ' (' + items.length + ')' : '';
    }

    function showWatchedError(msg) {
      const el = document.getElementById('watched-error');
      if (!msg) { el.hidden = true; el.textContent = ''; return; }
      el.textContent = msg;
      el.hidden = false;
    }

    document.getElementById('watched-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('watched-url');
      const url = input.value.trim();
      if (!url) return;
      showWatchedError('');
      const btn = e.submitter ?? e.target.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/watched', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showWatchedError(body.error || 'Failed to add PR.');
        } else if (body.error) {
          // Already-watched case: server returns 200 + error message + item.
          showWatchedError(body.error);
        } else {
          input.value = '';
        }
        await loadWatched(true);
      } catch (err) {
        showWatchedError(String(err?.message ?? err));
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // Delegated handler for the per-row ✕ button. Inside a <summary> a button
    // click toggles the surrounding <details> by default; preventDefault +
    // stopPropagation keep the click from collapsing/expanding the row.
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('.watched-remove');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset.watchKey;
      if (!key) return;
      btn.disabled = true;
      try {
        const res = await fetch('/api/watched?key=' + encodeURIComponent(key), { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showWatchedError(body.error || 'Failed to remove PR.');
        } else {
          showWatchedError('');
        }
        await loadWatched(true);
      } catch (err) {
        showWatchedError(String(err?.message ?? err));
        btn.disabled = false;
      }
    });

    // ---- AzDO timeline (real per-job status from dev.azure.com REST API) ----
    //
    // Each <details class="azdo-jobs"> for a build with a known org/project/buildId
    // is timeline-capable. On open we lazy-load /api/azdo-timeline and replace
    // the GitHub-check-run fallback list inside .azdo-jobs-content with the
    // real AzDO record tree (stages → phases → jobs → tasks).
    //
    // Open-state survives the 60s auto-refresh: snapshotOpenAzdoTimelines() is
    // called before each panel re-render, and restoreOpenAzdoTimelines() reopens
    // matching details after the new DOM is in place and triggers a fresh load.

    // Stable per-group key for open-state persistence across refreshes. Every
    // job <details> (AzDO build or GHA workflow) carries data-jobs-key; we
    // prefix it with the owning PR-row key so identically-named workflows in
    // different PRs (e.g. two "CI" workflows) don't collide.
    function azdoTimelineKey(detailsEl) {
      const local = detailsEl.dataset.jobsKey;
      if (!local) return null;
      const prRow = detailsEl.closest('details[data-pr-key]');
      const prefix = prRow && prRow.dataset.prKey ? \`\${prRow.dataset.prKey}|\` : '';
      return prefix + local;
    }

    function snapshotOpenAzdoTimelines() {
      const keys = new Set();
      document.querySelectorAll('details.azdo-jobs[open]').forEach(d => {
        const k = azdoTimelineKey(d);
        if (k) keys.add(k);
      });
      return keys;
    }

    function restoreOpenAzdoTimelines(keys) {
      if (!keys || keys.size === 0) return;
      document.querySelectorAll('details.azdo-jobs').forEach(d => {
        const k = azdoTimelineKey(d);
        if (k && keys.has(k)) {
          d.open = true;
          // Only AzDO builds have a live timeline to re-fetch; GHA workflows
          // keep their static job list, so just reopening them is enough.
          if (d.dataset.tlBuildId) loadAzdoTimeline(d, { force: true });
        }
      });
    }

    // Snapshot/restore the open/closed state of every PR-row <details> by key.
    // Without this, the 60s auto-refresh (and the manual Refresh button) wipes
    // the user's manual collapse/expand and forces every row back to the
    // default-open-unless-all-checks-passed state.
    function snapshotPrRowState() {
      const state = new Map();
      document.querySelectorAll('details[data-pr-key]').forEach(d => {
        state.set(d.dataset.prKey, d.open);
      });
      return state;
    }

    function restorePrRowState(state) {
      if (!state || state.size === 0) return;
      document.querySelectorAll('details[data-pr-key]').forEach(d => {
        if (state.has(d.dataset.prKey)) d.open = state.get(d.dataset.prKey);
      });
    }

    function tlDotClass(state, result) {
      if (state !== 'completed') return 'in_progress';
      if (result === 'skipped') return 'skipped';
      if (result === 'succeeded') return 'success';
      if (result === 'failed' || result === 'abandoned') return 'failure';
      return 'other';
    }
    function tlStatusLabel(state, result) {
      if (state !== 'completed') return (state || 'pending').toLowerCase();
      return (result || 'unknown').toLowerCase();
    }

    function renderTimelineJobs(records, summaryUrl) {
      if (!records || records.length === 0) {
        return '<div class="tl-loading">No timeline records yet — build may still be queuing.</div>';
      }
      // AzDO timelines contain Stage / Phase / Job / Task / Checkpoint records.
      // We only show Job records (Stage/Phase context dropped for parity with
      // the GHA list), ordered so failures surface first, then by name.
      const jobs = sortJobsByFailureThenName(
        records.filter(r => r.type === 'Job'),
        r => tlDotClass(r.state, r.result),
      );
      if (jobs.length === 0) {
        return '<div class="tl-loading">No job records yet — build may still be queuing.</div>';
      }
      // Build the AzDO web logs URL from the build summary URL by stripping
      // any pre-existing view/job query params we may have inherited.
      const baseLog = summaryUrl
        ? summaryUrl.replace(/&view=[^&]*/g, '').replace(/&j=[^&]*/g, '').replace(/&t=[^&]*/g, '')
        : null;
      return '<ul>' + jobs.map(r => {
        const dot = tlDotClass(r.state, r.result);
        const label = tlStatusLabel(r.state, r.result);
        const href = baseLog ? \`\${baseLog}&view=logs&j=\${encodeURIComponent(r.id)}\` : null;
        const nameHtml = href
          ? \`<a href="\${esc(safeUrl(href))}" target="_blank" rel="noopener">\${esc(r.name)}</a>\`
          : esc(r.name);
        return \`<li><span class="ci-dot \${dot}"></span>\${nameHtml} <span class="label">\${esc(label)}</span></li>\`;
      }).join('') + '</ul>';
    }

    // Per-details guard to avoid overlapping requests for the same panel.
    const tlInflight = new WeakSet();

    async function loadAzdoTimeline(detailsEl, { force = false } = {}) {
      if (tlInflight.has(detailsEl)) return;
      const org = detailsEl.dataset.tlOrg;
      const project = detailsEl.dataset.tlProject;
      const buildId = detailsEl.dataset.tlBuildId;
      const summaryUrl = detailsEl.dataset.tlSummaryUrl;
      if (!org || !project || !buildId) return;
      const content = detailsEl.querySelector('.azdo-jobs-content');
      if (!content) return;
      // Preserve the initial GitHub-check-run fallback once, so we can restore
      // it on error. Cached on the element so re-renders see fresh fallback.
      if (content.dataset.fallbackHtml == null) {
        content.dataset.fallbackHtml = content.innerHTML;
      }
      if (!force && detailsEl.dataset.tlLoaded === '1') return;
      tlInflight.add(detailsEl);
      const wrapper = document.createElement('div');
      wrapper.className = 'azdo-timeline';
      wrapper.innerHTML = '<div class="tl-loading">Loading Azure DevOps timeline…</div>';
      content.replaceChildren(wrapper);
      try {
        const params = new URLSearchParams({ org, project, buildId });
        if (force) params.set('force', '1');
        const res = await fetch('/api/azdo-timeline?' + params.toString()).then(r => r.json());
        if (!detailsEl.isConnected) return;
        if (res.error || !res.data) {
          // Show the error AND keep the GitHub check-run list visible so the
          // user still sees something useful (e.g. private-org builds where
          // anonymous access is blocked).
          wrapper.innerHTML = \`<div class="tl-error">\${esc(res.error || 'Failed to load timeline')}</div>
            <div class="tl-fallback-note">Showing GitHub check-run jobs instead:</div>
            \${content.dataset.fallbackHtml}\`;
        } else {
          wrapper.innerHTML = renderTimelineJobs(res.data.records, summaryUrl);
          detailsEl.dataset.tlLoaded = '1';
        }
      } catch (e) {
        if (!detailsEl.isConnected) return;
        wrapper.innerHTML = \`<div class="tl-error">\${esc(e.message)}</div>
          <div class="tl-fallback-note">Showing GitHub check-run jobs instead:</div>
          \${content.dataset.fallbackHtml}\`;
      } finally {
        tlInflight.delete(detailsEl);
      }
    }

    // Delegated toggle listener — every azdo-jobs details element on the page
    // triggers a lazy load when first opened.
    document.addEventListener('toggle', (e) => {
      const el = e.target;
      if (el && el.matches && el.matches('details.azdo-jobs') && el.open) {
        loadAzdoTimeline(el);
      }
    }, true);

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + btn.dataset.tab));
      });
    });
    document.getElementById('refresh').addEventListener('click', async () => {
      const btn = document.getElementById('refresh');
      btn.classList.add('spinning');
      btn.disabled = true;
      try {
        await loadCopilot();
        await loadAll(true);
        await loadWatched(true);
      } finally {
        btn.classList.remove('spinning');
        btn.disabled = false;
      }
    });

    // Settings menu — Copilot "Changes" canvas-style popover anchored to the
    // gear icon. Two independent checkboxes; both off means no notifications.
    // The on-disk config is { notifyOnRunCompletion, notifyOnJobFailure } —
    // both booleans, mirrored here.
    const settingsBtn = document.getElementById('settings-btn');
    const settingsMenu = document.getElementById('settings-menu');
    const optCompletion = document.getElementById('opt-completion');
    const optFailure = document.getElementById('opt-failure');
    let currentConfig = { notifyOnRunCompletion: false, notifyOnJobFailure: false };

    function sanitizeCfg(c) {
      return {
        notifyOnRunCompletion: !!(c && c.notifyOnRunCompletion),
        notifyOnJobFailure: !!(c && c.notifyOnJobFailure),
      };
    }
    function syncMenu() {
      optCompletion.setAttribute('aria-checked', currentConfig.notifyOnRunCompletion ? 'true' : 'false');
      optFailure.setAttribute('aria-checked', currentConfig.notifyOnJobFailure ? 'true' : 'false');
    }
    function openMenu()  { settingsMenu.hidden = false; settingsBtn.setAttribute('aria-expanded', 'true'); }
    function closeMenu() { settingsMenu.hidden = true;  settingsBtn.setAttribute('aria-expanded', 'false'); }

    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsMenu.hidden ? openMenu() : closeMenu();
    });
    // Clicks inside the menu shouldn't trigger the document-level close.
    settingsMenu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (!settingsMenu.hidden) closeMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !settingsMenu.hidden) {
        closeMenu();
        settingsBtn.focus();
      }
    });

    async function loadNotifyConfig() {
      try {
        const res = await fetch('/api/notify-config');
        const body = await res.json();
        if (body && body.config) {
          currentConfig = sanitizeCfg(body.config);
          syncMenu();
        }
      } catch (e) {
        console.error('failed to load notify config', e);
      }
    }
    async function saveNotifyConfig() {
      try {
        await fetch('/api/notify-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentConfig),
        });
      } catch (e) {
        console.error('failed to save notify config', e);
      }
    }

    // The two toggles are independent; leave the menu open so the user can
    // flip both without reopening.
    optCompletion.addEventListener('click', () => {
      currentConfig.notifyOnRunCompletion = !currentConfig.notifyOnRunCompletion;
      syncMenu();
      saveNotifyConfig();
    });
    optFailure.addEventListener('click', () => {
      currentConfig.notifyOnJobFailure = !currentConfig.notifyOnJobFailure;
      syncMenu();
      saveNotifyConfig();
    });

    loadNotifyConfig();

    // Auto-poll every minute. Skip while hidden to spare the GitHub rate limit;
    // refresh immediately on becoming visible if a poll was missed. A flag
    // prevents overlapping refreshes if a previous one is still in flight.
    const POLL_INTERVAL_MS = 60_000;
    let refreshing = false;
    let lastPollAt = Date.now();
    async function autoRefresh() {
      if (refreshing || document.hidden) return;
      refreshing = true;
      try {
        await loadCopilot();
        await loadAll(true);
        await loadWatched(true);
        lastPollAt = Date.now();
      } catch (e) {
        console.error('auto-refresh failed', e);
      } finally {
        refreshing = false;
      }
    }
    setInterval(autoRefresh, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastPollAt >= POLL_INTERVAL_MS) {
        autoRefresh();
      }
    });

    (async () => {
      await loadCopilot();
      await loadAll();
      await loadWatched();
    })();
  </script>
</body>
</html>`;

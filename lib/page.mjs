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
     * Design tokens. The host injects its theme-resolved semantic tokens  *
     * onto this document (documented canvas theme contract:               *
     * --background-color-default, --text-color-default, --text-color-     *
     * muted, --border-color-default, and the --true-color-* family) and   *
     * updates those VALUES live when the user flips the app theme. We      *
     * derive our whole palette from them in plain CSS -- so the browser    *
     * repaints every dependent element automatically the instant a token  *
     * value changes. No script drives theming, so nothing can be          *
     * throttled while the panel is idle. The hex fallbacks (Primer dark)  *
     * apply only if the host doesn't inject a given token.                 *
     * ------------------------------------------------------------------ */
    :root {
      color-scheme: light dark;

      /* Structural surfaces / text / borders: bound directly to the host's
         theme-resolved tokens so they flip (and repaint) with the app theme. */
      --canvas-default:  var(--background-color-default, #0d1117);
      --fg-default:      var(--text-color-default, #f0f6fc);
      --fg-muted:        var(--text-color-muted, #9198a1);
      --border-default:  var(--border-color-default, #3d444d);

      /* Elevation / recess / hover derived from the two primaries so they
         track the theme automatically. Nudging "toward fg" lightens in dark
         and darkens in light -- the elevation direction in both. */
      --canvas-subtle:   color-mix(in srgb, var(--canvas-default), var(--fg-default) 6%);
      --canvas-inset:    color-mix(in srgb, var(--canvas-default), var(--fg-default) 11%);
      --row-hover:       color-mix(in srgb, var(--canvas-default), var(--fg-default) 4%);
      --fg-subtle:       color-mix(in srgb, var(--fg-muted), var(--canvas-default) 35%);
      --border-muted:    color-mix(in srgb, var(--border-default), var(--canvas-default) 50%);
      --header-bg:       color-mix(in srgb, var(--canvas-default) 80%, transparent);

      /* Accent + status hues: the host's true-color family with hex fallback. */
      --accent-fg:       var(--true-color-blue, #4493f7);
      --accent-emphasis: color-mix(in srgb, var(--true-color-blue, #1f6feb), #000 12%);
      --success-fg:      var(--true-color-green, #3fb950);
      --attention-fg:    var(--true-color-yellow, #d29922);
      --danger-fg:       var(--true-color-red, #f85149);
      --done-fg:         var(--true-color-violet, #a371f7);
      --neutral-fg:      var(--text-color-muted, #9198a1);

      --radius:     12px;
      --radius-sm:  8px;
      --radius-pill: 999px;
      --shadow-sm:  0 1px 2px rgba(1, 4, 9, 0.4);
      --shadow-md:  0 8px 22px rgba(1, 4, 9, 0.55);
      --shadow-pop: 0 18px 44px rgba(1, 4, 9, 0.7);
      --ease:       cubic-bezier(0.4, 0, 0.2, 1);
    }

    * { box-sizing: border-box; }

    body {
      font: 13.5px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      margin: 0;
      padding: 0 1rem 1.5rem;
      /* The app's default background (the sidebar color), bound through our
         token to the host's live --background-color-default. The browser
         repaints this automatically when the host updates the token value, so
         the panel follows the app theme with no script involved. */
      background: var(--canvas-default);
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
      min-width: 320px;
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

    /* ---- Repo filter section ---- */
    .menu-field { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.3rem 0.55rem; }
    .menu-field label { font-size: 0.72rem; font-weight: 600; color: var(--fg-muted); }
    .menu-field textarea {
      width: 100%;
      min-height: 5rem;
      resize: vertical;
      padding: 0.4rem 0.5rem;
      font: inherit;
      font-size: 0.76rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--fg-default);
      background: var(--canvas-inset);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      box-sizing: border-box;
    }
    .menu-field textarea:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: -1px; }
    .menu-hint { padding: 0 0.55rem 0.1rem; font-size: 0.68rem; line-height: 1.35; color: var(--fg-subtle); }
    .menu-actions { display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; padding: 0.2rem 0.55rem 0.4rem; }
    .menu-save-status { margin-right: auto; font-size: 0.68rem; color: var(--fg-subtle); }
    .menu-save-btn {
      padding: 0.3rem 0.7rem;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 600;
      color: #fff;
      background: var(--accent-emphasis);
      border: 1px solid var(--accent-emphasis);
      border-radius: 7px;
      cursor: pointer;
      transition: filter 0.12s var(--ease);
    }
    .menu-save-btn:hover { filter: brightness(1.08); }
    .menu-save-btn:disabled { opacity: 0.6; cursor: not-allowed; }

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
      background: var(--canvas-subtle);
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
      background: var(--canvas-subtle);
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
    .project { background: var(--canvas-default); font-size: 0.75rem; }
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
    .badge.author { text-transform: none; background: color-mix(in srgb, var(--neutral-fg) 12%, transparent); color: var(--neutral-fg); border-color: color-mix(in srgb, var(--neutral-fg) 28%, transparent); }

    /* ---- CI groups (Azure Pipelines / GitHub Actions) ---- */
    .azdo {
      margin-top: 0.55rem;
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      padding: 0.5rem 0.6rem;
      background: var(--canvas-default);
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

    /* ---- Inspect mode "CI Run" panel (AzDO run(s) passed in by URL) ---- */
    /* Inspect mode: the canvas was opened to inspect AzDO run(s), so the
       PR tab bar is hidden and the run panel is the whole surface. Each run
       reuses the same collapsible ul.list / li.row chrome the PR tabs use, so
       its gray wrapper (title + overall status + collapse) and the ".azdo"
       group box (and its coloring) are identical across tabs. The server adds
       the inspect-mode class to the page body when run(s) are configured, so
       these rules apply from first paint — no flash of the PR tabs/panels
       before the client's /api/ci-run fetch resolves. */
    .inspect-mode .tabs { display: none; }
    .inspect-mode #panel-cirun { display: block; }
    .inspect-mode .panel:not(#panel-cirun) { display: none; }
    .cirun-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.78rem; color: var(--fg-muted); margin-bottom: 0.5rem; }
    .cirun-error {
      border: 1px solid color-mix(in srgb, var(--danger-fg) 32%, transparent);
      background: color-mix(in srgb, var(--danger-fg) 9%, transparent);
      border-radius: var(--radius-sm);
      padding: 0.7rem 0.8rem; font-size: 0.8rem; color: var(--fg-default);
      white-space: pre-wrap; line-height: 1.45;
    }
    .cirun-error.auth { border-color: color-mix(in srgb, var(--attention-fg) 38%, transparent); background: color-mix(in srgb, var(--attention-fg) 10%, transparent); }
    .cirun-error .cirun-error-title { display: block; font-weight: 650; margin-bottom: 0.3rem; }
    .cirun-error code { background: var(--canvas-inset); padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.92em; }

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
    .cirun-error-row .ci-dot.overall { margin-left: auto; }

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
      background: color-mix(in srgb, var(--canvas-subtle) 60%, transparent);
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
      background: var(--canvas-subtle);
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
    .cirun-remove {
      cursor: pointer;
      background: none;
      border: 1px solid transparent;
      color: var(--fg-subtle);
      font: inherit;
      font-size: 0.9rem;
      line-height: 1;
      padding: 0.15rem 0.4rem;
      border-radius: 6px;
      transition: background 0.15s var(--ease), color 0.15s var(--ease), border-color 0.15s var(--ease);
    }
    .cirun-remove:hover { background: color-mix(in srgb, var(--danger-fg) 16%, transparent); color: var(--danger-fg); border-color: color-mix(in srgb, var(--danger-fg) 35%, transparent); }
  </style>

</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">◎</span>
      <span class="brand-text">
        <h1>CI Runs</h1>
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
        <hr class="menu-divider" />
        <div class="menu-section" role="group" aria-label="Copilot sessions">
          <div class="menu-section-label">Copilot sessions</div>
          <button type="button" class="menu-item" id="opt-show-others" role="menuitemcheckbox" aria-checked="false">
            <span class="menu-check" aria-hidden="true">✓</span>
            <span class="menu-text">Show others' PRs (not just mine)</span>
          </button>
          <p class="menu-hint">By default the Copilot tab lists only sessions for PRs you authored. Enable this to also show sessions for PRs others authored (e.g. codeflow/bot PRs), including their CI run trees.</p>
        </div>
        <hr class="menu-divider" />
        <div class="menu-section" role="group" aria-label="Repository filter">
          <div class="menu-section-label">Repository filter</div>
          <p class="menu-hint">Glob patterns matched against <code>owner/repo</code>, one per line. <code>*</code> matches any characters, <code>?</code> one; prefix with <code>!</code> to exclude. Empty = all repos.</p>
          <div class="menu-field">
            <label for="repo-patterns">Patterns</label>
            <textarea id="repo-patterns" spellcheck="false" autocomplete="off" placeholder="my-org/*&#10;!my-org/legacy-*"></textarea>
          </div>
        </div>
        <hr class="menu-divider" />
        <div class="menu-actions" role="group" aria-label="Save settings">
          <span class="menu-save-status" id="settings-status" aria-live="polite"></span>
          <button type="button" class="menu-save-btn" id="settings-save">Save</button>
        </div>
      </div>
    </div>
  </header>
  <div class="tabs">
    <button class="tab active" data-tab="copilot" title="Pull requests currently open as Copilot project sessions on this machine">Copilot<span class="count" id="copilot-count"></span></button>
    <button class="tab" data-tab="all" title="Every open pull request you authored across GitHub">All my PRs<span class="count" id="all-count"></span></button>
    <button class="tab" data-tab="watched" title="PRs you've manually added by URL to keep an eye on.">Watched<span class="count" id="watched-count"></span></button>
  </div>
  <div class="panel" id="panel-cirun"><div class="loading">Loading…</div></div>
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
    // re-renders; the row reconciler carries that state across replacements.
    function renderPrRow({ headerHtml, titleHtml, metaHtml, gha, azdo, prKey, rowKey, trailingHtml }) {
      const overall = overallCiState(gha, azdo);
      const overallDot = overall
        ? \`<span class="ci-dot \${overall} overall" title="\${esc(overallCiTooltips[overall] ?? '')}"></span>\`
        : '';
      const trailing = trailingHtml ?? '';
      const head = \`<div class="row-head">\${headerHtml}\${overallDot}\${trailing}</div>\`;
      const title = \`<div class="row-title">\${titleHtml}</div>\`;
      const meta = metaHtml ? \`<div class="row-meta">\${metaHtml}</div>\` : '';
      const rowKeyAttr = rowKey != null ? \` data-row-key="\${esc(rowKey)}"\` : '';
      if (!overall) {
        return \`<li class="row"\${rowKeyAttr}>\${head}\${title}\${meta}</li>\`;
      }
      const openAttr = overall === 'success' ? '' : 'open';
      // The outer collapsible <details> needs a stable key so preserveRowOpenState
      // can carry the user's open/closed state across a row replacement. Prefer
      // prKey, but fall back to the row's own data-row-key for rows that have no
      // PR key (e.g. a Copilot session row missing repo/number) — otherwise those
      // rows would snap shut whenever their data changes and the row is re-rendered.
      const detailsKey = prKey ?? rowKey;
      const keyAttr = detailsKey != null ? \` data-pr-key="\${esc(detailsKey)}"\` : '';
      const body = \`\${renderGha(gha)}\${renderAzdo(azdo)}\`;
      return \`<li class="row row-collapsible"\${rowKeyAttr}><details\${keyAttr} \${openAttr}>
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
      if (!rows.length) return { items: [], emptyHtml: '<div class="empty">No active Copilot sessions with PRs.</div>' };
      const items = sortByUpdatedDesc(rows).map((s, i) => {
        const num   = s.source_pr_number ?? s.created_pr_number;
        const url   = s.source_pr_html_url ?? s.created_pr_html_url;
        const repo  = s.repo_full_name ?? s.created_pr_repo ?? '(unknown repo)';
        const title = s._liveTitle ?? s.source_pr_title ?? '(untitled)';
        const head  = s.source_pr_head_ref ? \`\${esc(s.source_pr_head_ref)} → \${esc(s.source_pr_base_ref ?? '')}\` : esc(s.branch ?? '');
        const draftBadge = s._liveDraft ? '<span class="badge draft" title="This PR is still in draft">draft</span>' : '';
        const authorBadge = (!s._isMine && s.source_pr_author_login)
          ? \`<span class="badge author" title="Authored by @\${esc(s.source_pr_author_login)} (not you)">@\${esc(s.source_pr_author_login)}</span>\`
          : '';
        const syncBadge  = s.sync_state ? \`<span class="badge sync-\${esc(s.sync_state)}" title="\${esc(syncTooltips[s.sync_state] ?? '')}">\${esc(s.sync_state.replace(/_/g,' '))}</span>\` : '';
        const link = url ? \`<a href="\${esc(safeUrl(url))}" target="_blank" rel="noopener">#\${esc(num)}</a>\` : (num ? \`#\${esc(num)}\` : '');
        const sessionInfo = s._taskUrl
          ? \`<a class="badge session" href="\${esc(safeUrl(s._taskUrl))}" target="_blank" rel="noopener" title="Open this session on github.com">session ↗</a>\`
          : (s.workspace_id ? \`<span class="badge session" title="Workspace ID: \${esc(s.workspace_id)}">session</span>\` : '');
        const updated = s._liveUpdatedAt ? \`updated \${new Date(s._liveUpdatedAt).toLocaleString()}\` : '';
        const meta = [head, updated].filter(Boolean).join(' · ');
        const prKey = repo && num ? (repo + '#' + num).toLowerCase() : null;
        // Row identity is the session (a session is unique even if two share a
        // PR), falling back to PR key or position so every row stays keyed.
        const rowKey = 'sess:' + (s.session_id ?? s.workspace_id ?? prKey ?? i);
        return { key: rowKey, html: renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span>\${link}\${draftBadge}\${authorBadge}\${syncBadge}\${sessionInfo}\`,
          titleHtml: esc(title),
          metaHtml: '',
          gha: s._gha,
          azdo: s._azdo,
          prKey,
          rowKey,
        }) };
      });
      return { items, emptyHtml: '' };
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
    // Shared "✓ N  ✕ M  ⟳ K  ⊘ J  · O" status-count summary used by the GHA,
    // AzDO, and inspect-mode pipeline cards. s = {success,failure,inProgress,
    // skipped,other}.
    function ciCounts(s) {
      return [
        s.success     ? \`<span title="passed">✓ \${s.success}</span>\` : '',
        s.failure     ? \`<span title="failed" class="count-fail">✕ \${s.failure}</span>\` : '',
        s.inProgress  ? \`<span title="in progress" class="count-progress">⟳ \${s.inProgress}</span>\` : '',
        s.skipped     ? \`<span title="skipped" class="count-skip">⊘ \${s.skipped}</span>\` : '',
        s.other       ? \`<span title="other">· \${s.other}</span>\` : '',
      ].filter(Boolean).join(' ');
    }

    function renderAzdo(azdo) {
      if (!azdo || !azdo.hasAny) return '';
      const s = azdo.summary;
      const overallDot = '<span class="ci-dot ' + s.overall + '"></span>';
      const counts = ciCounts(s);
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
      const counts = ciCounts(s);
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
      if (!withChecks.length) return { items: [], emptyHtml: '<div class="empty">No open PRs with CI checks.</div>' };
      const items = withChecks.map(p => {
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
        return { key, html: renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span><a href="\${esc(safeUrl(p.url))}" target="_blank" rel="noopener">#\${esc(p.number)}</a>\${draft}\${syncBadge}\${sessionBadge}\`,
          titleHtml: esc(p.title),
          metaHtml: '',
          gha: p.gha,
          azdo: p.azdo,
          prKey: key,
          rowKey: key,
        }) };
      });
      return { items, emptyHtml: '' };
    }

    // Watched tab. Rows look like "All my PRs" but each carries an ✕ button
    // anchored to the right that posts DELETE /api/watched. Items present in
    // the persisted list but missing from the checks response (e.g. private
    // repo, deleted PR, GraphQL error) still render so the user can see and
    // remove them.
    function renderWatched(items, rowsByKey) {
      if (!items.length) {
        return { items: [], emptyHtml: '<div class="empty">No watched PRs yet. Paste a GitHub PR URL above to start tracking its CI.</div>' };
      }
      // Sort: PRs with live CI/updatedAt info by updated desc, then the rest
      // by addedAt desc so unseen entries surface predictably.
      const enriched = items.map(it => ({ item: it, row: rowsByKey.get(it.key) ?? null }));
      enriched.sort((a, b) => {
        const ta = a.row ? prSortTime(a.row) : Date.parse(a.item.addedAt) || 0;
        const tb = b.row ? prSortTime(b.row) : Date.parse(b.item.addedAt) || 0;
        return tb - ta;
      });
      const rows = enriched.map(({ item, row }) => {
        const repo = row?.repository?.nameWithOwner ?? \`\${item.owner}/\${item.repo}\`;
        const removeBtn = \`<button type="button" class="watched-remove" data-watch-key="\${esc(item.key)}" title="Stop watching this PR" aria-label="Stop watching">✕</button>\`;
        if (!row) {
          // No live PR data — show a placeholder row so the user can still
          // remove it. Could be a private repo, a deleted PR, or a temporary
          // GraphQL failure.
          const removeFloating = \`<button type="button" class="watched-remove" data-watch-key="\${esc(item.key)}" title="Stop watching this PR" aria-label="Stop watching" style="margin-left:auto">✕</button>\`;
          return { key: item.key, html: \`<li class="row" data-row-key="\${esc(item.key)}"><div class="row-head"><span class="repo">\${esc(repo)}</span><a href="\${esc(safeUrl(item.url))}" target="_blank" rel="noopener">#\${esc(item.number)}</a><span class="badge draft">unavailable</span>\${removeFloating}</div><div class="row-meta">Couldn't load this PR (private repo, deleted, or GraphQL failure)</div></li>\` };
        }
        const draft = row.isDraft ? '<span class="badge draft" title="This PR is still in draft">draft</span>' : '';
        const updated = row.updatedAt ? \`updated \${new Date(row.updatedAt).toLocaleString()}\` : '';
        const meta = [updated].filter(Boolean).join(' · ');
        return { key: item.key, html: renderPrRow({
          headerHtml: \`<span class="repo">\${esc(repo)}</span><a href="\${esc(safeUrl(row.url))}" target="_blank" rel="noopener">#\${esc(row.number)}</a>\${draft}\`,
          titleHtml: esc(row.title),
          metaHtml: meta,
          gha: row.gha,
          azdo: row.azdo,
          prKey: item.key,
          rowKey: item.key,
          trailingHtml: removeBtn,
        }) };
      });
      return { items: rows, emptyHtml: '' };
    }

    let lastSessions = [];
    // Last successfully rendered Copilot rows, kept so a transient /api/sessions
    // failure can re-render them under an error banner (matching loadAll/
    // loadWatched) instead of tearing the panel down to an error-only box.
    let lastCopilotItems = [];
    let lastChecks = [];

    // Avoid flashing on auto-refresh: only touch the DOM when the freshly
    // rendered HTML for a panel actually differs from what's already shown.
    // Most 60s polls produce identical markup, so this skips the teardown/
    // repaint (and avatar image reloads) entirely when nothing changed.
    const __panelHtmlCache = new Map();

    // Persist each panel's last-rendered HTML (and which surface is active) so
    // returning to the canvas after its webview was torn down doesn't repaint
    // the static "Loading…" placeholders and drop every row until the first
    // fetch resolves. Re-hydrating this snapshot on boot keeps the previous
    // content on screen so loading/refreshing updates it inline.
    //
    // The durable copy lives SERVER-SIDE on disk (keyed by the stable canvas
    // instanceId) and is inlined into this page as window.__CIRUNS_SNAPSHOT at
    // serve time (SSR). That's what survives the app recreating the webview/host
    // on a brand-new ephemeral port — which changes the origin and wipes
    // localStorage, the reason the flash used to come back "after a long while".
    // localStorage is still written as a same-origin fast path for plain
    // reloads before the first server POST lands.
    const __SNAP_KEY = 'ci-runs:panel-snapshot:v1';
    // Single in-memory snapshot, seeded once: prefer the server-inlined SSR
    // snapshot (survives port changes), else localStorage. All persistence flows
    // through this one object so accumulating patches (html/counts/activeTab/
    // inspect) never clobber each other.
    const __snap = (() => {
      try {
        if (window.__CIRUNS_SNAPSHOT && typeof window.__CIRUNS_SNAPSHOT === 'object') {
          return window.__CIRUNS_SNAPSHOT;
        }
      } catch (e) { /* ignore */ }
      try { return JSON.parse(localStorage.getItem(__SNAP_KEY) || '{}') || {}; }
      catch (e) { return {}; }
    })();
    function readSnapshot() { return __snap; }
    let __snapPostTimer = null;
    function postSnapshotSoon() {
      // A single refresh cycle calls persist* several times (one per panel plus
      // counts). Debounce into one POST so we don't re-serialize and rewrite the
      // snapshot file four times per refresh.
      if (__snapPostTimer) return;
      __snapPostTimer = setTimeout(() => {
        __snapPostTimer = null;
        try {
          fetch('/api/snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(__snap),
            keepalive: true,
          }).catch(() => {});
        } catch (e) { /* non-fatal */ }
      }, 400);
    }
    function writeSnapshot(patch) {
      Object.assign(__snap, patch);
      try { localStorage.setItem(__SNAP_KEY, JSON.stringify(__snap)); }
      catch (e) { /* storage disabled or over quota — non-fatal */ }
      postSnapshotSoon();
    }
    function persistPanelHtml(id, html) {
      __snap.html = { ...(__snap.html || {}), [id]: html };
      writeSnapshot({});
    }
    function persistCount(id, val) {
      __snap.counts = { ...(__snap.counts || {}), [id]: val };
      writeSnapshot({});
    }

    function applyPanelHtml(el, html) {
      if (!el) return false;
      const key = el.id || el;
      if (__panelHtmlCache.get(key) === html) return false;
      __panelHtmlCache.set(key, html);
      el.innerHTML = html;
      if (el.id) persistPanelHtml(el.id, html);
      return true;
    }

    // ---- Keyed row-level reconciler ----
    //
    // Replacing a panel's whole innerHTML tears down every <li>: avatars are
    // re-downloaded, any lazily-loaded AzDO timeline is discarded, and the
    // browser repaints the entire list even when a single row changed. Instead
    // we diff by a stable data-row-key. Rows whose markup is byte-identical keep
    // their exact DOM nodes (no avatar reload, no timeline loss); changed rows
    // are swapped in place carrying over their expand/collapse state; new rows
    // are inserted and gone rows removed; order is reconciled with insertBefore.
    const __rowTemplate = document.createElement('template');
    function rowFromHtml(html) {
      __rowTemplate.innerHTML = String(html).trim();
      return __rowTemplate.content.firstElementChild;
    }

    // Carry a replaced row's open/closed state onto its replacement so a data
    // change (e.g. a check flipping green, which re-renders the row) doesn't
    // snap the row — or any job list opened inside it — back to the default
    // state. A job list whose live AzDO timeline had been loaded is re-fetched
    // so the fresh node shows the timeline again instead of the static fallback.
    function preserveRowOpenState(oldLi, newLi) {
      const prev = new Map();
      oldLi.querySelectorAll('details[data-pr-key], details[data-jobs-key]').forEach(d => {
        const k = d.dataset.prKey != null ? 'p:' + d.dataset.prKey : 'j:' + d.dataset.jobsKey;
        prev.set(k, { open: d.open, tlLoaded: d.dataset.tlLoaded === '1' });
      });
      newLi.querySelectorAll('details[data-pr-key], details[data-jobs-key]').forEach(d => {
        const k = d.dataset.prKey != null ? 'p:' + d.dataset.prKey : 'j:' + d.dataset.jobsKey;
        const s = prev.get(k);
        if (!s) return;
        d.open = s.open;
        if (s.open && s.tlLoaded && d.dataset.tlBuildId) {
          // Defer until the node is connected so loadAzdoTimeline can swap the
          // content in place rather than on a detached fragment.
          queueMicrotask(() => { if (d.isConnected) loadAzdoTimeline(d, { force: true }); });
        }
      });
    }

    // Reconcile container's children to match items (array of { key, html }
    // where html is a single <li ...> string carrying data-row-key="<key>").
    // errorHtml renders as a banner above the list; emptyHtml shows when there
    // are no rows. Both are kept as their own nodes so a transient error or an
    // empty cycle never blows away rows that are still valid.
    function reconcileRows(container, items, opts) {
      if (!container) return;
      const emptyHtml = (opts && opts.emptyHtml) || '';
      const errorHtml = (opts && opts.errorHtml) || '';

      // Drop placeholders and hydrate leftovers the reconciler doesn't own, so
      // it can manage its own list/banner/empty nodes from a clean slate. Two
      // sources put stray direct children here:
      //   - the initial "Loading…" placeholder: an element child with class
      //     "loading" (copilot/all/cirun panels) or, for #watched-list which is
      //     itself the container, the container's own "loading" class plus a
      //     bare "Loading…" text node;
      //   - snapshot hydration / a transient load error, which inject a render as
      //     raw innerHTML, so an empty/error state lands as a direct-child
      //     <div class="empty">, <div class="error">, or the inspect-mode CI-run
      //     failure box <div class="cirun-error">. The reconciler's managed
      //     empty/banner nodes are WRAPPER divs (their .empty/.error lives one
      //     level down), so a direct-child placeholder like this is always a
      //     stale artifact — left in place it would sit above the rows, or
      //     duplicate when the branch below builds a fresh managed node.
      if (container.classList && container.classList.contains('loading')) {
        container.classList.remove('loading');
      }
      for (const child of Array.from(container.childNodes)) {
        if (child === container.__listEl || child === container.__bannerEl || child === container.__emptyEl) continue;
        if (child.nodeType === 3) { child.remove(); continue; } // stray placeholder text node
        if (child.nodeType !== 1 || !child.classList) continue;
        if (child.classList.contains('loading') || child.classList.contains('empty')
            || child.classList.contains('error') || child.classList.contains('cirun-error')) {
          child.remove();
        }
      }

      let banner = container.__bannerEl && container.__bannerEl.isConnected ? container.__bannerEl : null;
      if (errorHtml) {
        if (!banner) {
          banner = document.createElement('div');
          container.insertBefore(banner, container.firstChild);
          container.__bannerEl = banner;
        } else if (banner !== container.firstChild) {
          container.insertBefore(banner, container.firstChild);
        }
        if (banner.__html !== errorHtml) { banner.innerHTML = errorHtml; banner.__html = errorHtml; }
      } else if (banner) {
        banner.remove();
        container.__bannerEl = null;
      }

      if (!items || !items.length) {
        if (container.__listEl) { container.__listEl.remove(); container.__listEl = null; }
        let empty = container.__emptyEl && container.__emptyEl.isConnected ? container.__emptyEl : null;
        if (!empty) {
          empty = document.createElement('div');
          container.appendChild(empty);
          container.__emptyEl = empty;
        }
        if (empty.__html !== emptyHtml) { empty.innerHTML = emptyHtml; empty.__html = emptyHtml; }
        return;
      }
      if (container.__emptyEl) { container.__emptyEl.remove(); container.__emptyEl = null; }

      let ul = container.__listEl && container.__listEl.isConnected ? container.__listEl : container.querySelector('ul.list');
      if (!ul) {
        ul = document.createElement('ul');
        ul.className = (opts && opts.listClass) || 'list';
        container.appendChild(ul);
      }
      container.__listEl = ul;

      const existing = new Map();
      for (const li of Array.from(ul.children)) {
        const k = li.dataset.rowKey;
        if (k != null && !existing.has(k)) existing.set(k, li);
        else li.remove();
      }

      const seen = new Set();
      let cursor = null;
      for (const { key, html } of items) {
        if (seen.has(key)) continue; // ignore duplicate keys defensively
        seen.add(key);
        let li = existing.get(key);
        if (!li) {
          li = rowFromHtml(html);
          li.__rowHtml = html;
        } else if (li.__rowHtml !== html) {
          const fresh = rowFromHtml(html);
          fresh.__rowHtml = html;
          preserveRowOpenState(li, fresh);
          li.replaceWith(fresh);
          existing.set(key, fresh);
          li = fresh;
        }
        const desiredNext = cursor ? cursor.nextSibling : ul.firstChild;
        if (li !== desiredNext) ul.insertBefore(li, desiredNext);
        cursor = li;
      }
      for (const [k, li] of existing) {
        if (!seen.has(k) && li.isConnected) li.remove();
      }
    }

    // Serialize reconciler items back into the single HTML string used for the
    // change-detection cache and the localStorage snapshot (so hydration and
    // the "skip when unchanged" fast path keep working).
    function itemsToHtml(items, emptyHtml, errorHtml, listClass) {
      const banner = errorHtml || '';
      if (!items || !items.length) return banner + (emptyHtml || '');
      return banner + '<ul class="' + (listClass || 'list') + '">' + items.map(i => i.html).join('') + '</ul>';
    }

    async function loadCopilot() {
      const res = await fetch('/api/sessions').then(r => r.json());
      if (res.error) {
        // Surface the error as a banner over whatever rows are already on screen
        // — the same way loadAll/loadWatched do — instead of replacing the panel
        // with an error-only box. Crucially, do NOT persist: a transient
        // /api/sessions failure must not overwrite the good snapshot with an
        // error state, or it would re-flash that error on the next hydrate, the
        // very thing this snapshot exists to prevent. We still update
        // __panelHtmlCache with the banner-inclusive html (exactly as loadAll
        // does) so that when the error clears on a same-data recovery the html
        // differs from the cached value, the unchanged-guard fires, and the
        // banner is reconciled away instead of sticking on screen forever.
        const banner = \`<div class="error">\${esc(res.error)}</div>\`;
        const emptyHtml = renderCopilot([]).emptyHtml;
        const html = itemsToHtml(lastCopilotItems, emptyHtml, banner);
        __panelHtmlCache.set('panel-copilot', html);
        reconcileRows(document.getElementById('panel-copilot'), lastCopilotItems, { emptyHtml, errorHtml: banner });
        document.getElementById('copilot-count').textContent = '';
        lastSessions = [];
        return;
      }
      lastSessions = res.rows;
      // Whether to also surface sessions for PRs you did NOT author. Read fresh
      // each load so a Save in the settings menu takes effect on re-render.
      const showOthers = await loadShowOthers();
      // Cross-reference CI data from the authored checks cache and task URLs.
      const [checksRes, tasksRes] = await Promise.all([
        fetch('/api/prs-with-checks').then(r => r.json()),
        fetch('/api/tasks').then(r => r.json()),
      ]);
      lastChecks = checksRes.rows ?? [];
      const ciIndex = new Map();
      // Membership in the authored index == "this PR is mine" (the index comes
      // from an author:@me search). Used both for CI trees and mine/other
      // classification below.
      const mineKeys = new Set();
      for (const p of lastChecks) {
        const key = (p.repository.nameWithOwner + '#' + p.number).toLowerCase();
        ciIndex.set(key, p);
        mineKeys.add(key);
      }
      // When showing others, pull CI run trees for the session PRs that aren't
      // in the authored index (the author:@me query misses them). Merge them in
      // without overriding authored entries.
      if (showOthers) {
        try {
          const sc = await fetch('/api/session-checks').then(r => r.json());
          for (const p of (sc.rows ?? [])) {
            const key = (p.repository.nameWithOwner + '#' + p.number).toLowerCase();
            if (!ciIndex.has(key)) ciIndex.set(key, p);
          }
        } catch (e) {
          console.error('failed to load session checks', e);
        }
      }
      const taskMap = new Map(Object.entries(tasksRes.tasks ?? {}));
      // Attach CI data, mine/other flag, and remote task URL to each session row
      const enriched = res.rows.map(s => {
        const prNum = s.source_pr_number ?? s.created_pr_number;
        const repo = s.repo_full_name ?? s.created_pr_repo;
        const key = repo && prNum ? (repo + '#' + prNum).toLowerCase() : null;
        const ci = key ? ciIndex.get(key) : null;
        const isMine = key ? mineKeys.has(key) : false;
        const taskId = s.session_id ? taskMap.get(s.session_id) : null;
        const taskUrl = taskId && repo ? \`https://github.com/\${repo}/tasks/\${taskId}\` : null;
        return { ...s, _isMine: isMine, _gha: ci?.gha ?? null, _azdo: ci?.azdo ?? null, _liveTitle: ci?.title ?? s._liveTitle ?? null, _liveUpdatedAt: ci?.updatedAt ?? null, _liveDraft: ci?.isDraft ?? s._liveDraft ?? false, _taskUrl: taskUrl };
      });
      // Default view: only my-authored session PRs. The toggle widens it to all.
      const visible = showOthers ? enriched : enriched.filter(s => s._isMine);
      // Stash the task map on the session rows for renderAll cross-reference
      window.__taskMap = taskMap;
      const { items, emptyHtml } = renderCopilot(visible);
      lastCopilotItems = items;
      const el = document.getElementById('panel-copilot');
      const html = itemsToHtml(items, emptyHtml);
      if (__panelHtmlCache.get('panel-copilot') !== html) {
        __panelHtmlCache.set('panel-copilot', html);
        reconcileRows(el, items, { emptyHtml });
        persistPanelHtml('panel-copilot', html);
      }
      // Count reflects what's shown. When hiding others, note how many are hidden.
      const hidden = enriched.length - visible.length;
      const countEl = document.getElementById('copilot-count');
      countEl.textContent =
        ' (' + visible.length + (hidden > 0 ? ' of ' + enriched.length : '') + ')';
      countEl.title = hidden > 0
        ? \`Showing \${visible.length} of \${enriched.length} sessions — only PRs you authored. Enable "Show others' PRs" in settings to see the rest.\`
        : '';
      persistCount('copilot-count', countEl.textContent);
    }

    // Fetch the persisted "show others' PRs" display preference. Defaults to
    // false (mine only) on any error so the tab degrades to the safe view.
    async function loadShowOthers() {
      try {
        const body = await fetch('/api/display-config').then(r => r.json());
        return !!(body && body.config && body.config.showOtherSessions);
      } catch (e) {
        console.error('failed to load display config', e);
        return false;
      }
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
      const { items, emptyHtml } = renderAll(res.rows ?? [], sessionIndex);
      const el = document.getElementById('panel-all');
      const html = itemsToHtml(items, emptyHtml, errorBanner);
      if (__panelHtmlCache.get('panel-all') !== html) {
        __panelHtmlCache.set('panel-all', html);
        reconcileRows(el, items, { emptyHtml, errorHtml: errorBanner });
        persistPanelHtml('panel-all', html);
      }
      const visibleCount = (res.rows ?? []).filter(p => p.azdo?.hasAny || p.gha?.hasAny).length;
      const allCountText = res.rows ? ' (' + visibleCount + ')' : '';
      document.getElementById('all-count').textContent = allCountText;
      persistCount('all-count', allCountText);
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
      const { items: rows, emptyHtml } = renderWatched(items, rowsByKey);
      list.classList.remove('loading');
      const html = itemsToHtml(rows, emptyHtml, errorBanner);
      if (__panelHtmlCache.get('watched-list') !== html) {
        __panelHtmlCache.set('watched-list', html);
        reconcileRows(list, rows, { emptyHtml, errorHtml: errorBanner });
        persistPanelHtml('watched-list', html);
      }
      const watchedCountText = items.length ? ' (' + items.length + ')' : '';
      document.getElementById('watched-count').textContent = watchedCountText;
      persistCount('watched-count', watchedCountText);
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
    // Open-state survives the 60s auto-refresh via the row reconciler: unchanged
    // rows keep their exact DOM nodes, and a changed row carries its open job
    // lists over to the replacement (re-fetching any live timeline) in
    // preserveRowOpenState().

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

    // ---- Inspect mode (one or more AzDO runs passed in by URL) ----
    //
    // When the canvas is opened with a \`ciRunUrl\` input, /api/ci-run returns
    // those builds' status + job timelines. Re-opening the same panel with
    // another run URL adds it to the list. Public pipelines are read
    // anonymously; private ones authenticate via the Azure CLI. In this mode
    // the whole surface is dedicated to the run(s): the PR tab bar is hidden and
    // each run renders with the same ".azdo" pipeline-run card the PR tabs use.
    let inspectMode = false;

    // Render one run (a single /api/ci-run "runs" entry) as a collapsible row
    // that mirrors the PR tabs: the gray wrapper shows a title (pipeline name)
    // and overall status dot, collapses to hide the body, and contains the
    // shared ".azdo" pipeline-run card.
    function renderCiRunCard(run) {
      // Only label the link "open in Azure DevOps" when the URL is actually a
      // recognized AzDO run URL. For a bad_url error the stored value can be an
      // arbitrary/non-AzDO URL, so suppress the link rather than mislabel it.
      const link = (run.url && run.errorKind !== 'bad_url')
        ? \`<a href="\${esc(safeUrl(run.url))}" target="_blank" rel="noopener">open in Azure DevOps ↗</a>\`
        : '';
      // ✕ button to drop this run from the inspect panel. Placed in the row head
      // (flex, margin-left:auto pushes it to the right edge). Inside a <summary>
      // a click would toggle the row, so the delegated handler preventDefaults.
      const removeBtn = run.url
        ? \`<button type="button" class="cirun-remove" data-remove-url="\${esc(run.url)}" title="Remove this run from the panel" aria-label="Remove this run">✕</button>\`
        : '';
      // Stable per-run identity for the row reconciler. The run URL is unique
      // within the panel (dedupe happens on add); fall back to org|project|build.
      const cardKey = run.url || \`build:\${run.org || ''}|\${run.project || ''}|\${run.buildId || ''}\` || 'cirun';
      if (run.error) {
        const isAuth = run.errorKind === 'not_installed'
          || run.errorKind === 'not_logged_in'
          || run.errorKind === 'auth_required';
        const title =
          run.errorKind === 'not_installed' ? 'Azure CLI not found' :
          run.errorKind === 'not_logged_in' ? 'Azure CLI not signed in' :
          run.errorKind === 'auth_required' ? 'Access denied' :
          run.errorKind === 'bad_url'       ? 'Unrecognized pipeline URL' :
          'Could not load this CI run';
        const buildLabel = run.buildId ? \`Build \${esc(run.buildId)}\` : 'CI run';
        return { key: cardKey, html: \`<li class="row cirun-error-row" data-row-key="\${esc(cardKey)}">
          <div class="row-head"><span class="repo">\${buildLabel}</span><span class="ci-dot failure overall" title="\${esc(title)}"></span>\${removeBtn}</div>
          \${link ? \`<div class="cirun-meta">\${link}</div>\` : ''}
          <div class="cirun-error\${isAuth ? ' auth' : ''}"><span class="cirun-error-title">\${esc(title)}</span>\${esc(run.error)}</div>
        </li>\` };
      }
      const build = run.build || {};
      const summaryUrl = (build && build.url)
        ? build.url
        : \`https://dev.azure.com/\${encodeURIComponent(run.org)}/\${encodeURIComponent(run.project)}/_build/results?buildId=\${encodeURIComponent(run.buildId)}\`;

      // Render with the exact same "Azure Pipelines" card the PR tabs use for an
      // AzDO run: overall status dot + counts, then a collapsible build whose
      // body is the shared renderTimelineJobs() job list. We already hold the
      // (auth'd) timeline here, so the jobs are inlined directly — no data-tl-*
      // lazy-load attributes, which keeps private runs from re-fetching the
      // timeline anonymously on expand. The refresh button re-pulls with auth.
      const jobRecords = (run.records || []).filter(r => r.type === 'Job');
      const cnt = { success: 0, failure: 0, inProgress: 0, skipped: 0, other: 0 };
      for (const r of jobRecords) {
        const c = tlDotClass(r.state, r.result);
        if (c === 'success') cnt.success++;
        else if (c === 'failure') cnt.failure++;
        else if (c === 'in_progress') cnt.inProgress++;
        else if (c === 'skipped') cnt.skipped++;
        else cnt.other++;
      }
      const overall = jobRecords.length
        ? (cnt.failure ? 'failure' : cnt.inProgress ? 'in_progress' : cnt.other ? 'other' : cnt.success ? 'success' : 'skipped')
        : tlDotClass(build.status, build.result);
      const buildLabel = build.buildNumber ? \`#\${esc(build.buildNumber)}\` : \`Build \${esc(run.buildId)}\`;
      const jobsCount = \`\${jobRecords.length} job\${jobRecords.length === 1 ? '' : 's'}\`;
      // Pipeline name is the prominent row title; the build number is the small
      // header link above it (mirrors PR tabs: PR title + repo#number header).
      const pipelineName = build.definition ? esc(build.definition) : 'Azure Pipelines';
      // Stable keys so manual collapse/expand survives auto-refresh re-renders
      // (the row reconciler carries open state across replacements). The outer
      // row and the inner job list each get their own key. Include project
      // because AzDO build IDs are only unique within a project, so two runs in
      // the same org but different projects could otherwise collide and swap
      // each other's open/closed state.
      const rowKey = \`cirun-row:\${esc(run.org || '')}|\${esc(run.project || '')}|\${esc(run.buildId || buildLabel)}\`;
      const jobsKey = \`cirun:\${esc(run.org || '')}|\${esc(run.project || '')}|\${esc(run.buildId || buildLabel)}\`;
      const azdoCard = \`<div class="azdo">
          <div class="azdo-line"><span class="ci-dot \${overall}"></span><strong>Azure Pipelines</strong> <span class="label ci-counts">\${ciCounts(cnt)}</span></div>
          <div class="azdo-build">
            <details class="azdo-jobs" data-jobs-key="\${jobsKey}" open><summary><span class="azdo-line"><a href="\${esc(safeUrl(summaryUrl))}" target="_blank" rel="noopener">\${buildLabel}</a> <span class="label">· \${jobsCount}</span></span></summary><div class="azdo-jobs-content">\${renderTimelineJobs(run.records, summaryUrl)}</div></details>
          </div>
        </div>\`;
      return { key: cardKey, html: \`<li class="row row-collapsible" data-row-key="\${esc(cardKey)}"><details data-jobs-key="\${rowKey}" open>
        <summary>
          <span class="caret">▶</span>
          <div class="row-summary-content">
            <div class="row-head"><a href="\${esc(safeUrl(summaryUrl))}" target="_blank" rel="noopener">\${buildLabel}</a><span class="ci-dot \${overall} overall" title="\${esc(overallCiTooltips[overall] ?? '')}"></span>\${removeBtn}</div>
            <div class="row-title">\${pipelineName}</div>
          </div>
        </summary>
        <div class="row-body">\${azdoCard}</div>
      </details></li>\` };
    }

    function renderCiRun(res) {
      const runs = res.runs || [];
      if (runs.length === 0) return { items: [], emptyHtml: '<div class="empty">No CI run configured.</div>' };
      return { items: runs.map(renderCiRunCard), emptyHtml: '' };
    }

    // A resumed or reloaded panel can briefly race the local CI run service
    // while it rebinds to a fresh ephemeral port (e.g. when the canvas is
    // reopened after a long idle, after the host has recycled the server), so
    // the first /api/ci-run fetch can throw (connection refused) before the
    // server is listening again. Retry a few times with a short backoff so the
    // transient failure is absorbed silently — the hydrated snapshot cards stay
    // on screen untouched while we retry — instead of flashing the error box
    // until the next 60s poll.
    const CIRUN_FETCH_RETRY_DELAYS_MS = [200, 400, 800, 1500];
    // If the error box does have to show (every attempt failed), retry sooner
    // than the 60s auto-poll so a service that recovers a few seconds later
    // clears it on its own.
    const CIRUN_ERROR_RETRY_MS = 3000;
    let __cirunRetryTimer = null;
    async function fetchCiRun(force) {
      let lastErr;
      for (let attempt = 0; attempt <= CIRUN_FETCH_RETRY_DELAYS_MS.length; attempt++) {
        try {
          return await fetch('/api/ci-run' + (force ? '?force=1' : '')).then(r => r.json());
        } catch (e) {
          lastErr = e;
          const delay = CIRUN_FETCH_RETRY_DELAYS_MS[attempt];
          if (delay === undefined) break;
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastErr;
    }

    // Returns true once a run is configured (inspect mode), so callers can
    // skip loading the PR tabs entirely.
    async function loadCiRun(force = false) {
      const panel = document.getElementById('panel-cirun');
      // The server stamps the inspect-mode class onto the body when run(s) are
      // configured, so the run panel is already the only visible surface from
      // first paint.
      const stamped = document.body.classList.contains('inspect-mode');
      let res;
      try {
        res = await fetchCiRun(force);
      } catch (e) {
        // Network/parse failure even after the in-fetch retries above. In
        // inspect mode the run panel is the only visible surface (the PR tabs
        // are hidden by CSS), so falling through would strand the user on the
        // panel's "Loading…" placeholder forever. Replace it with an
        // actionable, auto-retrying error instead.
        if (stamped || inspectMode) {
          inspectMode = true;
          panel.innerHTML = '<div class="cirun-error"><span class="cirun-error-title">Couldn\u2019t load the CI run</span>'
            + 'Failed to reach the local CI run service. This is usually transient — it will retry automatically, or use Refresh.</div>';
          // We just overwrote the panel DOM out-of-band (not via the reconciler),
          // so drop the cached render. Otherwise a retry that returns the same
          // run html would hit the unchanged-guard below, skip reconcile, and
          // leave the user stuck on this error box with the rows gone.
          __panelHtmlCache.delete('panel-cirun');
          // Self-heal faster than the 60s poll: schedule one short follow-up
          // retry so a service that comes back a few seconds later clears the
          // error box on its own. Guarded so overlapping failures don't stack
          // timers.
          if (__cirunRetryTimer === null) {
            __cirunRetryTimer = setTimeout(() => {
              __cirunRetryTimer = null;
              loadCiRun(true);
            }, CIRUN_ERROR_RETRY_MS);
          }
          return true;
        }
        return inspectMode;
      }
      // The fetch succeeded, so any pending self-heal retry is now redundant.
      if (__cirunRetryTimer !== null) { clearTimeout(__cirunRetryTimer); __cirunRetryTimer = null; }
      if (!res || !res.configured) {
        return false;
      }
      if (!inspectMode) {
        inspectMode = true;
        // Dedicate the surface to the run(s): hide the PR tab bar and make the
        // run panel the active surface.
        document.body.classList.add('inspect-mode');
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-cirun'));
      }
      // Persist the inspect surface so a reload re-hydrates straight into it
      // instead of flashing the PR tabs.
      writeSnapshot({ inspect: true });
      // Update the panel inline via the row reconciler so unchanged runs keep
      // their DOM (and any open job lists) and only changed runs are swapped.
      const { items, emptyHtml } = renderCiRun(res);
      const html = itemsToHtml(items, emptyHtml, '', 'list cirun-wrap');
      if (__panelHtmlCache.get('panel-cirun') !== html) {
        __panelHtmlCache.set('panel-cirun', html);
        reconcileRows(panel, items, { emptyHtml, listClass: 'list cirun-wrap' });
        persistPanelHtml('panel-cirun', html);
      }
      return true;
    }

    // Remove one run from the inspect panel via DELETE /api/ci-run, then
    // re-render the remaining runs (preserving collapse state). If the removed
    // run was the last one, show an empty placeholder rather than a stale card.
    async function removeCiRun(runUrl, btn) {
      if (btn) btn.disabled = true;
      let res;
      try {
        res = await fetch('/api/ci-run?url=' + encodeURIComponent(runUrl), { method: 'DELETE' }).then(r => r.json());
      } catch (e) {
        if (btn) btn.disabled = false;
        return;
      }
      const panel = document.getElementById('panel-cirun');
      if (!res || !res.configured || (res.runs || []).length === 0) {
        panel.innerHTML = '<div class="empty">No CI runs to display. Close this panel or open a new CI run to inspect.</div>';
        __panelHtmlCache.delete('panel-cirun');
        return;
      }
      const { items, emptyHtml } = renderCiRun(res);
      const html = itemsToHtml(items, emptyHtml, '', 'list cirun-wrap');
      __panelHtmlCache.set('panel-cirun', html);
      reconcileRows(panel, items, { emptyHtml, listClass: 'list cirun-wrap' });
      persistPanelHtml('panel-cirun', html);
    }

    // Delegated handler for each run's ✕ button. Inside a <summary> a button
    // click toggles the surrounding <details> by default; preventDefault +
    // stopPropagation keep the click from collapsing/expanding the row.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.cirun-remove');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const url = btn.dataset.removeUrl;
      if (url) removeCiRun(url, btn);
    });

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + btn.dataset.tab));
        writeSnapshot({ activeTab: btn.dataset.tab });
      });
    });
    document.getElementById('refresh').addEventListener('click', async () => {
      const btn = document.getElementById('refresh');
      btn.classList.add('spinning');
      btn.disabled = true;
      try {
        if (inspectMode) {
          await loadCiRun(true);
        } else {
          await loadCopilot();
          await loadAll(true);
          await loadWatched(true);
        }
      } finally {
        btn.classList.remove('spinning');
        btn.disabled = false;
      }
    });

    // Settings menu — Copilot "Changes" canvas-style popover anchored to the
    // gear icon. All settings (notification toggles + repo filter) are staged
    // locally and applied by a single Save button, so toggling a checkbox is
    // not committed until the user clicks Save. Save issues two independent
    // POSTs (notifications, then repo filter) — these are NOT atomic, so if the
    // second fails the first is already persisted; the status message reports
    // which parts applied. Reopening the menu reloads the last-saved values,
    // discarding any unsaved edits.
    const settingsBtn = document.getElementById('settings-btn');
    const settingsMenu = document.getElementById('settings-menu');
    const optCompletion = document.getElementById('opt-completion');
    const optFailure = document.getElementById('opt-failure');
    const optShowOthers = document.getElementById('opt-show-others');
    const repoPatternsEl = document.getElementById('repo-patterns');
    const saveBtn = document.getElementById('settings-save');
    const statusEl = document.getElementById('settings-status');
    let statusTimer = null;
    let dirty = false;
    let currentConfig = { notifyOnRunCompletion: false, notifyOnJobFailure: false };
    let currentDisplay = { showOtherSessions: false };

    function sanitizeCfg(c) {
      return {
        notifyOnRunCompletion: !!(c && c.notifyOnRunCompletion),
        notifyOnJobFailure: !!(c && c.notifyOnJobFailure),
      };
    }
    function sanitizeDisplay(c) {
      return { showOtherSessions: !!(c && c.showOtherSessions) };
    }
    function syncMenu() {
      optCompletion.setAttribute('aria-checked', currentConfig.notifyOnRunCompletion ? 'true' : 'false');
      optFailure.setAttribute('aria-checked', currentConfig.notifyOnJobFailure ? 'true' : 'false');
      optShowOthers.setAttribute('aria-checked', currentDisplay.showOtherSessions ? 'true' : 'false');
    }
    function setStatus(msg, sticky) {
      statusEl.textContent = msg;
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      // Transient confirmations auto-clear; the persistent "Unsaved changes"
      // hint sticks until the next save/reload.
      if (msg && !sticky) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2500);
    }
    function markDirty() {
      dirty = true;
      setStatus('Unsaved changes', true);
    }
    function linesToList(text) {
      return String(text || '')
        .split('\\n')
        .map(s => s.trim())
        .filter(Boolean);
    }

    function openMenu()  {
      settingsMenu.hidden = false;
      settingsBtn.setAttribute('aria-expanded', 'true');
      // Reload last-saved values so any unsaved edits from a prior open are
      // discarded — reinforcing that nothing applies until Save.
      reloadSettings();
    }
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
    async function loadRepoFilter() {
      try {
        const res = await fetch('/api/repo-filter');
        const body = await res.json();
        const cfg = body && body.config ? body.config : {};
        repoPatternsEl.value = Array.isArray(cfg.patterns) ? cfg.patterns.join('\\n') : '';
      } catch (e) {
        console.error('failed to load repo filter config', e);
      }
    }
    async function loadDisplayConfig() {
      try {
        const res = await fetch('/api/display-config');
        const body = await res.json();
        if (body && body.config) {
          currentDisplay = sanitizeDisplay(body.config);
          syncMenu();
        }
      } catch (e) {
        console.error('failed to load display config', e);
      }
    }
    function setMenuControlsDisabled(disabled) {
      optCompletion.disabled = disabled;
      optFailure.disabled = disabled;
      optShowOthers.disabled = disabled;
      repoPatternsEl.disabled = disabled;
      saveBtn.disabled = disabled;
    }
    async function reloadSettings() {
      dirty = false;
      // Disable the controls while the last-saved values load so the user
      // can't stage edits that the in-flight GETs would silently overwrite.
      setMenuControlsDisabled(true);
      setStatus('Loading…', true);
      try {
        await Promise.all([loadNotifyConfig(), loadDisplayConfig(), loadRepoFilter()]);
        if (!dirty) setStatus('');
      } finally {
        setMenuControlsDisabled(false);
      }
    }

    // Toggles only stage local state; nothing is persisted until Save. Leave
    // the menu open so the user can flip both before saving.
    optCompletion.addEventListener('click', () => {
      currentConfig.notifyOnRunCompletion = !currentConfig.notifyOnRunCompletion;
      syncMenu();
      markDirty();
    });
    optFailure.addEventListener('click', () => {
      currentConfig.notifyOnJobFailure = !currentConfig.notifyOnJobFailure;
      syncMenu();
      markDirty();
    });
    optShowOthers.addEventListener('click', () => {
      currentDisplay.showOtherSessions = !currentDisplay.showOtherSessions;
      syncMenu();
      markDirty();
    });
    repoPatternsEl.addEventListener('input', markDirty);

    async function saveSettings() {
      // Disable the whole form for the duration of the save so the user can't
      // toggle a checkbox or edit the patterns mid-flight — such edits would
      // be overwritten by the echoed sanitized config and could leave the UI
      // showing "Saved" while holding unsaved changes.
      setMenuControlsDisabled(true);
      setStatus('Saving…', true);
      try {
        // Persist notifications first, then the repo filter. Each endpoint
        // echoes back the sanitized config so we reflect server-side
        // normalization into the form.
        const notifyRes = await fetch('/api/notify-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentConfig),
        });
        const notifyBody = await notifyRes.json().catch(() => null);
        if (!notifyRes.ok || !notifyBody || !notifyBody.config) {
          const d = notifyBody && notifyBody.error ? notifyBody.error : ('HTTP ' + notifyRes.status);
          setStatus('Save failed: ' + d, true);
          return;
        }
        currentConfig = sanitizeCfg(notifyBody.config);
        syncMenu();

        // Persist display preferences next. If this fails, notifications were
        // already saved — report the partial state and stop before the filter.
        const displayRes = await fetch('/api/display-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentDisplay),
        });
        const displayBody = await displayRes.json().catch(() => null);
        if (!displayRes.ok || !displayBody || !displayBody.config) {
          const d = displayBody && displayBody.error ? displayBody.error : ('HTTP ' + displayRes.status);
          setStatus('Notifications saved · display settings failed: ' + d, true);
          return;
        }
        currentDisplay = sanitizeDisplay(displayBody.config);
        syncMenu();

        const repoRes = await fetch('/api/repo-filter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patterns: linesToList(repoPatternsEl.value) }),
        });
        const repoBody = await repoRes.json().catch(() => null);
        if (!repoRes.ok || !repoBody || !repoBody.config) {
          const d = repoBody && repoBody.error ? repoBody.error : ('HTTP ' + repoRes.status);
          // Notifications were already persisted by the POST above, so be
          // explicit about the partial save instead of a generic "Save
          // failed". Leave the form dirty since the repo filter is unsaved.
          setStatus('Notifications saved · repo filter failed: ' + d, true);
          return;
        }
        const cfg = repoBody.config;
        repoPatternsEl.value = Array.isArray(cfg.patterns) ? cfg.patterns.join('\\n') : '';

        dirty = false;
        setStatus('Saved');
        // Close the settings panel now that the save succeeded.
        closeMenu();
        // Re-render the visible tabs so the new filter takes effect. Filtering
        // happens on cache read, so there's no need to force a fresh GitHub
        // query (which would spend rate limit unnecessarily).
        loadCopilot();
        loadAll();
      } catch (e) {
        console.error('failed to save settings', e);
        setStatus('Save failed', true);
      } finally {
        setMenuControlsDisabled(false);
      }
    }
    saveBtn.addEventListener('click', saveSettings);

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
        if (inspectMode) {
          await loadCiRun(true);
        } else {
          await loadCopilot();
          await loadAll(true);
          await loadWatched(true);
        }
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

    // Repaint panels from the snapshot (server-inlined SSR snapshot, or
    // localStorage) before any network work. Sets the correct active surface
    // (inspect run panel or the last dashboard tab) and injects each panel's
    // last HTML, pre-seeding __panelHtmlCache so the first real render is a
    // no-op when nothing changed.
    function hydrateFromSnapshot() {
      const snap = readSnapshot();
      if (!snap || !snap.html) return;
      if (snap.inspect) {
        document.body.classList.add('inspect-mode');
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-cirun'));
      } else if (snap.activeTab) {
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === snap.activeTab));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + snap.activeTab));
      }
      for (const [id, html] of Object.entries(snap.html)) {
        if (typeof html !== 'string') continue;
        const el = document.getElementById(id);
        if (!el) continue;
        el.innerHTML = html;
        el.classList.remove('loading');
        __panelHtmlCache.set(id, html);
      }
      if (snap.counts) {
        for (const [cid, val] of Object.entries(snap.counts)) {
          const c = document.getElementById(cid);
          if (c && typeof val === 'string') c.textContent = val;
        }
      }
    }

    (async () => {
      // (e.g. returning to it after the webview was torn down) doesn't flash
      // the "Loading…" placeholders and drop every row. The loads below then
      // update the same DOM inline — and skip the repaint entirely when the
      // fresh markup matches, since hydrate pre-seeds __panelHtmlCache.
      hydrateFromSnapshot();
      // If the canvas was opened to inspect run(s), dedicate the surface to
      // them and skip the PR tabs (and their GitHub calls) entirely.
      if (await loadCiRun()) return;
      // Not inspect mode after all — clear any inspect chrome a stale snapshot
      // may have applied, then fall back to the dashboard tabs. Persist the
      // cleared inspect flag too: the snapshot is now durable on disk, so an old
      // inspect:true would otherwise keep re-applying inspect chrome on every
      // future load.
      if (document.body.classList.contains('inspect-mode')) {
        document.body.classList.remove('inspect-mode');
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'copilot'));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-copilot'));
      }
      if (__snap.inspect) writeSnapshot({ inspect: false });
      await loadCopilot();
      await loadAll();
      await loadWatched();
    })();
  </script>
</body>
</html>`;

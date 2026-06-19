"use strict";
// Partial Duplicate Checker — Stash UI plugin.
//
// Complements Stash's built-in (whole-file phash) duplicate checker by surfacing
// the partial duplicates it misses — cuts, parts, and montages. Results are
// CLUSTERED under the longest video of each match group: one box shows the long
// video (to keep) and all the clips/cuts/dups of it (selectable for deletion).
(function () {
  const api = window.PluginApi;
  if (!api) {
    console.error("[partialdup] PluginApi not available");
    return;
  }
  const React = api.React;
  const e = React.createElement;
  const { Button, Badge, Spinner, Form } = api.libraries.Bootstrap;
  const { gql, useApolloClient } = api.libraries.Apollo;
  const { Icon } = api.components;
  const FA = api.libraries.FontAwesomeSolid;

  const PLUGIN_ID = "partial_dup_checker";
  const ROUTE = "/partial-duplicates";
  const NATIVE_ROUTE = "/sceneDuplicateChecker";
  const LOG = "[partialdup]";

  const LEVELS = {
    DUPLICATE: { label: "Duplicate", variant: "danger" },
    PART: { label: "Part", variant: "warning" },
    CUT: { label: "Cut/Montage", variant: "info" },
  };

  // In-app help (standard help-doc structure). See HELP.md for the full version.
  const HELP = [
    { t: "Overview", c: [
      ["p", "Finds duplicates Stash's built-in checker can't see — clips, cuts and " +
        "montages taken from videos you already have. It builds a fingerprint timeline " +
        "of each video instead of one hash of the whole file. It runs alongside the " +
        "built-in checker and never changes your library unless you delete or tag something."],
    ]},
    { t: "Quick start", c: [
      ["ol", [
        "Click Scan library — it fingerprints every scene and finds matches (runs in the background).",
        "Each result box is one longer video (kept) with the shorter clips/duplicates of it below.",
        "Tick the clips you want to remove, click Delete N file(s), and confirm.",
      ]],
    ]},
    { t: "Understanding the results", c: [
      ["p", "Each box groups everything related to one longest video. The video at the " +
        "top is marked KEEP · longest — the most complete copy. Below it are the matching " +
        "shorter scenes, each with a level:"],
      ["dl", [
        ["Duplicate", "The same content end to end (a re-encode, recrop, or rewatermark)."],
        ["Part", "A contiguous chunk cut out of the longer video."],
        ["Cut / Montage", "A partial, reordered, or spliced overlap — a compilation."],
      ]],
      ["p", "Each clip shows the match % (how much of that clip was found in the longer " +
        "video) and the matched time range. The All / Duplicate / Part / Cut-Montage tabs " +
        "filter boxes by level."],
    ]},
    { t: "Deleting duplicates", c: [
      ["p", "Tick the clips to remove, then Delete N file(s) → confirm. It deletes those " +
        "scenes AND their files from disk (this cannot be undone) and removes them from the " +
        "results. The longest video (KEEP) is never selectable, so you can't delete the copy " +
        "you're keeping by accident."],
    ]},
    { t: "Scanning", c: [
      ["ul", [
        "Runs in a detached background worker — closing the tab won't stop it.",
        "The first scan is slowest; re-scans skip scenes whose file hasn't changed.",
        "If it looks stuck (running but no movement), a Reset stuck scan button appears — click it, then scan again.",
      ]],
    ]},
    { t: "False positives / tuning", c: [
      ["p", "Because it compares image fingerprints, very similar-looking videos can " +
        "occasionally be matched even when different. The matcher is tunable via the " +
        "set_config operation — segment_hamming (lower = stricter), cut_min_coverage " +
        "(raise to require more overlap), and min_match_seconds (require a longer shared " +
        "run, the best lever against scattered coincidences). Re-scan after changing them; " +
        "no re-fingerprinting is needed."],
    ]},
    { t: "FAQ", c: [
      ["dl", [
        ["Does it change my library?", "No. Scanning only reads. Tags, markers and deletes happen only when you click them."],
        ["Why isn't it a tab on the built-in checker page?", "Stash 0.31 doesn't let plugins patch that page, so it lives as its own page in the nav."],
        ["A video I expected is missing.", "It may have an unreadable file or share too little to pass the threshold. The plugin log lists scenes it couldn't index."],
      ]],
    ]},
  ];

  const renderHelp = () => HELP.map((s, i) =>
    React.createElement("section", { key: i, className: "pdc-help-sec" },
      React.createElement("h4", null, s.t),
      s.c.map((blk, j) => {
        const [kind, val] = blk;
        if (kind === "p") return React.createElement("p", { key: j }, val);
        if (kind === "ul")
          return React.createElement("ul", { key: j }, val.map((x, k) => React.createElement("li", { key: k }, x)));
        if (kind === "ol")
          return React.createElement("ol", { key: j }, val.map((x, k) => React.createElement("li", { key: k }, x)));
        if (kind === "dl")
          return React.createElement("dl", { key: j }, val.flatMap((pr, k) =>
            [React.createElement("dt", { key: "t" + k }, pr[0]),
             React.createElement("dd", { key: "d" + k }, pr[1])]));
        return null;
      })));

  const RUN_OPERATION = gql`
    mutation PartialDup_Run($id: ID!, $args: Map!) {
      runPluginOperation(plugin_id: $id, args: $args)
    }
  `;

  const navigateTo = (path) => {
    if (api.utils && typeof api.utils.navigate === "function") api.utils.navigate(path);
    else window.location.assign(path);
  };

  const fmtTime = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  const basename = (p) => (p || "").replace(/\\/g, "/").split("/").pop();

  const thumb = (id, meta, cls) =>
    e("a", { href: `/scenes/${id}`, target: "_blank", rel: "noreferrer" },
      e("img", { className: cls || "pdc-thumb", loading: "lazy",
        src: `/scene/${id}/screenshot`, alt: (meta && meta.title) || `Scene ${id}` }));

  const titleLink = (id, meta) =>
    e("a", { href: `/scenes/${id}`, target: "_blank", rel: "noreferrer",
      className: "pdc-title", title: (meta && (meta.title || meta.path)) || `Scene ${id}` },
      (meta && (meta.title || basename(meta.path))) || `Scene ${id}`);

  // ----- one matched clip row (a cluster member) -------------------------- //
  const MemberRow = ({ m, checked, onToggle }) => {
    const lv = LEVELS[m.level] || { label: m.level || "?", variant: "secondary" };
    const range = (m.runs && m.runs[0])
      ? ` · ${fmtTime(m.runs[0].b_start)}–${fmtTime(m.runs[0].b_end)}`
      : "";
    return e("label", { className: "pdc-member" + (checked ? " pdc-sel" : "") },
      e(Form.Check, { type: "checkbox", checked: checked, onChange: onToggle,
        className: "pdc-check" }),
      thumb(m.scene_id, m.meta, "pdc-thumb-sm"),
      e("div", { className: "pdc-member-meta" },
        e("div", { className: "pdc-member-top" },
          e(Badge, { variant: lv.variant, bg: lv.variant }, lv.label),
          e("span", { className: "pdc-conf" },
            m.confidence != null ? `${Math.round(m.confidence * 100)}%` : ""),
          m.meta && m.meta.duration
            ? e("span", { className: "pdc-dur" }, fmtTime(m.meta.duration)) : null),
        titleLink(m.scene_id, m.meta),
        e("span", { className: "pdc-cov" },
          m.coverage_b != null ? `${Math.round(m.coverage_b * 100)}% of this clip matched${range}` : "")));
  };

  // ----- one cluster box (parent = longest video + its clips) ------------- //
  const ClusterCard = ({ cluster, selected, onToggle, onSelectAllClips }) => {
    const p = cluster.parent || {};
    const pm = p.meta || {};
    const allSel = cluster.members.length > 0 &&
      cluster.members.every((m) => selected.has(m.scene_id));
    return e("div", { className: "pdc-cluster" },
      e("div", { className: "pdc-parent" },
        thumb(p.scene_id, pm, "pdc-thumb"),
        e("div", { className: "pdc-parent-meta" },
          e("span", { className: "pdc-keep" }, "KEEP · longest"),
          titleLink(p.scene_id, pm),
          e("span", { className: "pdc-dur" }, pm.duration ? fmtTime(pm.duration) : "")),
        e("div", { className: "pdc-cluster-actions" },
          e("span", { className: "pdc-count" },
            `${cluster.members.length} match${cluster.members.length === 1 ? "" : "es"}`),
          e(Form.Check, { type: "checkbox", checked: allSel, label: "select all",
            onChange: () => onSelectAllClips(cluster, !allSel) }))),
      e("div", { className: "pdc-members" },
        cluster.members.map((m) =>
          e(MemberRow, { key: m.scene_id, m: m, checked: selected.has(m.scene_id),
            onToggle: () => onToggle(m.scene_id) }))));
  };

  // ----- main page -------------------------------------------------------- //
  const PartialDupPage = () => {
    const client = useApolloClient();
    const [clusters, setClusters] = React.useState([]);
    const [selected, setSelected] = React.useState(() => new Set());
    const [status, setStatus] = React.useState(null);
    const [tab, setTab] = React.useState("ALL");
    const [err, setErr] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [showHelp, setShowHelp] = React.useState(false);
    const aliveRef = React.useRef(true);

    const run = React.useCallback(async (action, extra) => {
      const resp = await client.mutate({
        mutation: RUN_OPERATION,
        variables: { id: PLUGIN_ID, args: Object.assign({ action }, extra || {}) },
      });
      return resp && resp.data && resp.data.runPluginOperation;
    }, [client]);

    const loadClusters = React.useCallback(async () => {
      try {
        const r = await run("clusters");
        if (aliveRef.current) setClusters((r && r.clusters) || []);
      } catch (ex) { if (aliveRef.current) setErr(ex.message || String(ex)); }
    }, [run]);

    React.useEffect(() => {
      aliveRef.current = true;
      let prevRunning = false;
      const poll = async () => {
        if (!aliveRef.current) return;
        try {
          const s = await run("scan_status");
          if (!aliveRef.current) return;
          setStatus(s);
          if (prevRunning && !(s && s.running)) await loadClusters();
          prevRunning = !!(s && s.running);
        } catch (ex) { /* transient */ }
        if (aliveRef.current) setTimeout(poll, 3000);
      };
      loadClusters();
      poll();
      return () => { aliveRef.current = false; };
    }, [run, loadClusters]);

    const startScan = async () => {
      setErr(null);
      try { await run("scan"); setTimeout(() => run("scan_status").then(setStatus), 400); }
      catch (ex) { setErr(ex.message || String(ex)); }
    };
    const resetScan = async () => {
      setErr(null);
      try { await run("reset"); setStatus(await run("scan_status")); }
      catch (ex) { setErr(ex.message || String(ex)); }
    };

    const toggle = (id) => setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    const selectAllClips = (cluster, on) => setSelected((prev) => {
      const n = new Set(prev);
      cluster.members.forEach((m) => on ? n.add(m.scene_id) : n.delete(m.scene_id));
      return n;
    });

    const deleteSelected = async () => {
      const ids = Array.from(selected);
      if (!ids.length) return;
      if (!window.confirm(
        `Delete ${ids.length} selected scene(s) AND their files from disk?\n` +
        `The longest video in each box is kept. This cannot be undone.`)) return;
      setBusy(true); setErr(null);
      try {
        const r = await run("delete_scenes", { scene_ids: ids, delete_file: true });
        const gone = new Set((r && r.deleted) || []);
        // drop deleted members; drop clusters left with no members
        setClusters((cs) => cs
          .map((c) => Object.assign({}, c, {
            members: c.members.filter((m) => !gone.has(m.scene_id)),
          }))
          .map((c) => Object.assign({}, c, { size: c.members.length }))
          .filter((c) => c.members.length > 0));
        setSelected(new Set());
        if (r && r.failed && r.failed.length) {
          setErr(`${r.failed.length} deletion(s) failed (see plugin log).`);
        }
      } catch (ex) { setErr(ex.message || String(ex)); }
      finally { setBusy(false); }
    };

    // filter clusters by tab (those containing a member of the level)
    const shown = tab === "ALL"
      ? clusters
      : clusters.filter((c) => c.members.some((m) => m.level === tab));
    const running = status && status.running;
    const totalMatches = clusters.reduce((a, c) => a + c.members.length, 0);

    const tabBtn = (key, label) => e(Button, {
      key, size: "sm", variant: tab === key ? "primary" : "outline-secondary",
      className: "pdc-tab", onClick: () => setTab(key),
    }, label);

    const progress = running
      ? e("span", { className: "pdc-status" },
          e(Spinner, { animation: "border", size: "sm" }),
          ` ${status.phase || ""} ` +
          (status.phase === "matching" && status.pairs_total
            ? `${status.pairs_done || 0}/${status.pairs_total}`
            : `${status.scenes_done || 0}/${status.scenes_total || 0}`))
      : status && status.phase === "done"
        ? e("span", { className: "pdc-status" },
            `${status.groups || 0} matches across ${clusters.length} group(s)`)
        : null;

    return e("div", { className: "pdc-page" },
      e("div", { className: "pdc-header" },
        e("h3", null, "Partial Duplicate Checker"),
        e("p", { className: "pdc-sub" },
          "Cuts, parts and montages Stash's built-in checker can't see. Each box is a ",
          "video and the shorter clips/dups taken from it — keep the long one, delete the rest. ",
          e("a", { href: NATIVE_ROUTE }, "Built-in checker →"))),
      e("div", { className: "pdc-toolbar" },
        e(Button, { variant: "primary", disabled: running, onClick: startScan },
          running ? "Scanning…" : "Scan library"),
        progress,
        (status && status.running && status.worker_alive === false)
          ? e(Button, { size: "sm", variant: "warning", onClick: resetScan },
              "Reset stuck scan") : null,
        e(Button, { size: "sm", variant: showHelp ? "info" : "outline-info",
          className: "pdc-help-btn", onClick: () => setShowHelp((v) => !v),
          title: "How this works" }, showHelp ? "Hide help" : "Help")),
      showHelp
        ? e("div", { className: "pdc-help" },
            e("div", { className: "pdc-help-head" },
              e("strong", null, "Partial Duplicate Checker — Help"),
              e(Button, { size: "sm", variant: "outline-secondary",
                onClick: () => setShowHelp(false) }, "Close")),
            renderHelp())
        : null,
      err ? e("div", { className: "pdc-error" }, `Error: ${err}`) : null,
      e("div", { className: "pdc-tabs" },
        tabBtn("ALL", `All (${totalMatches})`), tabBtn("DUPLICATE", "Duplicate"),
        tabBtn("PART", "Part"), tabBtn("CUT", "Cut/Montage")),
      // sticky delete bar
      selected.size > 0
        ? e("div", { className: "pdc-delbar" },
            e("span", null, `${selected.size} selected`),
            e(Button, { variant: "danger", size: "sm", disabled: busy, onClick: deleteSelected },
              busy ? "Deleting…" : `Delete ${selected.size} file(s)`),
            e(Button, { variant: "outline-secondary", size: "sm", disabled: busy,
              onClick: () => setSelected(new Set()) }, "Clear"))
        : null,
      shown.length === 0
        ? e("div", { className: "pdc-empty" },
            running ? "Scanning…"
              : clusters.length === 0 ? "No partial duplicates found yet. Run a scan."
                : "Nothing in this tab.")
        : e("div", { className: "pdc-clusters" },
            shown.map((c) => e(ClusterCard, {
              key: c.parent.scene_id, cluster: c, selected: selected,
              onToggle: toggle, onSelectAllClips: selectAllClips }))));
  };

  // ----- nav entries ------------------------------------------------------ //
  const NavButton = () =>
    e(Button, { className: "nav-utility minimal", title: "Partial Duplicate Checker",
      variant: "secondary", onClick: () => navigateTo(ROUTE) },
      e(Icon, { icon: FA.faClone }));

  try {
    api.register.route(ROUTE, PartialDupPage);
  } catch (ex) { console.error(`${LOG} register.route failed`, ex); }

  try {
    api.patch.before("MainNavBar.UtilityItems", function (props) {
      return [{ children: e(React.Fragment, null, props.children, e(NavButton, null)) }];
    });
  } catch (ex) { console.error(`${LOG} navbar patch failed`, ex); }

  // Stash v0.31.1 exposes only 4 patchable components — a first-class main-nav
  // menu item is the most integrated entry available (Settings▸Tools and the
  // built-in duplicate-checker page are not patchable).
  try {
    api.patch.before("MainNavBar.MenuItems", function (props) {
      const link = e("div", {
        key: "pdc-menu", className: "nav-link pdc-menu-link", role: "button",
        onClick: () => navigateTo(ROUTE), title: "Partial Duplicate Checker",
      }, e(Icon, { icon: FA.faClone }), e("span", { className: "pdc-menu-label" }, "Partial Dup"));
      return [{ children: e(React.Fragment, null, props.children, link) }];
    });
  } catch (ex) { console.error(`${LOG} menu patch failed`, ex); }

  console.log(`${LOG} plugin loaded (v0.1.0)`);
})();

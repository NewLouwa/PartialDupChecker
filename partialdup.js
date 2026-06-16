"use strict";
// Partial Duplicate Checker — Stash UI plugin.
//
// Complements Stash's built-in (whole-file phash) duplicate checker by surfacing
// the partial duplicates it misses — cuts, parts, and montages — on a dedicated
// page with a tab per level (Duplicate / Part / Cut-Montage). Talks to the Python
// backend via runPluginOperation(args:{action,...}), which returns the action's
// output object directly (a non-null python `error` becomes a GraphQL error).
(function () {
  const api = window.PluginApi;
  if (!api) {
    console.error("[partialdup] PluginApi not available");
    return;
  }
  const React = api.React;
  const { Button, Badge, Spinner } = api.libraries.Bootstrap;
  const { gql, useApolloClient } = api.libraries.Apollo;
  const { Icon } = api.components;
  const FA = api.libraries.FontAwesomeSolid;

  const PLUGIN_ID = "partial_dup_checker";
  const ROUTE = "/partial-duplicates";
  const NATIVE_ROUTE = "/sceneDuplicateChecker";
  const LOG = "[partialdup]";

  const LEVELS = {
    DUPLICATE: { label: "Duplicate", variant: "danger", blurb: "Same content end-to-end (re-encode / recrop)." },
    PART: { label: "Part / Contains", variant: "warning", blurb: "One scene is a contiguous chunk of a longer one." },
    CUT: { label: "Cut / Montage", variant: "info", blurb: "Partial, reordered, or spliced overlap." },
  };

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
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, "0");
    return `${m}:${ss}`;
  };

  // ----- one matched-relationship card ------------------------------------- //
  const GroupCard = ({ group, onApply }) => {
    const lv = LEVELS[group.level] || { label: group.level, variant: "secondary" };
    const a = group.scene_a_meta || {};
    const b = group.scene_b_meta || {};
    const [busy, setBusy] = React.useState(false);

    const sceneTile = (id, meta, role) =>
      React.createElement("div", { className: "pdc-scene" },
        React.createElement("a", { href: `/scenes/${id}`, target: "_blank", rel: "noreferrer" },
          React.createElement("img", {
            className: "pdc-thumb", loading: "lazy",
            src: `/scene/${id}/screenshot`, alt: meta.title || `Scene ${id}`,
          })),
        React.createElement("div", { className: "pdc-scene-meta" },
          React.createElement("span", { className: "pdc-role" }, role),
          React.createElement("a", { href: `/scenes/${id}`, target: "_blank", rel: "noreferrer",
            className: "pdc-title", title: meta.title || meta.path },
            meta.title || (meta.path || "").split(/[\\/]/).pop() || `Scene ${id}`),
          React.createElement("span", { className: "pdc-dur" },
            meta.duration ? fmtTime(meta.duration) : "")));

    const ranges = (group.runs || []).slice(0, 12).map((r, i) =>
      React.createElement("li", { key: i, className: "pdc-range" },
        React.createElement("span", { className: "pdc-range-b" }, `${fmtTime(r.b_start)}–${fmtTime(r.b_end)}`),
        React.createElement("span", { className: "pdc-range-arrow" }, " ↔ "),
        React.createElement("span", { className: "pdc-range-a" }, `${fmtTime(r.a_start)}–${fmtTime(r.a_end)}`)));

    const apply = async () => {
      setBusy(true);
      try { await onApply(group); } finally { setBusy(false); }
    };

    return React.createElement("div", { className: `pdc-card pdc-${group.level}` },
      React.createElement("div", { className: "pdc-card-head" },
        React.createElement(Badge, { variant: lv.variant, bg: lv.variant }, lv.label),
        React.createElement("span", { className: "pdc-conf" }, `confidence ${(group.confidence * 100).toFixed(0)}%`),
        group.applied ? React.createElement(Badge, { variant: "success", bg: "success" }, "tagged") : null),
      React.createElement("div", { className: "pdc-scenes" },
        sceneTile(group.scene_a, a, "Longer / contains"),
        React.createElement("div", { className: "pdc-vs" }, "▶"),
        sceneTile(group.scene_b, b, "Shorter / clip")),
      React.createElement("div", { className: "pdc-detail" },
        React.createElement("div", { className: "pdc-cov" },
          `B covered ${(group.coverage_b * 100).toFixed(0)}% · A covered ${(group.coverage_a * 100).toFixed(0)}%`),
        ranges.length
          ? React.createElement("ul", { className: "pdc-ranges" }, ranges)
          : null),
      React.createElement("div", { className: "pdc-actions" },
        React.createElement(Button, {
          size: "sm", variant: "secondary", disabled: busy || group.applied,
          onClick: apply, title: "Add tags + scene markers for this match (opt-in)",
        }, busy ? "Applying…" : group.applied ? "Tagged" : "Tag + mark"),
        React.createElement(Button, {
          size: "sm", variant: "outline-secondary",
          onClick: () => window.open(`/scenes/${group.scene_b}`, "_blank"),
        }, "Open clip")));
  };

  // ----- main page --------------------------------------------------------- //
  const PartialDupPage = () => {
    const client = useApolloClient();
    const [groups, setGroups] = React.useState([]);
    const [status, setStatus] = React.useState(null);
    const [tab, setTab] = React.useState("ALL");
    const [err, setErr] = React.useState(null);
    const aliveRef = React.useRef(true);

    const run = React.useCallback(async (action, extra) => {
      const resp = await client.mutate({
        mutation: RUN_OPERATION,
        variables: { id: PLUGIN_ID, args: Object.assign({ action }, extra || {}) },
      });
      return resp && resp.data && resp.data.runPluginOperation;
    }, [client]);

    const loadResults = React.useCallback(async () => {
      try {
        const r = await run("results", { limit: 1000 });
        if (aliveRef.current) setGroups((r && r.groups) || []);
      } catch (e) {
        if (aliveRef.current) setErr(e.message || String(e));
      }
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
          if (prevRunning && !(s && s.running)) await loadResults();
          prevRunning = !!(s && s.running);
        } catch (e) { /* transient */ }
        if (aliveRef.current) setTimeout(poll, 2500);
      };
      loadResults();
      poll();
      return () => { aliveRef.current = false; };
    }, [run, loadResults]);

    const startScan = async () => {
      setErr(null);
      try { await run("scan"); setTimeout(() => run("scan_status").then(setStatus), 400); }
      catch (e) { setErr(e.message || String(e)); }
    };

    const resetScan = async () => {
      setErr(null);
      try { await run("reset"); const s = await run("scan_status"); setStatus(s); }
      catch (e) { setErr(e.message || String(e)); }
    };

    const applyGroup = async (group) => {
      try {
        await run("apply", { group_id: group.group_id });
        setGroups((gs) => gs.map((g) => g.group_id === group.group_id ? Object.assign({}, g, { applied: 1 }) : g));
      } catch (e) { setErr(e.message || String(e)); }
    };

    const counts = groups.reduce((acc, g) => { acc[g.level] = (acc[g.level] || 0) + 1; return acc; }, {});
    const shown = tab === "ALL" ? groups : groups.filter((g) => g.level === tab);
    const running = status && status.running;

    const tabBtn = (key, label) =>
      React.createElement(Button, {
        key, size: "sm",
        variant: tab === key ? "primary" : "outline-secondary",
        className: "pdc-tab", onClick: () => setTab(key),
      }, `${label}${key === "ALL" ? ` (${groups.length})` : counts[key] ? ` (${counts[key]})` : ""}`);

    return React.createElement("div", { className: "pdc-page" },
      React.createElement("div", { className: "pdc-header" },
        React.createElement("h3", null, "Partial Duplicate Checker"),
        React.createElement("p", { className: "pdc-sub" },
          "Finds cuts, parts and montages that Stash's built-in duplicate checker can't — it compares whole-file hashes only. ",
          React.createElement("a", { href: NATIVE_ROUTE }, "Open the built-in checker →"))),
      React.createElement("div", { className: "pdc-toolbar" },
        React.createElement(Button, { variant: "primary", disabled: running, onClick: startScan },
          running ? "Scanning…" : "Scan library"),
        running
          ? React.createElement("span", { className: "pdc-status" },
              React.createElement(Spinner, { animation: "border", size: "sm" }),
              ` ${status.phase || ""} ${status.scenes_done || 0}/${status.scenes_total || 0}`
              + (status.errors ? ` · ${status.errors} errors` : ""))
          : status && status.phase === "done"
            ? React.createElement("span", { className: "pdc-status" },
                `Last scan: ${status.scenes_done || 0} scenes, ${status.groups || groups.length} groups`)
            : null,
        (status && status.running && status.worker_alive === false)
          ? React.createElement(Button, {
              size: "sm", variant: "warning", onClick: resetScan,
              title: "The scan worker is no longer running — clear the stuck status",
            }, "Reset stuck scan")
          : null),
      err ? React.createElement("div", { className: "pdc-error" }, `Error: ${err}`) : null,
      React.createElement("div", { className: "pdc-tabs" },
        tabBtn("ALL", "All"), tabBtn("DUPLICATE", "Duplicate"),
        tabBtn("PART", "Part"), tabBtn("CUT", "Cut / Montage")),
      shown.length === 0
        ? React.createElement("div", { className: "pdc-empty" },
            running ? "Scanning…"
              : groups.length === 0 ? "No partial duplicates found yet. Run a scan."
                : "Nothing in this tab.")
        : React.createElement("div", { className: "pdc-cards" },
            shown.map((g) => React.createElement(GroupCard, { key: g.group_id, group: g, onApply: applyGroup }))));
  };

  // ----- nav button -------------------------------------------------------- //
  const NavButton = () =>
    React.createElement(Button, {
      className: "nav-utility minimal", title: "Partial Duplicate Checker",
      variant: "secondary", onClick: () => navigateTo(ROUTE),
    }, React.createElement(Icon, { icon: FA.faClone }));

  // ----- registration ------------------------------------------------------ //
  try {
    api.register.route(ROUTE, PartialDupPage);
  } catch (e) { console.error(`${LOG} register.route failed`, e); }

  try {
    api.patch.before("MainNavBar.UtilityItems", function (props) {
      return [{
        children: React.createElement(React.Fragment, null, props.children,
          React.createElement(NavButton, null)),
      }];
    });
  } catch (e) { console.error(`${LOG} navbar patch failed`, e); }

  // Best-effort: surface a link on the native Duplicate Checker page so the two
  // tools sit together. If the component isn't patchable in this Stash build the
  // patch simply never fires — the nav button remains the reliable entry point.
  try {
    api.patch.after("SceneDuplicateChecker", function (props, _, result) {
      const banner = React.createElement("div", { className: "pdc-native-banner", key: "pdc-banner" },
        React.createElement(Button, { size: "sm", variant: "info", onClick: () => navigateTo(ROUTE) },
          "→ Partial Duplicate Checker (cuts / parts / montages)"));
      return React.createElement(React.Fragment, null, banner, result);
    });
  } catch (e) { /* component not patchable in this build — fine */ }

  console.log(`${LOG} plugin loaded (v0.1.0)`);
})();

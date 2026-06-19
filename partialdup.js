"use strict";
// Partial Duplicate Checker - Stash UI plugin.
//
// Complements Stash's built-in (whole-file phash) duplicate checker. Two modes:
//   Videos - cuts/parts/montages, clustered under the longest video.
//   Images - near-duplicates (keep one) using Stash's native image phash, plus
//            auto-collecting similar images into galleries.
// Never changes the library unless you delete (opt-in).
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

  const HELP = [
    { t: "Overview", c: [
      ["p", "Finds duplicates Stash's built-in checker can't see. Videos: clips, cuts " +
        "and montages taken from videos you already have. Images: near-duplicates (crops/" +
        "resizes/re-encodes) plus visually-similar groups. It never changes your library " +
        "unless you delete something."],
    ]},
    { t: "Quick start", c: [
      ["ol", [
        "Pick Videos or Images at the top.",
        "Click Scan - it runs in the background (also available in Settings > Tasks).",
        "Each box is one item to KEEP (the longest video / largest image) with the " +
          "duplicates below.",
        "Tick the ones to remove, click Delete, and confirm.",
      ]],
    ]},
    { t: "Levels (videos)", c: [
      ["dl", [
        ["Duplicate", "Same content end to end (re-encode/recrop)."],
        ["Part", "A contiguous chunk of the longer video."],
        ["Cut / Montage", "A partial, reordered or spliced overlap."],
      ]],
    ]},
    { t: "Images + galleries", c: [
      ["p", "Near-duplicate images are grouped keep-one (largest kept). Visually-similar " +
        "(non-identical) images can be auto-collected into Stash galleries - this is " +
        "DRY-RUN by default (it only reports what it would create); flip the dry-run toggle " +
        "to actually create them."],
    ]},
    { t: "Deleting", c: [
      ["p", "The KEEP item is never selectable, so you can't delete the copy you're " +
        "keeping. Delete removes the selected items AND their files from disk - it cannot " +
        "be undone."],
    ]},
    { t: "FAQ", c: [
      ["dl", [
        ["Does it change my library?", "No. Scanning only reads. Deletes happen only when you click them."],
        ["Where do I run it?", "This page, or Settings > Tasks > Plugin Tasks (with a progress bar + notification)."],
      ]],
    ]},
  ];

  const renderHelp = () => HELP.map((s, i) =>
    e("section", { key: i, className: "pdc-help-sec" },
      e("h4", null, s.t),
      s.c.map((blk, j) => {
        const [kind, val] = blk;
        if (kind === "p") return e("p", { key: j }, val);
        if (kind === "ul") return e("ul", { key: j }, val.map((x, k) => e("li", { key: k }, x)));
        if (kind === "ol") return e("ol", { key: j }, val.map((x, k) => e("li", { key: k }, x)));
        if (kind === "dl") return e("dl", { key: j }, val.flatMap((pr, k) =>
          [e("dt", { key: "t" + k }, pr[0]), e("dd", { key: "d" + k }, pr[1])]));
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
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  const basename = (p) => (p || "").replace(/\\/g, "/").split("/").pop();

  const sThumb = (id, meta) =>
    e("a", { href: `/scenes/${id}`, target: "_blank", rel: "noreferrer" },
      e("img", { className: "pdc-thumb-sm", loading: "lazy", src: `/scene/${id}/screenshot`,
        alt: (meta && meta.title) || `Scene ${id}` }));
  const iThumb = (id, meta) =>
    e("a", { href: `/images/${id}`, target: "_blank", rel: "noreferrer" },
      e("img", { className: "pdc-thumb-sm", loading: "lazy", src: `/image/${id}/thumbnail`,
        alt: (meta && meta.title) || `Image ${id}` }));
  const sLink = (id, meta) =>
    e("a", { href: `/scenes/${id}`, target: "_blank", rel: "noreferrer", className: "pdc-title",
      title: (meta && (meta.title || meta.path)) || `Scene ${id}` },
      (meta && (meta.title || basename(meta.path))) || `Scene ${id}`);
  const iLink = (id, meta) =>
    e("a", { href: `/images/${id}`, target: "_blank", rel: "noreferrer", className: "pdc-title",
      title: (meta && meta.title) || `Image ${id}` },
      (meta && meta.title) || `Image ${id}`);

  // ---- video cluster card ------------------------------------------------ //
  const VideoCard = ({ cluster, selected, onToggle, onAll }) => {
    const p = cluster.parent || {}, pm = p.meta || {};
    const allSel = cluster.members.length > 0 && cluster.members.every((m) => selected.has(m.scene_id));
    return e("div", { className: "pdc-cluster" },
      e("div", { className: "pdc-parent" },
        e("a", { href: `/scenes/${p.scene_id}`, target: "_blank", rel: "noreferrer" },
          e("img", { className: "pdc-thumb", loading: "lazy", src: `/scene/${p.scene_id}/screenshot` })),
        e("div", { className: "pdc-parent-meta" },
          e("span", { className: "pdc-keep" }, "KEEP - longest"),
          sLink(p.scene_id, pm),
          e("span", { className: "pdc-dur" }, pm.duration ? fmtTime(pm.duration) : "")),
        e("div", { className: "pdc-cluster-actions" },
          e("span", { className: "pdc-count" }, `${cluster.members.length} match${cluster.members.length === 1 ? "" : "es"}`),
          e(Form.Check, { type: "checkbox", checked: allSel, label: "select all", onChange: () => onAll(cluster, !allSel) }))),
      e("div", { className: "pdc-members" },
        cluster.members.map((m) => {
          const lv = LEVELS[m.level] || { label: m.level || "?", variant: "secondary" };
          const rg = m.runs && m.runs[0];
          const r = rg ? ` - ${fmtTime(rg.b_start)}-${fmtTime(rg.b_end)}` : "";
          return e("label", { key: m.scene_id, className: "pdc-member" + (selected.has(m.scene_id) ? " pdc-sel" : "") },
            e(Form.Check, { type: "checkbox", checked: selected.has(m.scene_id), onChange: () => onToggle(m.scene_id), className: "pdc-check" }),
            sThumb(m.scene_id, m.meta),
            e("div", { className: "pdc-member-meta" },
              e("div", { className: "pdc-member-top" },
                e(Badge, { variant: lv.variant, bg: lv.variant }, lv.label),
                e("span", { className: "pdc-conf" }, m.confidence != null ? `${Math.round(m.confidence * 100)}%` : ""),
                e("span", { className: "pdc-dur" }, m.meta && m.meta.duration ? fmtTime(m.meta.duration) : "")),
              sLink(m.scene_id, m.meta),
              e("span", { className: "pdc-cov" }, m.coverage_b != null ? `${Math.round(m.coverage_b * 100)}% matched${r}` : "")));
        })));
  };

  // ---- image cluster card ------------------------------------------------ //
  const ImageCard = ({ cluster, selected, onToggle, onAll }) => {
    const p = cluster.parent || {}, pm = p.meta || {};
    const px = (m) => m && m.w && m.h ? `${m.w}x${m.h}` : "";
    const allSel = cluster.members.length > 0 && cluster.members.every((m) => selected.has(m.image_id));
    return e("div", { className: "pdc-cluster" },
      e("div", { className: "pdc-parent" },
        e("a", { href: `/images/${p.image_id}`, target: "_blank", rel: "noreferrer" },
          e("img", { className: "pdc-thumb", loading: "lazy", src: `/image/${p.image_id}/thumbnail` })),
        e("div", { className: "pdc-parent-meta" },
          e("span", { className: "pdc-keep" }, "KEEP - largest"),
          iLink(p.image_id, pm),
          e("span", { className: "pdc-dur" }, px(pm))),
        e("div", { className: "pdc-cluster-actions" },
          e("span", { className: "pdc-count" }, `${cluster.members.length} dup${cluster.members.length === 1 ? "" : "s"}`),
          e(Form.Check, { type: "checkbox", checked: allSel, label: "select all", onChange: () => onAll(cluster, !allSel) }))),
      e("div", { className: "pdc-members" },
        cluster.members.map((m) =>
          e("label", { key: m.image_id, className: "pdc-member" + (selected.has(m.image_id) ? " pdc-sel" : "") },
            e(Form.Check, { type: "checkbox", checked: selected.has(m.image_id), onChange: () => onToggle(m.image_id), className: "pdc-check" }),
            iThumb(m.image_id, m.meta),
            e("div", { className: "pdc-member-meta" },
              e(Badge, { variant: "danger", bg: "danger" }, "near-duplicate"),
              iLink(m.image_id, m.meta),
              e("span", { className: "pdc-cov" }, px(m.meta)))))));
  };

  // ---- main page --------------------------------------------------------- //
  const PartialDupPage = () => {
    const client = useApolloClient();
    const [media, setMedia] = React.useState("video");   // 'video' | 'image'
    const [vClusters, setVClusters] = React.useState([]);
    const [iClusters, setIClusters] = React.useState([]);
    const [iSummary, setISummary] = React.useState(null);
    const [dryRun, setDryRun] = React.useState(true);
    const [skipGal, setSkipGal] = React.useState(true);
    const [excludeIds, setExcludeIds] = React.useState("");
    const [status, setStatus] = React.useState(null);
    const [tab, setTab] = React.useState("ALL");
    const [selected, setSelected] = React.useState(() => new Set());
    const [err, setErr] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [showHelp, setShowHelp] = React.useState(false);
    const aliveRef = React.useRef(true);
    const mediaRef = React.useRef(media);
    mediaRef.current = media;

    const run = React.useCallback(async (action, extra) => {
      const resp = await client.mutate({ mutation: RUN_OPERATION,
        variables: { id: PLUGIN_ID, args: Object.assign({ action }, extra || {}) } });
      return resp && resp.data && resp.data.runPluginOperation;
    }, [client]);

    const loadVideo = React.useCallback(async () => {
      try { const r = await run("clusters"); if (aliveRef.current) setVClusters((r && r.clusters) || []); }
      catch (ex) { if (aliveRef.current) setErr(ex.message || String(ex)); }
    }, [run]);
    const loadImage = React.useCallback(async () => {
      try {
        const r = await run("image_clusters");
        if (!aliveRef.current) return;
        setIClusters((r && r.clusters) || []);
        setISummary((r && r.summary) || null);
        if (r && r.summary && typeof r.summary.dry_run === "boolean") setDryRun(r.summary.dry_run);
      } catch (ex) { if (aliveRef.current) setErr(ex.message || String(ex)); }
    }, [run]);

    const loadConfig = React.useCallback(async () => {
      try {
        const c = await run("get_config");
        if (!aliveRef.current || !c) return;
        if (typeof c.gallery_dry_run === "boolean") setDryRun(c.gallery_dry_run);
        if (typeof c.gallery_skip_in_gallery === "boolean") setSkipGal(c.gallery_skip_in_gallery);
        setExcludeIds((c.gallery_exclude_ids || []).join(","));
      } catch (ex) { /* non-fatal */ }
    }, [run]);

    React.useEffect(() => {
      aliveRef.current = true;
      let prev = false;
      const poll = async () => {
        if (!aliveRef.current) return;
        try {
          const s = await run("scan_status");
          if (!aliveRef.current) return;
          setStatus(s);
          if (prev && !(s && s.running)) { mediaRef.current === "image" ? await loadImage() : await loadVideo(); }
          prev = !!(s && s.running);
        } catch (ex) { /* transient */ }
        if (aliveRef.current) setTimeout(poll, 3000);
      };
      loadVideo(); loadImage(); loadConfig(); poll();
      return () => { aliveRef.current = false; };
    }, [run, loadVideo, loadImage, loadConfig]);

    const switchMedia = (m) => { setMedia(m); setSelected(new Set()); setTab("ALL"); setErr(null); };
    const startScan = async () => {
      setErr(null);
      try { await run(media === "image" ? "scan_images" : "scan"); setTimeout(() => run("scan_status").then(setStatus), 400); }
      catch (ex) { setErr(ex.message || String(ex)); }
    };
    const resetScan = async () => {
      setErr(null);
      try { await run("reset"); setStatus(await run("scan_status")); } catch (ex) { setErr(ex.message || String(ex)); }
    };
    const toggleDryRun = async () => {
      const nv = !dryRun;
      setDryRun(nv);
      try { await run("set_config", { config: { gallery_dry_run: nv } }); } catch (ex) { setErr(ex.message || String(ex)); }
    };
    const toggleSkipGal = async () => {
      const nv = !skipGal;
      setSkipGal(nv);
      try { await run("set_config", { config: { gallery_skip_in_gallery: nv } }); } catch (ex) { setErr(ex.message || String(ex)); }
    };
    const applyExclude = async () => {
      const ids = excludeIds.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      try { await run("set_config", { config: { gallery_exclude_ids: ids } }); setExcludeIds(ids.join(",")); }
      catch (ex) { setErr(ex.message || String(ex)); }
    };

    const toggle = (id) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const selAll = (cluster, on) => setSelected((p) => {
      const n = new Set(p), key = media === "image" ? "image_id" : "scene_id";
      cluster.members.forEach((m) => on ? n.add(m[key]) : n.delete(m[key])); return n;
    });

    const deleteSelected = async () => {
      const ids = Array.from(selected);
      if (!ids.length) return;
      const what = media === "image" ? "image" : "scene";
      if (!window.confirm(`Delete ${ids.length} ${what}(s) AND their files from disk?\nThe KEEP item in each box is preserved. This cannot be undone.`)) return;
      setBusy(true); setErr(null);
      try {
        const r = media === "image"
          ? await run("delete_images", { image_ids: ids, delete_file: true })
          : await run("delete_scenes", { scene_ids: ids, delete_file: true });
        const gone = new Set((r && r.deleted) || []);
        const key = media === "image" ? "image_id" : "scene_id";
        const setC = media === "image" ? setIClusters : setVClusters;
        setC((cs) => cs.map((c) => Object.assign({}, c, { members: c.members.filter((m) => !gone.has(m[key])) }))
          .filter((c) => c.members.length > 0));
        setSelected(new Set());
        if (r && r.failed && r.failed.length) setErr(`${r.failed.length} deletion(s) failed (see plugin log).`);
      } catch (ex) { setErr(ex.message || String(ex)); }
      finally { setBusy(false); }
    };

    const running = status && status.running;
    const clusters = media === "image" ? iClusters
      : (tab === "ALL" ? vClusters : vClusters.filter((c) => c.members.some((m) => m.level === tab)));
    const vTotal = vClusters.reduce((a, c) => a + c.members.length, 0);

    const tabBtn = (k, l) => e(Button, { key: k, size: "sm",
      variant: tab === k ? "primary" : "outline-secondary", className: "pdc-tab", onClick: () => setTab(k) }, l);
    const mediaBtn = (k, l) => e(Button, { key: k, size: "sm",
      variant: media === k ? "primary" : "outline-light", onClick: () => switchMedia(k) }, l);

    const progress = running
      ? e("span", { className: "pdc-status" }, e(Spinner, { animation: "border", size: "sm" }),
          ` ${status.phase || ""} ` + (status.pairs_total ? `${status.pairs_done || 0}/${status.pairs_total}`
            : status.images_total ? `${status.images_total} imgs` : `${status.scenes_done || 0}/${status.scenes_total || 0}`))
      : status && status.phase === "done"
        ? e("span", { className: "pdc-status" }, media === "image"
            ? `${iClusters.length} dup group(s)` : `${status.groups || 0} matches in ${vClusters.length} group(s)`)
        : null;

    return e("div", { className: "pdc-page" },
      e("div", { className: "pdc-header" },
        e("h3", null, "Partial Duplicate Checker"),
        e("p", { className: "pdc-sub" },
          "Cuts/parts/montages and near-duplicate images Stash's built-in checker can't see. ",
          e("a", { href: NATIVE_ROUTE }, "Built-in checker"))),
      e("div", { className: "pdc-media" }, mediaBtn("video", "Videos"), mediaBtn("image", "Images")),
      e("div", { className: "pdc-toolbar" },
        e(Button, { variant: "primary", disabled: running, onClick: startScan },
          running ? "Scanning..." : media === "image" ? "Scan images" : "Scan videos"),
        progress,
        (status && status.running && status.worker_alive === false)
          ? e(Button, { size: "sm", variant: "warning", onClick: resetScan }, "Reset stuck scan") : null,
        e(Button, { size: "sm", variant: showHelp ? "info" : "outline-info", className: "pdc-help-btn",
          onClick: () => setShowHelp((v) => !v) }, showHelp ? "Hide help" : "Help")),
      showHelp ? e("div", { className: "pdc-help" },
        e("div", { className: "pdc-help-head" }, e("strong", null, "Help"),
          e(Button, { size: "sm", variant: "outline-secondary", onClick: () => setShowHelp(false) }, "Close")),
        renderHelp()) : null,
      err ? e("div", { className: "pdc-error" }, `Error: ${err}`) : null,
      media === "video"
        ? e("div", { className: "pdc-tabs" }, tabBtn("ALL", `All (${vTotal})`),
            tabBtn("DUPLICATE", "Duplicate"), tabBtn("PART", "Part"), tabBtn("CUT", "Cut/Montage"))
        : e("div", { className: "pdc-imgbar" },
            iSummary ? e("span", { className: "pdc-status" },
              `${iSummary.dup_pairs || 0} dup pairs - ${iSummary.similar_clusters || 0} similar clusters - `
              + `${iSummary.galleries_created || 0} galleries${(iSummary.planned_galleries || 0) ? ` (${iSummary.planned_galleries} planned)` : ""}`) : null,
            e(Form.Check, { type: "switch", id: "pdc-skipgal", className: "pdc-dry",
              checked: skipGal, onChange: toggleSkipGal,
              label: "Ignore images already in a gallery" }),
            e(Form.Control, { type: "text", size: "sm", className: "pdc-exclude",
              placeholder: "Skip gallery IDs (e.g. 3,17)", value: excludeIds,
              onChange: (ev) => setExcludeIds(ev.target.value), onBlur: applyExclude }),
            e(Form.Check, { type: "switch", id: "pdc-dry", className: "pdc-dry",
              checked: !dryRun, onChange: toggleDryRun,
              label: dryRun ? "Galleries: dry-run (report only)" : "Galleries: WILL be created on next scan" })),
      selected.size > 0
        ? e("div", { className: "pdc-delbar" },
            e("span", null, `${selected.size} selected`),
            e(Button, { variant: "danger", size: "sm", disabled: busy, onClick: deleteSelected },
              busy ? "Deleting..." : `Delete ${selected.size} ${media === "image" ? "image" : "file"}(s)`),
            e(Button, { variant: "outline-secondary", size: "sm", disabled: busy, onClick: () => setSelected(new Set()) }, "Clear"))
        : null,
      clusters.length === 0
        ? e("div", { className: "pdc-empty" }, running ? "Scanning..."
            : `No ${media} duplicates yet. Run a scan.`)
        : e("div", { className: "pdc-clusters" },
            media === "image"
              ? clusters.map((c) => e(ImageCard, { key: c.parent.image_id, cluster: c, selected, onToggle: toggle, onAll: selAll }))
              : clusters.map((c) => e(VideoCard, { key: c.parent.scene_id, cluster: c, selected, onToggle: toggle, onAll: selAll }))));
  };

  // ---- nav entries ------------------------------------------------------- //
  const NavButton = () =>
    e(Button, { className: "nav-utility minimal", title: "Partial Duplicate Checker",
      variant: "secondary", onClick: () => navigateTo(ROUTE) }, e(Icon, { icon: FA.faClone }));

  try { api.register.route(ROUTE, PartialDupPage); }
  catch (ex) { console.error(`${LOG} register.route failed`, ex); }
  try {
    api.patch.before("MainNavBar.UtilityItems", function (props) {
      return [{ children: e(React.Fragment, null, props.children, e(NavButton, null)) }];
    });
  } catch (ex) { console.error(`${LOG} navbar patch failed`, ex); }
  try {
    api.patch.before("MainNavBar.MenuItems", function (props) {
      const link = e("div", { key: "pdc-menu", className: "nav-link pdc-menu-link", role: "button",
        onClick: () => navigateTo(ROUTE), title: "Partial Duplicate Checker" },
        e(Icon, { icon: FA.faClone }), e("span", { className: "pdc-menu-label" }, "Partial Dup"));
      return [{ children: e(React.Fragment, null, props.children, link) }];
    });
  } catch (ex) { console.error(`${LOG} menu patch failed`, ex); }

  console.log(`${LOG} plugin loaded (v0.2.0)`);
})();

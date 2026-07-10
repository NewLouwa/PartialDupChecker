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
        "Each box is one item to KEEP (by default the longest video / largest image) " +
          "with the duplicates below.",
        "Videos: pick a keep mode - Longest, Best quality (resolution then bitrate), " +
          "Newest or Oldest (scene's created date) protect one keeper per group " +
          "automatically. Manual protects nothing: every file, the longest included, " +
          "gets a checkbox.",
        "In an auto mode, the green Keep button on any row overrides the rule for " +
          "that group; Select all duplicates ticks every non-kept file of every group.",
        "The blue Meta button on a row copies that file's metadata (title, date, " +
          "studio, performers, tags, URLs, rating) onto the KEEP file and renames the " +
          "KEEP file after it - handy when the duplicate is better tagged than the " +
          "copy you keep.",
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
    { t: "Images", c: [
      ["p", "Near-duplicate images are grouped keep-one. Like videos, pick a keep " +
        "mode: Largest (default), Newest, Oldest (created date) or Manual (free " +
        "selection, every tile ticks). The Match filter narrows groups instantly, no " +
        "re-scan: Exact = identical phash only (a red 'exact' badge marks those " +
        "tiles), Strict = near-identical (distance <= 2, e.g. the same image " +
        "re-saved or resized), Normal = up to the configured duplicate threshold. " +
        "Tightening the threshold in Settings > Plugins also applies instantly; " +
        "loosening it beyond what the last scan stored needs a re-scan."],
      ["p", "Galleries: the 'Group similar images into galleries' switch controls " +
        "whether the next scan actually creates Stash galleries from visually-similar " +
        "(non-identical) images, or only reports what it would create (OFF, the " +
        "default). Similar-image grouping is separate from duplicate detection."],
    ]},
    { t: "Deleting", c: [
      ["p", "In the auto keep modes the KEEP item is never selectable, so you can't " +
        "delete the copy you're keeping (use the Keep button to change which copy that " +
        "is). In MANUAL mode nothing is protected - whatever you tick gets deleted. " +
        "Delete removes the selected items AND their files from disk - it cannot " +
        "be undone."],
    ]},
    { t: "Settings - where", c: [
      ["p", "Two places, split by purpose. The Settings button here (toolbar) holds the " +
        "video-scan tunables; changes apply to the NEXT scan and Reset defaults restores " +
        "everything. Stash's Settings > Plugins page holds the FFmpeg paths and the " +
        "image/gallery thresholds - a value set there wins over the panel - plus the " +
        "server-wide 'Top bar access' choice (both/menu/icon); the Navbar option in the " +
        "panel here can override it per browser. Gallery dry-run/skip toggles act " +
        "immediately from the Images toolbar."],
    ]},
    { t: "Settings - video scan", c: [
      ["dl", [
        ["Scan mode", "Hybrid uses Stash's existing sprite thumbnails to shortlist " +
          "candidate pairs, then ffmpeg-decodes just those for precise ranges - best " +
          "speed/accuracy. Fast is sprites only (~30s granularity): quick, finds whole " +
          "duplicates, misses short cuts. Deep decodes every scene: most accurate, slowest."],
        ["Deep sampling interval", "Seconds between sampled frames in deep/hybrid " +
          "confirmation. Lower = finds shorter clips and tighter ranges, but scans slower. " +
          "Default 2s; a 6s clip needs ~3 samples to register."],
        ["Min match length", "Matches whose longest shared run is shorter than this are " +
          "rejected (unless the clip is near-fully covered). Raise it if you get " +
          "coincidental matches between similar-looking scenes; lower it to catch very " +
          "short clips. Default 6s."],
        ["Segment similarity (hamming)", "How different two sampled frames may be and " +
          "still count as the same (0-16 bits). Lower = stricter: fewer false matches, " +
          "but re-encodes/watermarks may escape. Default 7."],
      ]],
    ]},
    { t: "Settings - match thresholds", c: [
      ["dl", [
        ["Duplicate: min coverage", "Both videos must match over at least this fraction " +
          "of their length (both ways) to be called DUPLICATE. Default 0.95."],
        ["Part: min contiguous coverage", "The shorter video must be one continuous " +
          "chunk of the longer covering at least this fraction of it. Default 0.90."],
        ["Cut/Montage: min total coverage", "Total (possibly reordered) overlap of the " +
          "shorter video to be flagged CUT. Lowering finds looser montages but risks " +
          "false positives. Default 0.60."],
      ]],
    ]},
    { t: "Settings - performance", c: [
      ["dl", [
        ["Min shared segments / top-K / max pairs", "Bound how many candidate pairs the " +
          "matcher considers on big libraries. Raise to be more exhaustive, lower to " +
          "speed up huge collections."],
        ["Hybrid deep budgets", "Caps on how many scenes/pairs get the expensive ffmpeg " +
          "confirmation, plus a wall-clock budget so a scan always finishes. Matches " +
          "beyond the budget simply stay at sprite precision."],
      ]],
    ]},
    { t: "Settings - Stash plugin page (FFmpeg + Images)", c: [
      ["dl", [
        ["Top bar access", "'both' shows the menu entry AND the right-side shortcut " +
          "icon, 'menu' only the menu entry, 'icon' only the shortcut. Server-wide " +
          "default for every browser; reload after changing."],
        ["ffmpeg / ffprobe path", "Leave empty to use PATH (or PDC_FFMPEG/PDC_FFPROBE " +
          "env). Set a full path if Stash's container/host has them elsewhere."],
        ["Per-video decode timeout", "Kills a decode stuck on a corrupt file. Default 600s."],
        ["Images: duplicate threshold", "Phash distance <= this = duplicate (keep one). " +
          "Lower = stricter. Default 4."],
        ["Images: similar threshold", "Between duplicate and this = visually similar - " +
          "grouped into gallery clusters instead. Default 10."],
        ["Images: min cluster size", "Similar groups smaller than this are ignored. Default 3."],
        ["Galleries: prefix / max per scan", "Title prefix for auto-created galleries, " +
          "and a per-scan creation cap. Default 'Similar images' / 200."],
      ]],
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
  // Scene info for the keep modes: created_at (date added to Stash; file
  // mod_time only as fallback) for Newest/Oldest, and resolution/bitrate for
  // Best quality. Fetched live from Stash so no plugin re-scan is needed.
  const SCENE_DATES = gql`
    query PartialDup_SceneInfo($ids: [Int!]) {
      findScenes(scene_ids: $ids) {
        scenes { id created_at files { mod_time width height bit_rate size } }
      }
    }
  `;

  const KEEP_MODES = [
    { key: "LONGEST", label: "Longest" },
    { key: "BEST", label: "Best quality" },
    { key: "NEWEST", label: "Newest" },
    { key: "OLDEST", label: "Oldest" },
    { key: "MANUAL", label: "Manual" },
  ];
  // Quality ranking: resolution first, bitrate as tiebreak, then file size.
  const qScore = (q) => q ? (q.w || 0) * (q.h || 0) * 1e7 + (q.br || 0) + (q.size || 0) / 1e6 : -1;
  const qLabel = (q) => q && q.w && q.h ? `${q.w}x${q.h}` : "";

  const IKEEP_MODES = [
    { key: "LARGEST", label: "Largest" },
    { key: "NEWEST", label: "Newest" },
    { key: "OLDEST", label: "Oldest" },
    { key: "MANUAL", label: "Manual" },
  ];
  // View-time match filter over the stored pairs (phash hamming distance).
  const IMATCH_MODES = [
    { key: "normal", label: "Normal", md: null },   // current image_dup_hamming
    { key: "strict", label: "Strict", md: 2 },
    { key: "exact", label: "Exact", md: 0 },
  ];

  // Backend tunables exposed in the Settings panel. Keys must exist in the
  // plugin's DEFAULT_CONFIG (set_config rejects unknown keys).
  const CFG_FIELDS = [
    { g: "Video scan", k: "mode", label: "Scan mode", type: "select", opts: [
        ["hybrid", "Hybrid - sprites shortlist, ffmpeg confirms (recommended)"],
        ["fast", "Fast - sprite thumbnails only (~30s granularity)"],
        ["deep", "Deep - ffmpeg-decode every scene (slow, most accurate)"]] },
    { g: "Video scan", k: "deep_interval_s", label: "Deep sampling interval (s)", type: "number", min: 0.5, max: 30, step: 0.5,
      help: "ffmpeg sampling cadence; lower = finer matches, slower scan" },
    { g: "Video scan", k: "min_match_seconds", label: "Min match length (s)", type: "number", min: 0, max: 300, step: 1,
      help: "reject matches whose longest shared run is shorter than this" },
    { g: "Video scan", k: "segment_hamming", label: "Segment similarity (hamming 0-16)", type: "int", min: 0, max: 16,
      help: "lower = stricter frame matching, fewer coincidences" },
    { g: "Match thresholds (0-1)", k: "dup_min_coverage", label: "Duplicate: min coverage", type: "number", min: 0, max: 1, step: 0.01 },
    { g: "Match thresholds (0-1)", k: "part_min_coverage", label: "Part: min contiguous coverage", type: "number", min: 0, max: 1, step: 0.01 },
    { g: "Match thresholds (0-1)", k: "cut_min_coverage", label: "Cut/Montage: min total coverage", type: "number", min: 0, max: 1, step: 0.01 },
    { g: "Performance limits", k: "min_candidate_segs", label: "Min shared segments to shortlist", type: "int", min: 1, max: 100 },
    { g: "Performance limits", k: "top_k_candidates", label: "Candidates per scene (top-K)", type: "int", min: 1, max: 1000 },
    { g: "Performance limits", k: "max_candidate_pairs", label: "Max candidate pairs", type: "int", min: 100, max: 10000000 },
    { g: "Performance limits", k: "max_deep_scenes", label: "Hybrid: max deep scenes", type: "int", min: 1, max: 100000 },
    { g: "Performance limits", k: "max_deep_pairs", label: "Hybrid: max deep pairs", type: "int", min: 1, max: 1000000 },
    { g: "Performance limits", k: "max_deep_seconds", label: "Hybrid: deep time budget (s)", type: "int", min: 10, max: 86400 },
  ];

  // Navbar display preference. Resolution order: per-browser localStorage
  // override > server-wide `nav_display` plugin setting (Settings > Plugins)
  // > "both". Read on every navbar render so a change applies on the next
  // navigation/reload.
  const NAV_PREF_KEY = "pdc_nav_display";
  const NAV_PREFS = [
    ["both", "Menu entry + right-side icon"],
    ["menu", "Menu entry only (icon + name)"],
    ["icon", "Right-side icon only"],
  ];
  const isNavPref = (v) => NAV_PREFS.some((p) => p[0] === v);
  let navPrefServer = null;
  try {
    window.fetch("/graphql", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ configuration { plugins } }" }),
    }).then((r) => r.json()).then((j) => {
      const p = j && j.data && j.data.configuration && j.data.configuration.plugins;
      const v = p && p[PLUGIN_ID] && p[PLUGIN_ID].nav_display;
      if (typeof v === "string" && isNavPref(v.trim().toLowerCase()))
        navPrefServer = v.trim().toLowerCase();
    }).catch(() => { /* not critical */ });
  } catch (ex) { /* not critical */ }
  const getNavPrefLocal = () => {
    try { return window.localStorage.getItem(NAV_PREF_KEY) || ""; } catch (ex) { return ""; }
  };
  const getNavPref = () => {
    const local = getNavPrefLocal();
    if (isNavPref(local)) return local;
    return navPrefServer || "both";
  };
  const setNavPrefStored = (v) => {
    try {
      if (v) window.localStorage.setItem(NAV_PREF_KEY, v);
      else window.localStorage.removeItem(NAV_PREF_KEY);
    } catch (ex) { /* private mode */ }
  };

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
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString() : "";

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

  // ---- video cluster card ------------------------------------------------- //
  // Auto modes (Longest/Newest/Oldest): the keeper sits in the header, cannot
  // be selected, and each row has a Keep override button. Manual mode: NO
  // protected keeper - every file (the longest included) is a selectable row.
  const VideoCard = ({ cluster, keeperId, keepLabel, dates, quality, selected, onToggle, onAll, onSetKeeper, onTransfer, busy, manual }) => {
    const p = cluster.parent || {};
    const ckey = p.scene_id;
    const items = [{ scene_id: p.scene_id, meta: p.meta, isParent: true }]
      .concat(cluster.members.map((m) => Object.assign({}, m, { isParent: false })));
    const keeper = manual ? null : (items.find((it) => it.scene_id === keeperId) || items[0]);
    const rows = manual ? items : items.filter((it) => it.scene_id !== keeper.scene_id);
    const km = keeper ? (keeper.meta || {}) : {};
    const allSel = rows.length > 0 && rows.every((it) => selected.has(it.scene_id));
    const selectAll = e(Form.Check, { type: "checkbox", checked: allSel, label: "select all",
      onChange: () => onAll(cluster, !allSel, keeper ? keeper.scene_id : null) });
    return e("div", { className: "pdc-cluster" },
      manual
        ? e("div", { className: "pdc-parent pdc-parent-manual" },
            e("div", { className: "pdc-parent-meta" },
              e("span", { className: "pdc-keep pdc-keep-free" }, "MANUAL - free selection"),
              e("span", { className: "pdc-dur" },
                `${items.length} files - tick anything, the longest included`)),
            e("div", { className: "pdc-cluster-actions" },
              e("span", { className: "pdc-count" }, `${items.length} file${items.length === 1 ? "" : "s"}`),
              selectAll))
        : e("div", { className: "pdc-parent" },
            e("a", { href: `/scenes/${keeper.scene_id}`, target: "_blank", rel: "noreferrer" },
              e("img", { className: "pdc-thumb", loading: "lazy", src: `/scene/${keeper.scene_id}/screenshot` })),
            e("div", { className: "pdc-parent-meta" },
              e("span", { className: "pdc-keep" }, keepLabel),
              sLink(keeper.scene_id, km),
              e("span", { className: "pdc-dur" },
                (km.duration ? fmtTime(km.duration) : "")
                + (dates[keeper.scene_id] ? ` - ${fmtDate(dates[keeper.scene_id])}` : "")
                + (qLabel(quality[keeper.scene_id]) ? ` - ${qLabel(quality[keeper.scene_id])}` : ""))),
            e("div", { className: "pdc-cluster-actions" },
              e("span", { className: "pdc-count" }, `${rows.length} match${rows.length === 1 ? "" : "es"}`),
              selectAll)),
      e("div", { className: "pdc-members" },
        rows.map((m) => {
          const lv = m.isParent
            ? { label: "Longest", variant: "success" }
            : (LEVELS[m.level] || { label: m.level || "?", variant: "secondary" });
          const rg = m.runs && m.runs[0];
          const r = rg ? ` - ${fmtTime(rg.b_start)}-${fmtTime(rg.b_end)}` : "";
          return e("label", { key: m.scene_id, className: "pdc-member" + (selected.has(m.scene_id) ? " pdc-sel" : "") },
            e(Form.Check, { type: "checkbox", checked: selected.has(m.scene_id), onChange: () => onToggle(m.scene_id), className: "pdc-check" }),
            sThumb(m.scene_id, m.meta),
            e("div", { className: "pdc-member-meta" },
              e("div", { className: "pdc-member-top" },
                e(Badge, { variant: lv.variant, bg: lv.variant }, lv.label),
                e("span", { className: "pdc-conf" }, m.confidence != null ? `${Math.round(m.confidence * 100)}%` : ""),
                e("span", { className: "pdc-dur" },
                  (m.meta && m.meta.duration ? fmtTime(m.meta.duration) : "")
                  + (dates[m.scene_id] ? ` - ${fmtDate(dates[m.scene_id])}` : "")
                  + (qLabel(quality[m.scene_id]) ? ` - ${qLabel(quality[m.scene_id])}` : ""))),
              sLink(m.scene_id, m.meta),
              e("span", { className: "pdc-cov" }, m.coverage_b != null ? `${Math.round(m.coverage_b * 100)}% matched${r}` : "")),
            manual ? e("span", null) : e("div", { className: "pdc-row-actions" },
              e(Button, { size: "sm", variant: "outline-success", className: "pdc-keepbtn pdc-member-keep",
                title: "keep this one instead",
                onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); onSetKeeper(ckey, m.scene_id); } }, "Keep"),
              e(Button, { size: "sm", variant: "outline-info", className: "pdc-keepbtn pdc-member-keep",
                disabled: busy,
                title: "copy this file's metadata (title, date, studio, performers, tags, URLs, rating) " +
                  "to the KEEP file and rename the KEEP file after this one",
                onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); onTransfer(m.scene_id, keeper.scene_id); } }, "Meta")));
        })));
  };

  // ---- image cluster card (grid) ------------------------------------------ //
  // Auto keep modes: the keeper tile is highlighted and not selectable, other
  // tiles get a checkbox + Keep override. Manual: no keeper - every tile
  // (largest included) gets a checkbox.
  const ImageCard = ({ cluster, keeperId, selected, onToggle, onSetKeeper, onDeleteCluster, busy, manual }) => {
    const px = (m) => m && m.w && m.h ? `${m.w}x${m.h}` : "";
    const ckey = cluster.parent.image_id;
    const items = [{ id: cluster.parent.image_id, meta: cluster.parent.meta, d: cluster.parent.d }]
      .concat(cluster.members.map((m) => ({ id: m.image_id, meta: m.meta, d: m.d })));
    const keeper = manual ? null : (keeperId || cluster.parent.image_id);
    const dupCount = items.length - 1;
    return e("div", { className: "pdc-cluster" },
      e("div", { className: "pdc-img-grid" },
        items.map((it) => {
          const isKeep = !manual && it.id === keeper;
          return e("div", { key: it.id,
            className: "pdc-img-item" + (isKeep ? " pdc-keep-item" : (selected.has(it.id) ? " pdc-sel" : "")) },
            e("a", { href: `/images/${it.id}`, target: "_blank", rel: "noreferrer" },
              e("img", { className: "pdc-img-tile", loading: "lazy", src: `/image/${it.id}/thumbnail`,
                alt: (it.meta && it.meta.title) || `Image ${it.id}` })),
            e("div", { className: "pdc-img-foot" },
              isKeep
                ? e(Badge, { variant: "success", bg: "success" }, "KEEP")
                : e(React.Fragment, null,
                    e(Form.Check, { type: "checkbox", checked: selected.has(it.id),
                      onChange: () => onToggle(it.id), className: "pdc-check", title: "select for delete" }),
                    manual ? null : e(Button, { size: "sm", variant: "outline-success", className: "pdc-keepbtn",
                      onClick: () => onSetKeeper(ckey, it.id), title: "keep this one instead" }, "Keep")),
              it.d === 0 ? e(Badge, { variant: "danger", bg: "danger", title: "identical phash" }, "exact") : null,
              e("span", { className: "pdc-px" }, px(it.meta))));
        })),
      e("div", { className: "pdc-cluster-foot" },
        manual
          ? e("span", { className: "pdc-count" }, `${items.length} files - free selection`)
          : e(React.Fragment, null,
              e("span", { className: "pdc-count" }, `${dupCount} duplicate${dupCount === 1 ? "" : "s"} - keeping #${keeper}`),
              e(Button, { size: "sm", variant: "danger", disabled: busy, onClick: () => onDeleteCluster(ckey) },
                `Delete ${dupCount} dup${dupCount === 1 ? "" : "s"}`))));
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
    const [keepers, setKeepers] = React.useState(() => ({}));  // image cluster -> chosen keeper id
    const [vKeepers, setVKeepers] = React.useState(() => ({})); // video cluster -> chosen keeper scene id
    const [keepMode, setKeepMode] = React.useState("LONGEST"); // LONGEST | BEST | NEWEST | OLDEST | MANUAL
    const [iKeepMode, setIKeepMode] = React.useState("LARGEST"); // LARGEST | NEWEST | OLDEST | MANUAL
    const [iMatch, setIMatch] = React.useState("normal");       // normal | strict | exact
    const [dates, setDates] = React.useState(() => ({}));      // scene id -> created date (epoch ms)
    const [quality, setQuality] = React.useState(() => ({}));  // scene id -> {w,h,br,size}
    const [err, setErr] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [showHelp, setShowHelp] = React.useState(false);
    const [showSettings, setShowSettings] = React.useState(false);
    const [cfg, setCfg] = React.useState(null);        // full backend config
    const [draft, setDraft] = React.useState(() => ({})); // unsaved field edits
    const [cfgMsg, setCfgMsg] = React.useState(null);  // transient "Saved" note
    const [navPref, setNavPref] = React.useState(getNavPrefLocal);
    const aliveRef = React.useRef(true);
    const mediaRef = React.useRef(media);
    mediaRef.current = media;

    const run = React.useCallback(async (action, extra) => {
      const resp = await client.mutate({ mutation: RUN_OPERATION,
        variables: { id: PLUGIN_ID, args: Object.assign({ action }, extra || {}) } });
      return resp && resp.data && resp.data.runPluginOperation;
    }, [client]);

    const loadDates = React.useCallback(async (cs, attempt) => {
      const ids = Array.from(new Set(cs.flatMap((c) =>
        [c.parent.scene_id].concat(c.members.map((m) => m.scene_id))))).map(Number);
      if (!ids.length) return;
      try {
        const r = await client.query({ query: SCENE_DATES, variables: { ids }, fetchPolicy: "no-cache" });
        const map = {}, qmap = {};
        (((r.data || {}).findScenes || {}).scenes || []).forEach((s) => {
          const f = (s.files && s.files[0]) || {};
          const d = Date.parse(s.created_at || f.mod_time || "");
          if (!isNaN(d)) map[Number(s.id)] = d;
          if (f.width || f.height || f.bit_rate)
            qmap[Number(s.id)] = { w: f.width || 0, h: f.height || 0,
              br: f.bit_rate || 0, size: Number(f.size) || 0 };
        });
        if (aliveRef.current) { setDates(map); setQuality(qmap); }
      } catch (ex) {
        // Stash's SQLite can be briefly locked during a scan - retry a couple
        // of times instead of silently losing dates/quality for this load.
        const n = attempt || 0;
        if (n < 2 && aliveRef.current) {
          setTimeout(() => { if (aliveRef.current) loadDatesRef.current(cs, n + 1); }, 4000);
        } else {
          console.warn(`${LOG} scene info unavailable`, ex);
        }
      }
    }, [client]);
    const loadDatesRef = React.useRef(loadDates);
    loadDatesRef.current = loadDates;
    const loadVideo = React.useCallback(async () => {
      try {
        const r = await run("clusters");
        if (!aliveRef.current) return;
        const cs = (r && r.clusters) || [];
        setVClusters(cs);
        loadDates(cs);
      }
      catch (ex) { if (aliveRef.current) setErr(ex.message || String(ex)); }
    }, [run, loadDates]);
    const iMatchRef = React.useRef(iMatch);
    iMatchRef.current = iMatch;
    const loadImage = React.useCallback(async (matchKey) => {
      try {
        const mk = matchKey || iMatchRef.current;
        const mode = IMATCH_MODES.find((m) => m.key === mk);
        const args = mode && mode.md != null ? { max_distance: mode.md } : {};
        const r = await run("image_clusters", args);
        if (!aliveRef.current) return;
        setIClusters((r && r.clusters) || []);
        setISummary((r && r.summary) || null);
        if (r && r.summary && typeof r.summary.dry_run === "boolean") setDryRun(r.summary.dry_run);
      } catch (ex) { if (aliveRef.current) setErr(ex.message || String(ex)); }
    }, [run]);
    const switchIMatch = (k) => { setIMatch(k); setSelected(new Set()); setKeepers({}); loadImage(k); };

    const applyConfig = React.useCallback((c) => {
      if (!c) return;
      setCfg(c);
      if (typeof c.gallery_dry_run === "boolean") setDryRun(c.gallery_dry_run);
      if (typeof c.gallery_skip_in_gallery === "boolean") setSkipGal(c.gallery_skip_in_gallery);
      setExcludeIds((c.gallery_exclude_ids || []).join(","));
    }, []);
    const loadConfig = React.useCallback(async () => {
      try {
        const c = await run("get_config");
        if (aliveRef.current) applyConfig(c);
      } catch (ex) { /* non-fatal */ }
    }, [run, applyConfig]);

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

    const saveSettings = async () => {
      const updates = {};
      for (const f of CFG_FIELDS) {
        if (!(f.k in draft)) continue;
        let v = draft[f.k];
        if (f.type === "number") { v = parseFloat(v); if (isNaN(v)) continue; }
        else if (f.type === "int") { v = parseInt(v, 10); if (isNaN(v)) continue; }
        if (f.min != null && v < f.min) v = f.min;
        if (f.max != null && v > f.max) v = f.max;
        updates[f.k] = v;
      }
      if (!Object.keys(updates).length) { setCfgMsg("Nothing to save"); return; }
      setErr(null);
      try {
        const c = await run("set_config", { config: updates });
        applyConfig(c); setDraft({});
        setCfgMsg("Saved - applies to the next scan");
      } catch (ex) { setErr(ex.message || String(ex)); }
    };
    const resetSettings = async () => {
      if (!window.confirm("Reset ALL plugin settings to their defaults?")) return;
      setErr(null);
      try {
        const c = await run("reset_config");
        applyConfig(c); setDraft({});
        setCfgMsg("Defaults restored");
      } catch (ex) { setErr(ex.message || String(ex)); }
    };

    const toggle = (id) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
    // Select/deselect every item of the cluster except the keeper (parent included).
    const selAll = (cluster, on, keeperId) => setSelected((p) => {
      const n = new Set(p);
      [cluster.parent.scene_id].concat(cluster.members.map((m) => m.scene_id))
        .filter((id) => id !== keeperId)
        .forEach((id) => on ? n.add(id) : n.delete(id));
      return n;
    });
    const setVKeeper = (ckey, id) => {
      setVKeepers((k) => Object.assign({}, k, { [ckey]: id }));
      setSelected((p) => { const n = new Set(p); n.delete(id); return n; });
    };
    // Which scene a video cluster keeps. MANUAL protects nothing (free
    // selection, returns null); otherwise a per-group Keep pick wins, then the
    // mode rule (newest/oldest by created date), then the parent (longest).
    const keeperOf = (c) => {
      if (keepMode === "MANUAL") return null;
      const o = vKeepers[c.parent.scene_id];
      if (o != null) return o;
      const all = [c.parent.scene_id].concat(c.members.map((m) => m.scene_id));
      if (keepMode === "NEWEST" || keepMode === "OLDEST") {
        const dated = all.filter((id) => dates[id] != null);
        if (dated.length)
          return dated.reduce((a, b) =>
            (keepMode === "NEWEST" ? dates[b] > dates[a] : dates[b] < dates[a]) ? b : a);
      }
      if (keepMode === "BEST") {
        const rated = all.filter((id) => quality[id] != null);
        if (rated.length)
          return rated.reduce((a, b) => qScore(quality[b]) > qScore(quality[a]) ? b : a);
      }
      return c.parent.scene_id;
    };
    const keepLabelFor = (c) =>
      vKeepers[c.parent.scene_id] != null ? "KEEP - your pick"
        : keepMode === "NEWEST" ? "KEEP - newest"
        : keepMode === "OLDEST" ? "KEEP - oldest"
        : keepMode === "BEST" ? "KEEP - best quality"
        : "KEEP - longest";
    // Changing mode re-derives every keeper, so drop manual picks and the
    // selection (an id selected for delete may have just become a keeper).
    const switchKeepMode = (m) => { setKeepMode(m); setVKeepers({}); setSelected(new Set()); };
    // Global select-all: ticks every non-keeper of every group at once,
    // following the active keep mode. Not offered in MANUAL (no keeper rule).
    const dupIdsOf = (c) => {
      const k = keeperOf(c);
      return [c.parent.scene_id].concat(c.members.map((m) => m.scene_id)).filter((id) => id !== k);
    };
    const selectAllDups = (cs) => setSelected((p) => {
      const n = new Set(p);
      cs.forEach((c) => dupIdsOf(c).forEach((id) => n.add(id)));
      return n;
    });
    const transferMeta = async (fromId, toId) => {
      if (!window.confirm(
        "Copy this file's metadata (title, date, studio, performers, tags, URLs, rating) " +
        "to the KEEP file, and rename the KEEP file after it?\n" +
        "Performers/tags/URLs are merged; title/date/studio/rating are overwritten.")) return;
      setBusy(true); setErr(null);
      try {
        const r = await run("transfer_metadata", { from_scene_id: fromId, to_scene_id: toId, rename: true });
        if (r && r.warning) setErr(r.warning);
        await loadVideo();  // refresh titles/names from the synced index
      } catch (ex) { setErr(ex.message || String(ex)); }
      finally { setBusy(false); }
    };

    const deleteSelected = async () => {
      let ids = Array.from(selected);
      // Belt and braces: never delete a current keeper, whatever the selection says.
      const ks = new Set(media === "video" ? vClusters.map(keeperOf) : iClusters.map(keeperOfImg));
      ids = ids.filter((id) => !ks.has(id));
      if (!ids.length) return;
      const what = media === "image" ? "image" : "scene";
      const keepNote = (media === "video" ? keepMode : iKeepMode) === "MANUAL"
        ? "MANUAL mode: exactly what you ticked will be deleted."
        : "The KEEP item in each box is preserved.";
      if (!window.confirm(`Delete ${ids.length} ${what}(s) AND their files from disk?\n${keepNote} This cannot be undone.`)) return;
      setBusy(true); setErr(null);
      try {
        const r = media === "image"
          ? await run("delete_images", { image_ids: ids, delete_file: true })
          : await run("delete_scenes", { scene_ids: ids, delete_file: true });
        const gone = new Set((r && r.deleted) || []);
        const key = media === "image" ? "image_id" : "scene_id";
        const setC = media === "image" ? setIClusters : setVClusters;
        const keepersMap = media === "image" ? keepers : vKeepers;
        // Drop deleted items; if the parent itself was deleted, promote the chosen
        // keeper (or the first survivor) so the cluster stays coherent.
        setC((cs) => cs.map((c) => {
          const members = c.members.filter((m) => !gone.has(m[key]));
          if (!gone.has(c.parent[key]))
            return members.length ? Object.assign({}, c, { members }) : null;
          if (!members.length) return null;
          const kid = keepersMap[c.parent[key]];
          let idx = members.findIndex((m) => m[key] === kid);
          if (idx < 0) idx = 0;
          const np = members[idx];
          return Object.assign({}, c, {
            parent: { [key]: np[key], meta: np.meta },
            members: members.filter((_, i) => i !== idx),
          });
        }).filter(Boolean));
        setSelected(new Set());
        if (r && r.failed && r.failed.length) setErr(`${r.failed.length} deletion(s) failed (see plugin log).`);
      } catch (ex) { setErr(ex.message || String(ex)); }
      finally { setBusy(false); }
    };

    const setKeeper = (ckey, id) => {
      setKeepers((k) => Object.assign({}, k, { [ckey]: id }));
      setSelected((p) => { const n = new Set(p); n.delete(id); return n; });
    };
    // Which image a cluster keeps: MANUAL protects nothing; else a per-group
    // Keep pick wins, then the mode rule, then the parent (largest).
    const keeperOfImg = (c) => {
      if (iKeepMode === "MANUAL") return null;
      const o = keepers[c.parent.image_id];
      if (o != null) return o;
      if (iKeepMode === "NEWEST" || iKeepMode === "OLDEST") {
        const dated = [c.parent].concat(c.members)
          .map((x) => ({ id: x.image_id, t: Date.parse((x.meta || {}).date || "") }))
          .filter((x) => !isNaN(x.t));
        if (dated.length)
          return dated.reduce((a, b) =>
            (iKeepMode === "NEWEST" ? b.t > a.t : b.t < a.t) ? b : a).id;
      }
      return c.parent.image_id; // LARGEST: backend already ranks the parent
    };
    const switchIKeepMode = (m) => { setIKeepMode(m); setKeepers({}); setSelected(new Set()); };
    const selectAllImgDups = () => setSelected((p) => {
      const n = new Set(p);
      iClusters.forEach((c) => imgDups(c).forEach((id) => n.add(id)));
      return n;
    });
    const afterImgDelete = async (r) => {
      setSelected(new Set()); setKeepers({});
      await loadImage();
      if (r && r.failed && r.failed.length) setErr(`${r.failed.length} deletion(s) failed (see plugin log).`);
    };
    const imgDups = (c) => {
      const k = keeperOfImg(c);
      return [c.parent.image_id].concat(c.members.map((m) => m.image_id)).filter((id) => id !== k);
    };
    const deleteImgCluster = async (ckey) => {
      if (iKeepMode === "MANUAL") return; // no keeper rule to apply
      const c = iClusters.find((x) => x.parent.image_id === ckey);
      if (!c) return;
      const ids = imgDups(c);
      if (!ids.length) return;
      if (!window.confirm(`Delete ${ids.length} duplicate image file(s)? Keeps the one marked KEEP. Cannot be undone.`)) return;
      setBusy(true); setErr(null);
      try { const r = await run("delete_images", { image_ids: ids, delete_file: true }); await afterImgDelete(r); }
      catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
    };
    const deleteAllImgDups = async () => {
      if (iKeepMode === "MANUAL") return; // use the selection + Delete bar instead
      const ids = iClusters.flatMap(imgDups);
      if (!ids.length) return;
      if (!window.confirm(`DELETE ${ids.length} duplicate images and their files from disk?\n` +
        `This keeps ONE image per group (${iClusters.length} groups). This CANNOT be undone.`)) return;
      setBusy(true); setErr(null);
      try { const r = await run("delete_images", { image_ids: ids, delete_file: true }); await afterImgDelete(r); }
      catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
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
        e(Button, { size: "sm", variant: showSettings ? "secondary" : "outline-secondary", className: "pdc-help-btn",
          onClick: () => setShowSettings((v) => !v) }, e(Icon, { icon: FA.faCog || FA.faGear }), " Settings"),
        e(Button, { size: "sm", variant: showHelp ? "info" : "outline-info",
          onClick: () => setShowHelp((v) => !v) }, showHelp ? "Hide help" : "Help")),
      showHelp ? e("div", { className: "pdc-help" },
        e("div", { className: "pdc-help-head" }, e("strong", null, "Help"),
          e(Button, { size: "sm", variant: "outline-secondary", onClick: () => setShowHelp(false) }, "Close")),
        renderHelp()) : null,
      showSettings ? (() => {
        const groups = [];
        CFG_FIELDS.forEach((f) => { if (!groups.includes(f.g)) groups.push(f.g); });
        const fieldVal = (f) => f.k in draft ? draft[f.k] : (cfg && cfg[f.k] != null ? String(cfg[f.k]) : "");
        const setField = (k, v) => { setDraft((d) => Object.assign({}, d, { [k]: v })); setCfgMsg(null); };
        return e("div", { className: "pdc-help pdc-settings" },
          e("div", { className: "pdc-help-head" },
            e("strong", null, "Plugin settings"),
            e("div", { className: "pdc-set-actions" },
              cfgMsg ? e("span", { className: "pdc-set-msg" }, cfgMsg) : null,
              e(Button, { size: "sm", variant: "success", disabled: !Object.keys(draft).length,
                onClick: saveSettings }, "Save"),
              e(Button, { size: "sm", variant: "outline-warning", onClick: resetSettings }, "Reset defaults"),
              e(Button, { size: "sm", variant: "outline-secondary", onClick: () => setShowSettings(false) }, "Close"))),
          e("section", { className: "pdc-set-sec" },
            e("h4", null, "Navbar (this browser)"),
            e("div", { className: "pdc-set-grid" },
              e("label", { className: "pdc-set-field" },
                e("span", { className: "pdc-set-lbl" }, "Show the plugin in the top bar as"),
                e(Form.Control, { as: "select", size: "sm", value: isNavPref(navPref) ? navPref : "",
                  onChange: (ev) => { setNavPref(ev.target.value); setNavPrefStored(ev.target.value); } },
                  e("option", { value: "" },
                    `Follow Settings > Plugins${navPrefServer ? ` (currently: ${navPrefServer})` : " (not set = both)"}`),
                  NAV_PREFS.map((p) => e("option", { key: p[0], value: p[0] }, p[1]))),
                e("span", { className: "pdc-set-help" },
                  "browser override of the server-wide 'Top bar access' setting; applies on the next navigation or reload")))),
          cfg == null ? e("p", null, "Loading config...")
            : groups.map((g) => e("section", { key: g, className: "pdc-set-sec" },
                e("h4", null, g),
                e("div", { className: "pdc-set-grid" },
                  CFG_FIELDS.filter((f) => f.g === g).map((f) =>
                    e("label", { key: f.k, className: "pdc-set-field", title: f.help || "" },
                      e("span", { className: "pdc-set-lbl" }, f.label),
                      f.type === "select"
                        ? e(Form.Control, { as: "select", size: "sm", value: fieldVal(f),
                            onChange: (ev) => setField(f.k, ev.target.value) },
                            f.opts.map((o) => e("option", { key: o[0], value: o[0] }, o[1])))
                        : e(Form.Control, { type: f.type === "text" ? "text" : "number", size: "sm",
                            value: fieldVal(f), min: f.min, max: f.max,
                            step: f.step != null ? f.step : (f.type === "int" ? 1 : undefined),
                            onChange: (ev) => setField(f.k, ev.target.value) }),
                      f.help ? e("span", { className: "pdc-set-help" }, f.help) : null))))),
          e("p", { className: "pdc-set-note" },
            "Settings apply to the NEXT scan. FFmpeg paths and image/gallery thresholds are on ",
            e("a", { href: "/settings?tab=plugins" }, "Settings > Plugins"),
            "; gallery dry-run / skip toggles live in the Images toolbar."));
      })() : null,
      err ? e("div", { className: "pdc-error" }, `Error: ${err}`) : null,
      media === "video"
        ? e(React.Fragment, null,
            e("div", { className: "pdc-tabs" }, tabBtn("ALL", `All (${vTotal})`),
              tabBtn("DUPLICATE", "Duplicate"), tabBtn("PART", "Part"), tabBtn("CUT", "Cut/Montage")),
            e("div", { className: "pdc-keepbar" },
              e("span", { className: "pdc-keeplbl" }, "Keep:"),
              KEEP_MODES.map((m) => e(Button, { key: m.key, size: "sm",
                variant: keepMode === m.key ? "success" : "outline-secondary",
                className: "pdc-tab", onClick: () => switchKeepMode(m.key) }, m.label)),
              e("span", { className: "pdc-keephint" },
                keepMode === "MANUAL" ? "free selection: tick anything in every group, the longest included"
                : keepMode === "LONGEST" ? "keeps the longest video of each group"
                : keepMode === "BEST" ? "keeps the highest quality file of each group (resolution, then bitrate)"
                : `keeps the ${keepMode === "NEWEST" ? "most recently" : "earliest"} added file of each group (created date)`),
              keepMode !== "MANUAL" ? (() => {
                const n = clusters.reduce((a, c) => a + dupIdsOf(c).length, 0);
                return n > 0 ? e(Button, { size: "sm", variant: "outline-danger", className: "pdc-selall",
                  onClick: () => selectAllDups(clusters),
                  title: "tick every non-kept file of every group, following the keep mode" },
                  `Select all duplicates (${n})`) : null;
              })() : null))
        : e(React.Fragment, null,
            e("div", { className: "pdc-keepbar" },
              e("span", { className: "pdc-keeplbl" }, "Keep:"),
              IKEEP_MODES.map((m) => e(Button, { key: m.key, size: "sm",
                variant: iKeepMode === m.key ? "success" : "outline-secondary",
                className: "pdc-tab", onClick: () => switchIKeepMode(m.key) }, m.label)),
              e("span", { className: "pdc-keeplbl pdc-matchlbl" }, "Match:"),
              IMATCH_MODES.map((m) => e(Button, { key: m.key, size: "sm",
                variant: iMatch === m.key ? "primary" : "outline-secondary",
                className: "pdc-tab", onClick: () => switchIMatch(m.key),
                title: m.key === "exact" ? "identical phash only (distance 0)"
                  : m.key === "strict" ? "near-identical (distance <= 2)"
                  : "up to the configured duplicate threshold" }, m.label)),
              e("span", { className: "pdc-keephint" },
                iKeepMode === "MANUAL" ? "free selection: tick anything in every group, the largest included"
                : iKeepMode === "LARGEST" ? "keeps the biggest image of each group (resolution, then size)"
                : `keeps the ${iKeepMode === "NEWEST" ? "most recently" : "earliest"} added image of each group`),
              iKeepMode !== "MANUAL" ? (() => {
                const n = iClusters.reduce((a, c) => a + imgDups(c).length, 0);
                return n > 0 ? e(Button, { size: "sm", variant: "outline-danger", className: "pdc-selall",
                  onClick: selectAllImgDups,
                  title: "tick every non-kept image of every group, following the keep mode" },
                  `Select all duplicates (${n})`) : null;
              })() : null),
            e("div", { className: "pdc-imgbar" },
              iSummary ? e("span", { className: "pdc-status" },
                `${iSummary.dup_pairs || 0} dup pairs - ${iSummary.similar_clusters || 0} similar clusters - `
                + `${iSummary.galleries_created || 0} galleries${(iSummary.planned_galleries || 0) ? ` (${iSummary.planned_galleries} planned)` : ""}`) : null,
              e(Form.Check, { type: "switch", id: "pdc-dry", className: "pdc-dry",
                checked: !dryRun, onChange: toggleDryRun,
                label: dryRun
                  ? "Group similar images into galleries: OFF (scan only reports)"
                  : "Group similar images into galleries: ON (created on next scan)" }),
              e(Form.Check, { type: "switch", id: "pdc-skipgal", className: "pdc-dry",
                checked: skipGal, onChange: toggleSkipGal,
                label: "Ignore images already in a gallery" }),
              e(Form.Control, { type: "text", size: "sm", className: "pdc-exclude",
                placeholder: "Skip gallery IDs (e.g. 3,17)", value: excludeIds,
                onChange: (ev) => setExcludeIds(ev.target.value), onBlur: applyExclude }),
              iKeepMode !== "MANUAL" ? (() => { const n = iClusters.reduce((a, c) => a + imgDups(c).length, 0);
                return n > 0 ? e(Button, { variant: "danger", size: "sm", disabled: busy, onClick: deleteAllImgDups },
                  `Delete all duplicates (${n})`) : null; })() : null)),
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
              ? clusters.map((c) => e(ImageCard, { key: c.parent.image_id, cluster: c,
                  keeperId: keeperOfImg(c), selected, onToggle: toggle,
                  manual: iKeepMode === "MANUAL",
                  onSetKeeper: setKeeper, onDeleteCluster: deleteImgCluster, busy }))
              : clusters.map((c) => e(VideoCard, { key: c.parent.scene_id, cluster: c,
                  keeperId: keeperOf(c), keepLabel: keepLabelFor(c), dates, quality, selected,
                  manual: keepMode === "MANUAL", busy,
                  onToggle: toggle, onAll: selAll, onSetKeeper: setVKeeper, onTransfer: transferMeta }))));
  };

  // ---- nav entries ------------------------------------------------------- //
  const NavButton = () =>
    e(Button, { className: "nav-utility minimal", title: "Partial Duplicate Checker",
      variant: "secondary", onClick: () => navigateTo(ROUTE) }, e(Icon, { icon: FA.faClone }));

  try { api.register.route(ROUTE, PartialDupPage); }
  catch (ex) { console.error(`${LOG} register.route failed`, ex); }
  try {
    api.patch.before("MainNavBar.UtilityItems", function (props) {
      if (getNavPref() === "menu") return [{ children: props.children }];
      return [{ children: e(React.Fragment, null, props.children, e(NavButton, null)) }];
    });
  } catch (ex) { console.error(`${LOG} navbar patch failed`, ex); }
  try {
    api.patch.before("MainNavBar.MenuItems", function (props) {
      if (getNavPref() === "icon") return [{ children: props.children }];
      const link = e("div", { key: "pdc-menu", className: "nav-link pdc-menu-link", role: "button",
        onClick: () => navigateTo(ROUTE), title: "Partial Duplicate Checker" },
        e(Icon, { icon: FA.faClone }), e("span", { className: "pdc-menu-label" }, "Partial Dup"));
      return [{ children: e(React.Fragment, null, props.children, link) }];
    });
  } catch (ex) { console.error(`${LOG} menu patch failed`, ex); }

  console.log(`${LOG} plugin loaded (v0.11.0)`);
})();

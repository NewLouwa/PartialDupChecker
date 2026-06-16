"use strict";
// Partial Duplicate Checker — Stash UI plugin.
// Phase 1: minimal bootstrap (route + nav button placeholder) so the plugin
// loads cleanly. The tabbed results view is built in Phase 4.
(function () {
  const api = window.PluginApi;
  if (!api) {
    console.error("[partialdup] PluginApi not available");
    return;
  }
  const React = api.React;
  const PLUGIN_ID = "partial_dup_checker";
  const ROUTE = "/partial-duplicates";
  const LOG = "[partialdup]";

  // Placeholder page — replaced by the tabbed results view in Phase 4.
  const PartialDupPage = () =>
    React.createElement(
      "div",
      { className: "partialdup-page" },
      React.createElement("h3", null, "Partial Duplicate Checker"),
      React.createElement(
        "p",
        null,
        "Scanning + results UI coming in the next build phase."
      )
    );

  try {
    api.register.route(ROUTE, PartialDupPage);
  } catch (e) {
    console.error(`${LOG} register.route failed`, e);
  }

  console.log(`${LOG} plugin loaded (v0.1.0)`);
})();

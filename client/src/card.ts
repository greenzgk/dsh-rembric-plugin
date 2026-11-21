// client/src/card.ts — the Rembric settings card, static stage (ticket #16).
//
// Approved layout: prototype variant B "Status first" (ticket #18). The card
// shows the connection state, the server address field and the write-only
// token field, and saves nothing yet — the save wiring and the pure decide()
// logic land in ticket #18. Until then the state is fixed at "Not connected".
//
// Plain function component, no hooks: the slot owner renders it with
// PluginConfigViewProps and it ignores them entirely at this stage.
import * as React from "react";

const h = React.createElement;

// Variant B styles, scoped under .rembric-card so nothing leaks into the
// host settings UI. Values mirror the approved prototype.
const CSS = `
.rembric-card{--line:#242c3a;--text:#e7eaf0;--muted:#8b95a7;--accent:#3f7bf0;--accent-dim:#2b5bb5;--ok:#3fb950;--err:#f85149;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;background:#151a23;border:1px solid var(--line);border-radius:12px;overflow:hidden;color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.rembric-card *{box-sizing:border-box}
.rembric-card .rc-head{padding:18px 20px 0}
.rembric-card .rc-head h1{font-size:16px;margin:0 0 4px}
.rembric-card .rc-head p{margin:0;color:var(--muted);font-size:12.5px}
.rembric-card .rc-body{padding:16px 20px 20px;display:flex;flex-direction:column;gap:18px}
.rembric-card .rc-sec{display:flex;flex-direction:column;gap:6px}
.rembric-card .rc-sec h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0;font-weight:600}
.rembric-card .rc-label{font-size:13px;color:var(--text);margin:0}
.rembric-card input[type=text],.rembric-card input[type=password]{width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:#0f141d;color:var(--text);font:13px/1.4 var(--mono);outline:none}
.rembric-card input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(63,123,240,.18)}
.rembric-card .rc-hint{font-size:12px;color:var(--muted);margin:0}
.rembric-card .rc-hint code{font-family:var(--mono);font-size:11.5px;background:#0f141d;border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.rembric-card .rc-rule{height:1px;background:var(--line);margin:0}
.rembric-card .rc-save-row{display:flex;align-items:center;gap:12px;padding-top:2px}
.rembric-card button{font:inherit;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;padding:8px 18px;cursor:pointer}
.rembric-card button:hover{background:var(--accent-dim);border-color:var(--accent-dim)}
.rembric-card .rc-result{font-size:13px;display:flex;align-items:center;gap:6px}
.rembric-card .rc-banner{display:flex;gap:10px;align-items:flex-start;background:#0f141d;border:1px solid var(--line);border-radius:8px;padding:12px 14px;font-size:13px}
.rembric-card .rc-dot{width:8px;height:8px;border-radius:50%;background:var(--muted);margin-top:6px;flex:none}
`;

/**
 * The static variant B card. Renders the approved copy and empty result
 * space; carries no values and writes nothing (ticket #18 adds the wiring).
 */
export function RembricSettingsCard(): React.ReactElement {
  return h(
    "div",
    { className: "rembric-card" },
    h("style", null, CSS),
    h(
      "div",
      { className: "rc-head" },
      h("h1", null, "Rembric Plugin"),
      h("p", null, "Memories for the current workspace."),
    ),
    h(
      "div",
      { className: "rc-body" },
      h(
        "div",
        { className: "rc-banner" },
        h("span", { className: "rc-dot" }),
        h(
          "div",
          null,
          h("b", null, "Not connected"),
          h("p", { className: "rc-hint" }, "Set the server URL and a token below, then save."),
        ),
      ),
      h(
        "div",
        { className: "rc-sec" },
        h("h2", null, "Server"),
        h(
          "label",
          { className: "rc-label", htmlFor: "rembric-server-input" },
          "Rembric server URL",
        ),
        h("input", { id: "rembric-server-input", type: "text", spellCheck: false }),
        h("p", { className: "rc-hint" }, "Where the plugin sends and looks up memory."),
      ),
      h(
        "div",
        { className: "rc-sec" },
        h("h2", null, "Token"),
        h("label", { className: "rc-label", htmlFor: "rembric-token-input" }, "API token"),
        h("input", {
          id: "rembric-token-input",
          type: "password",
          spellCheck: false,
          autoComplete: "off",
        }),
        h(
          "p",
          { className: "rc-hint" },
          "Same token can also be set with ",
          h("code", null, "/rembric-login <token>"),
          " in the chat; both paths write the same reference.",
        ),
      ),
      h("div", { className: "rc-rule" }),
      h(
        "div",
        { className: "rc-save-row" },
        h("button", { type: "button" }, "Save"),
        // Result space for the green check / red cross — filled by ticket #18.
        h("span", { className: "rc-result" }),
      ),
    ),
  );
}

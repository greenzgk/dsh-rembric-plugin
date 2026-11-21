window.__ModuleLoader__.load({id:"dsh-rembric-plugin",factory:(require)=>{var module={exports:{}};var exports=module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
// client/src/decide.ts
/**
* Kinds that mean the token is at fault; everything else is the address.
* "save-failed" counts as the token's: the address saved fine, the token
* is what could not be persisted.
*/
const TOKEN_FAULT_KINDS = /* @__PURE__ */ new Set([
	"rejected-token",
	"no-project-access",
	"no-token",
	"save-failed"
]);
/**
* The effective token source after a success whose token arrived with the
* request: the route just persisted it, so from now on it lives in the
* store. Shared by decide() and the card's open probe so the mapping
* exists once.
*/
function effectiveSource(source) {
	return source === "request" ? "store" : source;
}
/**
* The one transition function. Returns a fresh state; never mutates input.
*/
function decide(state, outcome) {
	switch (outcome.type) {
		case "success": return {
			...state,
			tokenSource: effectiveSource(outcome.tokenSource),
			tokenDraft: "",
			connected: true,
			busy: false,
			errorTarget: null,
			result: { ok: true },
			stored: false,
			verifiedUrl: state.serverUrl.trim()
		};
		case "failure": return {
			...state,
			connected: false,
			busy: false,
			stored: false,
			errorTarget: TOKEN_FAULT_KINDS.has(outcome.kind) ? "token" : "server",
			result: {
				ok: false,
				message: outcome.message
			}
		};
		case "unavailable": return {
			...state,
			connected: false,
			busy: false,
			stored: true,
			errorTarget: null,
			result: { ok: true }
		};
	}
}
/** Banner label and tone for the current state. */
function bannerOf(state) {
	if (state.connected === true) return {
		label: "Connected",
		tone: "ok"
	};
	if (state.stored) return {
		label: "Stored",
		tone: "neutral"
	};
	return {
		label: "Not connected",
		tone: "err"
	};
}
/** Save-row result mark for the current state, or null for nothing yet. */
function resultMarkOf(state) {
	if (state.busy) return {
		text: "Validating…",
		tone: "busy"
	};
	if (!state.result) return null;
	if (state.result.ok) return state.connected ? {
		text: "✓ Token is valid",
		tone: "ok"
	} : {
		text: "✓ Saved",
		tone: "ok"
	};
	return {
		text: "✕ " + state.result.message,
		tone: "fail"
	};
}
/** Client-side URL sanity check before touching the config form. */
function validateServerUrl(url) {
	if (/^https?:\/\/\S+$/.test(url.trim())) return { ok: true };
	return {
		ok: false,
		message: "That is not a URL. Expected something like http://127.0.0.1:8790"
	};
}
// client/src/card.tsx
const VERIFY_PATH = "/plugins/rembric/verify";
/** Current effective server address as the host config form sees it. */
function formServerUrl(form) {
	const value = form?.state?.value;
	if (value && typeof value.serverUrl === "string") return value.serverUrl;
	return "";
}
/** Persist the server address through the harness config form. */
async function writeServerUrl(form, url) {
	const f = form;
	if (!f || typeof f.mutate !== "function") return false;
	const ops = [{
		op: "set",
		path: ["serverUrl"],
		value: url
	}];
	return await f.mutate(ops, f.state?.revision) === true;
}
/** Map a verify-route JSON body into the decide() outcome vocabulary. */
function outcomeFromJson(data) {
	if (data && typeof data === "object") {
		const d = data;
		if (d.ok === true) {
			const ts = d.tokenSource;
			return {
				type: "success",
				tokenSource: ts === "store" || ts === "env" || ts === "none" || ts === "request" ? ts : "none"
			};
		}
		if (d.ok === false) return {
			type: "failure",
			kind: typeof d.kind === "string" ? d.kind : "error",
			message: typeof d.message === "string" ? d.message : "verification failed"
		};
	}
	return { type: "unavailable" };
}
async function postVerify(body) {
	try {
		return outcomeFromJson(await (await fetch(VERIFY_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		})).json().catch(() => null));
	} catch {
		return { type: "unavailable" };
	}
}
function initialCardState(serverUrl) {
	return {
		serverUrl,
		tokenDraft: "",
		tokenSource: "none",
		connected: null,
		busy: false,
		errorTarget: null,
		result: null,
		stored: false,
		verifiedUrl: ""
	};
}
/**
* Reads the effective server address from the config form, probes the
* stored/ambient token on open, and saves address then token through the
* single Save button.
*/
function RembricSettingsCard(props) {
	const formUrl = formServerUrl(props.form);
	const [state, setState] = (0, react.useState)(() => initialCardState(formUrl));
	const addressDirty = (0, react.useRef)(false);
	(0, react.useEffect)(() => {
		if (addressDirty.current) return;
		setState((s) => s.serverUrl === formUrl ? s : {
			...s,
			serverUrl: formUrl
		});
	}, [formUrl]);
	const probeRan = (0, react.useRef)(false);
	(0, react.useEffect)(() => {
		if (probeRan.current || !formUrl) return;
		probeRan.current = true;
		let cancelled = false;
		postVerify({ serverUrl: formUrl }).then((outcome) => {
			if (cancelled || outcome.type !== "success") return;
			setState((cur) => {
				if (cur.busy || cur.result !== null) return cur;
				return {
					...cur,
					connected: true,
					tokenSource: effectiveSource(outcome.tokenSource),
					verifiedUrl: formUrl
				};
			});
		});
		return () => {
			cancelled = true;
		};
	}, [formUrl]);
	const save = (0, react.useCallback)(async () => {
		const url = state.serverUrl.trim();
		const check = validateServerUrl(url);
		if (!check.ok) {
			setState((s) => decide(s, {
				type: "failure",
				kind: "bad-url",
				message: check.message
			}));
			return;
		}
		setState((s) => ({
			...s,
			busy: true,
			errorTarget: null,
			result: null
		}));
		let persisted = false;
		try {
			persisted = await writeServerUrl(props.form, url);
		} catch {
			persisted = false;
		}
		if (!persisted) {
			setState((s) => decide(s, {
				type: "failure",
				kind: "config-write",
				message: "the address could not be saved"
			}));
			return;
		}
		const draft = state.tokenDraft.trim();
		const body = { serverUrl: url };
		if (draft) body.token = draft;
		const outcome = await postVerify(body);
		setState((s) => decide(s, outcome));
	}, [
		state.serverUrl,
		state.tokenDraft,
		props.form
	]);
	const banner = bannerOf(state);
	const mark = resultMarkOf(state);
	const failureMessage = state.result && !state.result.ok ? state.result.message : null;
	const bannerHint = state.connected === true ? `Token source: ${state.tokenSource} · ${state.verifiedUrl}` : state.stored ? "Saved. The verify route was unreachable, so the connection was not checked." : "Set the server URL and a token below, then save.";
	const dotClass = banner.tone === "ok" ? "rc-dot rc-dot-ok" : banner.tone === "err" ? "rc-dot rc-dot-err" : "rc-dot";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "rembric-card",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "rc-head",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: "Rembric Plugin" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "Memories for the current workspace." })]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "rc-body",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rc-banner",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: dotClass }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: banner.label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rc-hint",
						children: bannerHint
					})] })]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rc-sec",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "Server" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "rc-label",
							htmlFor: "rembric-server-input",
							children: "Rembric server URL"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "rembric-server-input",
							type: "text",
							spellCheck: false,
							value: state.serverUrl,
							onChange: (e) => {
								addressDirty.current = true;
								const v = e.target.value;
								setState((s) => ({
									...s,
									serverUrl: v
								}));
							}
						}),
						state.errorTarget === "server" && failureMessage ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "rc-err",
							children: failureMessage
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "rc-hint",
							children: "Where the plugin sends and looks up memory."
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rc-sec",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "Token" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "rc-label",
							htmlFor: "rembric-token-input",
							children: "API token"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "rembric-token-input",
							type: "password",
							spellCheck: false,
							autoComplete: "off",
							value: state.tokenDraft,
							onChange: (e) => {
								const v = e.target.value;
								setState((s) => ({
									...s,
									tokenDraft: v
								}));
							}
						}),
						state.errorTarget === "token" && failureMessage ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "rc-err",
							children: failureMessage
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "rc-hint",
							children: [
								"Same token can also be set with ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "/rembric-login <token>" }),
								" in the chat; both paths write the same reference."
							]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "rc-rule" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rc-save-row",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: state.busy,
						onClick: () => void save(),
						children: "Save"
					}), mark ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: `rc-result rc-result-${mark.tone}`,
						children: mark.text
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "rc-result" })]
				})
			]
		})]
	});
}
// client/src/card.css?inline
var card_default = ".rembric-card {\n  --line: #242c3a;\n  --text: #e7eaf0;\n  --muted: #8b95a7;\n  --accent: #3f7bf0;\n  --accent-dim: #2b5bb5;\n  --ok: #3fb950;\n  --err: #f85149;\n  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;\n  border: 1px solid var(--line);\n  color: var(--text);\n  background: #151a23;\n  border-radius: 12px;\n  font: 14px / 1.5 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;\n  overflow: hidden;\n}\n\n.rembric-card * {\n  box-sizing: border-box;\n}\n\n.rembric-card .rc-head {\n  padding: 18px 20px 0;\n}\n\n.rembric-card .rc-head h1 {\n  margin: 0 0 4px;\n  font-size: 16px;\n}\n\n.rembric-card .rc-head p {\n  color: var(--muted);\n  margin: 0;\n  font-size: 12.5px;\n}\n\n.rembric-card .rc-body {\n  flex-direction: column;\n  gap: 18px;\n  padding: 16px 20px 20px;\n  display: flex;\n}\n\n.rembric-card .rc-sec {\n  flex-direction: column;\n  gap: 6px;\n  display: flex;\n}\n\n.rembric-card .rc-sec h2 {\n  text-transform: uppercase;\n  letter-spacing: .08em;\n  color: var(--muted);\n  margin: 0;\n  font-size: 12px;\n  font-weight: 600;\n}\n\n.rembric-card .rc-label {\n  color: var(--text);\n  margin: 0;\n  font-size: 13px;\n}\n\n.rembric-card input[type=\"text\"], .rembric-card input[type=\"password\"] {\n  border: 1px solid var(--line);\n  width: 100%;\n  color: var(--text);\n  font: 13px/1.4 var(--mono);\n  background: #0f141d;\n  border-radius: 8px;\n  outline: none;\n  padding: 9px 11px;\n}\n\n.rembric-card input:focus {\n  border-color: var(--accent);\n  box-shadow: 0 0 0 3px #3f7bf02e;\n}\n\n.rembric-card .rc-hint {\n  color: var(--muted);\n  margin: 0;\n  font-size: 12px;\n}\n\n.rembric-card .rc-hint code {\n  font-family: var(--mono);\n  border: 1px solid var(--line);\n  background: #0f141d;\n  border-radius: 4px;\n  padding: 1px 5px;\n  font-size: 11.5px;\n}\n\n.rembric-card .rc-err {\n  color: var(--err);\n  margin: 0;\n  font-size: 12px;\n}\n\n.rembric-card .rc-rule {\n  background: var(--line);\n  height: 1px;\n  margin: 0;\n}\n\n.rembric-card .rc-save-row {\n  align-items: center;\n  gap: 12px;\n  padding-top: 2px;\n  display: flex;\n}\n\n.rembric-card button {\n  font: inherit;\n  border: 1px solid var(--accent);\n  background: var(--accent);\n  color: #fff;\n  cursor: pointer;\n  border-radius: 8px;\n  padding: 8px 18px;\n}\n\n.rembric-card button:hover {\n  background: var(--accent-dim);\n  border-color: var(--accent-dim);\n}\n\n.rembric-card button:disabled {\n  opacity: .55;\n  cursor: default;\n}\n\n.rembric-card .rc-result {\n  align-items: center;\n  gap: 6px;\n  font-size: 13px;\n  display: flex;\n}\n\n.rembric-card .rc-result-ok {\n  color: var(--ok);\n}\n\n.rembric-card .rc-result-fail {\n  color: var(--err);\n}\n\n.rembric-card .rc-result-busy {\n  color: var(--muted);\n}\n\n.rembric-card .rc-banner {\n  border: 1px solid var(--line);\n  background: #0f141d;\n  border-radius: 8px;\n  align-items: flex-start;\n  gap: 10px;\n  padding: 12px 14px;\n  font-size: 13px;\n  display: flex;\n}\n\n.rembric-card .rc-dot {\n  background: var(--muted);\n  border-radius: 50%;\n  flex: none;\n  width: 8px;\n  height: 8px;\n  margin-top: 6px;\n}\n\n.rembric-card .rc-dot-ok {\n  background: var(--ok);\n}\n\n.rembric-card .rc-dot-err {\n  background: var(--err);\n}\n";
// client/src/index.ts
/** The plugin id stamped on the injected style element. */
const PLUGIN_ID = "dsh-rembric-plugin";
/** Stable key the client module system uses to identify the card stylesheet. */
const CARD_CSS_KEY = "dsh-rembric-plugin/card";
/**
* Add the card stylesheet as one tagged <style>. The returned disposer is the
* teardown: the client module system removes the tag when the plugin is
* disabled.
*/
function appendCardStyles() {
	const style = document.createElement("style");
	style.dataset.plugin = PLUGIN_ID;
	style.dataset.pluginCss = CARD_CSS_KEY;
	style.textContent = card_default;
	document.head.append(style);
	return () => style.remove();
}
/**
* Install the stylesheet once for the plugin's lifetime. Without a document
* there is nothing to style; without ctx.effect the tag is appended directly
* and left in place, so apply still cannot fail.
*/
function installCardStyles(ctx) {
	if (typeof document === "undefined") return;
	if (typeof ctx.effect === "function") {
		ctx.effect(appendCardStyles, "rembric: card styles");
		return;
	}
	appendCardStyles();
}
/** Shell modules this half needs; "slots" is the UI slot registry. */
const inject = ["slots"];
/**
* Register the settings card into the bundle's configuration slot, keyed by
* this package's name so the Plugins page renders it on our page.
*/
function apply(ctx) {
	installCardStyles(ctx);
	ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
		name: "plugins.bundle.config",
		key: PLUGIN_ID
	}, RembricSettingsCard));
}
exports.apply = apply;
exports.inject = inject;

return module.exports;}});

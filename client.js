window.__ModuleLoader__.load({id:"dsh-rembric-plugin",factory:(require)=>{var module={exports:{}};var exports=module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
let react = require("react");
react = __toESM(react, 1);
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
// client/src/card.ts
const h = react.createElement;
const { useCallback, useEffect, useRef, useState } = react;
const VERIFY_PATH = "/plugins/rembric/verify";
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
.rembric-card .rc-err{font-size:12px;color:var(--err);margin:0}
.rembric-card .rc-rule{height:1px;background:var(--line);margin:0}
.rembric-card .rc-save-row{display:flex;align-items:center;gap:12px;padding-top:2px}
.rembric-card button{font:inherit;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;padding:8px 18px;cursor:pointer}
.rembric-card button:hover{background:var(--accent-dim);border-color:var(--accent-dim)}
.rembric-card button:disabled{opacity:.55;cursor:default}
.rembric-card .rc-result{font-size:13px;display:flex;align-items:center;gap:6px}
.rembric-card .rc-result-ok{color:var(--ok)}
.rembric-card .rc-result-fail{color:var(--err)}
.rembric-card .rc-result-busy{color:var(--muted)}
.rembric-card .rc-banner{display:flex;gap:10px;align-items:flex-start;background:#0f141d;border:1px solid var(--line);border-radius:8px;padding:12px 14px;font-size:13px}
.rembric-card .rc-dot{width:8px;height:8px;border-radius:50%;background:var(--muted);margin-top:6px;flex:none}
.rembric-card .rc-dot-ok{background:var(--ok)}
.rembric-card .rc-dot-err{background:var(--err)}
`;
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
	const [state, setState] = useState(() => initialCardState(formUrl));
	const addressDirty = useRef(false);
	useEffect(() => {
		if (addressDirty.current) return;
		setState((s) => s.serverUrl === formUrl ? s : {
			...s,
			serverUrl: formUrl
		});
	}, [formUrl]);
	const probeRan = useRef(false);
	useEffect(() => {
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
	const save = useCallback(async () => {
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
	const bannerHint = state.connected === true ? `Token source: ${state.tokenSource} \u00b7 ${state.verifiedUrl}` : state.stored ? "Saved. The verify route was unreachable, so the connection was not checked." : "Set the server URL and a token below, then save.";
	const dotClass = banner.tone === "ok" ? "rc-dot rc-dot-ok" : banner.tone === "err" ? "rc-dot rc-dot-err" : "rc-dot";
	return h("div", { className: "rembric-card" }, h("style", null, CSS), h("div", { className: "rc-head" }, h("h1", null, "Rembric Plugin"), h("p", null, "Memories for the current workspace.")), h("div", { className: "rc-body" }, h("div", { className: "rc-banner" }, h("span", { className: dotClass }), h("div", null, h("b", null, banner.label), h("p", { className: "rc-hint" }, bannerHint))), h("div", { className: "rc-sec" }, h("h2", null, "Server"), h("label", {
		className: "rc-label",
		htmlFor: "rembric-server-input"
	}, "Rembric server URL"), h("input", {
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
	}), state.errorTarget === "server" && failureMessage ? h("p", { className: "rc-err" }, failureMessage) : null, h("p", { className: "rc-hint" }, "Where the plugin sends and looks up memory.")), h("div", { className: "rc-sec" }, h("h2", null, "Token"), h("label", {
		className: "rc-label",
		htmlFor: "rembric-token-input"
	}, "API token"), h("input", {
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
	}), state.errorTarget === "token" && failureMessage ? h("p", { className: "rc-err" }, failureMessage) : null, h("p", { className: "rc-hint" }, "Same token can also be set with ", h("code", null, "/rembric-login <token>"), " in the chat; both paths write the same reference.")), h("div", { className: "rc-rule" }), h("div", { className: "rc-save-row" }, h("button", {
		type: "button",
		disabled: state.busy,
		onClick: () => void save()
	}, "Save"), mark ? h("span", { className: `rc-result rc-result-${mark.tone}` }, mark.text) : h("span", { className: "rc-result" }))));
}
// client/src/index.ts
/** Shell modules this half needs; "slots" is the UI slot registry. */
const inject = ["slots"];
/**
* Register the settings card into the bundle's configuration slot, keyed by
* this package's name so the Plugins page renders it on our page.
*/
function apply(ctx) {
	ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
		name: "plugins.bundle.config",
		key: "dsh-rembric-plugin"
	}, RembricSettingsCard));
}
exports.apply = apply;
exports.inject = inject;

return module.exports;}});

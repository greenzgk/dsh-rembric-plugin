// The Rembric settings card: server URL and write-only token fields, a stored
// token probe on open, and one Save action for both.
//
// The card is a thin shell: every transition goes through the pure decide() in
// ./decide, which is tested without a DOM. This file only reads the host
// config route on mount, presses buttons, and talks to the host routes.
//
// Host contract:
//   GET  /plugins/rembric/config -> { serverUrl, tokenSource, hasToken }
//   POST /plugins/rembric/config   { serverUrl } persists through the config
//                                  editor, then the plugin restarts
//   POST /plugins/rembric/verify   { serverUrl, token? } checks the connection
//                                  and writes the token on success
// The card never reads a config form prop: the host owns the config document.
// The token never enters config: the password field holds only the user's
// draft, which is sent to the verify route and persisted host-side.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";

import {
  bannerOf,
  decide,
  effectiveSource,
  resultMarkOf,
  validateServerUrl,
  type CardState,
} from "./decide";
import { fetchHostConfig, saveHostConfig, verifyHostConnection } from "./host-config";

function initialCardState(): CardState {
  return {
    serverUrl: "",
    tokenDraft: "",
    tokenSource: "none",
    connected: null,
    busy: false,
    errorTarget: null,
    result: null,
    stored: false,
    verifiedUrl: "",
  };
}

/**
 * Reads the effective server address from the config route, probes the
 * stored/ambient token on open, and saves address then token through the
 * single Save button.
 */
export function RembricSettingsCard(_props: { view: "summary" | "page" }): ReactElement {
  const [state, setState] = useState<CardState>(initialCardState);
  // Once the user edits the address field, stop adopting the host value
  // underneath them; the Save click is what persists.
  const addressDirty = useRef(false);

  // Mount: adopt the effective address and token source from the host, then
  // probe the stored/ambient token against that address once. The route
  // answers the same effective value the plugin runs with, so the field opens
  // on what is really in use. The probe is tied to the host URL, not to the
  // field: typing must not silently verify (and possibly mark connected) an
  // address the user has not saved yet. Only success changes the banner;
  // failure or an unreachable route leaves "Not connected".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const config = await fetchHostConfig();
      if (cancelled || !config) return;
      const url = config.serverUrl.trim();
      setState((cur) =>
        addressDirty.current
          ? { ...cur, tokenSource: config.tokenSource }
          : { ...cur, serverUrl: config.serverUrl, tokenSource: config.tokenSource },
      );
      if (!url || addressDirty.current) return;
      const outcome = await verifyHostConnection({ serverUrl: url });
      if (cancelled || outcome.type !== "success") return;
      setState((cur) => {
        // A save started (or already finished) while this probe was in
        // flight owns the banner and the save row; a late probe must not
        // flip "Not connected" under a visible ✕.
        if (cur.busy || cur.result !== null) return cur;
        return {
          ...cur,
          connected: true,
          tokenSource: effectiveSource(outcome.tokenSource),
          verifiedUrl: url,
        };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    const url = state.serverUrl.trim();
    const check = validateServerUrl(url);
    if (!check.ok) {
      setState((s) => decide(s, { type: "failure", kind: "bad-url", message: check.message }));
      return;
    }
    setState((s) => ({ ...s, busy: true, errorTarget: null, result: null }));

    // One save action, after all fields: persist the address through the
    // config route first, then verify. A failed write stops before the
    // network call.
    const saved = await saveHostConfig(url);
    if (!saved.ok) {
      setState((s) => decide(s, { type: "failure", kind: "config-write", message: saved.message }));
      return;
    }

    // Empty draft = verify the stored/ambient token; the route never
    // erases it. Explicit draft = the route persists it on success.
    const draft = state.tokenDraft.trim();
    const body: { serverUrl: string; token?: string } = { serverUrl: url };
    if (draft) body.token = draft;
    const outcome = await verifyHostConnection(body);
    setState((s) => decide(s, outcome));
  }, [state.serverUrl, state.tokenDraft]);

  const banner = bannerOf(state);
  const mark = resultMarkOf(state);
  const failureMessage = state.result && !state.result.ok ? state.result.message : null;

  const bannerHint =
    state.connected === true
      ? `Token source: ${state.tokenSource} · ${state.verifiedUrl}`
      : state.stored
        ? "Saved. The verify route was unreachable, so the connection was not checked."
        : "Set the server URL and a token below, then save.";

  const dotClass =
    banner.tone === "ok"
      ? "rc-dot rc-dot-ok"
      : banner.tone === "err"
        ? "rc-dot rc-dot-err"
        : "rc-dot";

  return (
    <div className="rembric-card">
      <div className="rc-head">
        <h1>Rembric Plugin</h1>
        <p>Memories for the current workspace.</p>
      </div>
      <div className="rc-body">
        <div className="rc-banner">
          <span className={dotClass} />
          <div>
            <b>{banner.label}</b>
            <p className="rc-hint">{bannerHint}</p>
          </div>
        </div>
        <div className="rc-sec">
          <h2>Server</h2>
          <label className="rc-label" htmlFor="rembric-server-input">
            Rembric server URL
          </label>
          <input
            id="rembric-server-input"
            type="text"
            spellCheck={false}
            value={state.serverUrl}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              addressDirty.current = true;
              const v = e.target.value;
              setState((s) => ({ ...s, serverUrl: v }));
            }}
          />
          {state.errorTarget === "server" && failureMessage ? (
            <p className="rc-err">{failureMessage}</p>
          ) : null}
          <p className="rc-hint">Where the plugin sends and looks up memory.</p>
        </div>
        <div className="rc-sec">
          <h2>Token</h2>
          <label className="rc-label" htmlFor="rembric-token-input">
            API token
          </label>
          <input
            id="rembric-token-input"
            type="password"
            spellCheck={false}
            autoComplete="off"
            value={state.tokenDraft}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const v = e.target.value;
              setState((s) => ({ ...s, tokenDraft: v }));
            }}
          />
          {state.errorTarget === "token" && failureMessage ? (
            <p className="rc-err">{failureMessage}</p>
          ) : null}
          <p className="rc-hint">
            Same token can also be set with <code>/rembric-login &lt;token&gt;</code> in the chat;
            both paths write the same reference.
          </p>
        </div>
        <div className="rc-rule" />
        <div className="rc-save-row">
          <button type="button" disabled={state.busy} onClick={() => void save()}>
            Save
          </button>
          {mark ? (
            <span className={`rc-result rc-result-${mark.tone}`}>{mark.text}</span>
          ) : (
            <span className="rc-result" />
          )}
        </div>
      </div>
    </div>
  );
}

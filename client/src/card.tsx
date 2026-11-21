// The Rembric settings card: server URL and write-only token fields, a stored
// token probe on open, and one Save action for both.
//
// The card is a thin shell: every transition goes through the pure decide() in
// ./decide, which is tested without a DOM. This file only reads the harness
// config form, presses buttons, and talks to the host verify route.
//
// Form contract (dsh-client-ui-plugin-manager / dsh-client-ui-settings):
//   props.form = { state: { status, value, revision, ... }, mutate(ops, rev) }
//   read  current address: form.state.value.serverUrl
//   write current address: form.mutate([{op:"set", path:["serverUrl"], value}], rev)
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
  type VerifyOutcome,
} from "./decide";

const VERIFY_PATH = "/plugins/rembric/verify";

interface ConfigFormLike {
  state?: {
    status?: string;
    value?: Record<string, unknown> | undefined;
    revision?: number | undefined;
  };
  mutate?: (ops: unknown[], expectedRevision?: number) => Promise<boolean>;
}

/** Current effective server address as the host config form sees it. */
function formServerUrl(form: unknown): string {
  const f = form as ConfigFormLike | undefined;
  const value = f?.state?.value;
  if (value && typeof value.serverUrl === "string") return value.serverUrl;
  return "";
}

/** Persist the server address through the harness config form. */
async function writeServerUrl(form: unknown, url: string): Promise<boolean> {
  const f = form as ConfigFormLike | undefined;
  if (!f || typeof f.mutate !== "function") return false;
  const ops = [{ op: "set", path: ["serverUrl"], value: url }];
  return (await f.mutate(ops, f.state?.revision)) === true;
}

/** Map a verify-route JSON body into the decide() outcome vocabulary. */
function outcomeFromJson(data: unknown): VerifyOutcome {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (d.ok === true) {
      const ts = d.tokenSource;
      return {
        type: "success",
        tokenSource:
          ts === "store" || ts === "env" || ts === "none" || ts === "request" ? ts : "none",
      };
    }
    if (d.ok === false) {
      return {
        type: "failure",
        kind: typeof d.kind === "string" ? d.kind : "error",
        message: typeof d.message === "string" ? d.message : "verification failed",
      };
    }
  }
  return { type: "unavailable" };
}

async function postVerify(body: Record<string, string>): Promise<VerifyOutcome> {
  try {
    const resp = await fetch(VERIFY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return outcomeFromJson(await resp.json().catch(() => null));
  } catch {
    // Route missing or transport failure: never claim "Connected".
    return { type: "unavailable" };
  }
}

function initialCardState(serverUrl: string): CardState {
  return {
    serverUrl,
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
 * Reads the effective server address from the config form, probes the
 * stored/ambient token on open, and saves address then token through the
 * single Save button.
 */
export function RembricSettingsCard(props: {
  view: "summary" | "page";
  form?: unknown;
}): ReactElement {
  const formUrl = formServerUrl(props.form);
  const [state, setState] = useState<CardState>(() => initialCardState(formUrl));
  // Once the user edits the address field, stop adopting the form value
  // underneath them; the Save click is what persists.
  const addressDirty = useRef(false);

  // Adopt the effective address from the config form until the user types.
  useEffect(() => {
    if (addressDirty.current) return;
    setState((s) => (s.serverUrl === formUrl ? s : { ...s, serverUrl: formUrl }));
  }, [formUrl]);

  // Open probe: does the stored/ambient token verify against the
  // effective address? The config form hydrates after mount, so the probe
  // waits for formUrl and then runs exactly once — re-verification is a
  // Save action, not a per-keystroke one. Only success changes the banner;
  // failure or an unreachable route leaves "Not connected".
  const probeRan = useRef(false);
  useEffect(() => {
    if (probeRan.current || !formUrl) return;
    probeRan.current = true;
    let cancelled = false;
    void postVerify({ serverUrl: formUrl }).then((outcome) => {
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
          verifiedUrl: formUrl,
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
      setState((s) => decide(s, { type: "failure", kind: "bad-url", message: check.message }));
      return;
    }
    setState((s) => ({ ...s, busy: true, errorTarget: null, result: null }));

    // One save action, after all fields: persist the address first, then
    // verify. A failed config write stops before the network call.
    let persisted = false;
    try {
      persisted = await writeServerUrl(props.form, url);
    } catch {
      persisted = false;
    }
    if (!persisted) {
      setState((s) =>
        decide(s, {
          type: "failure",
          kind: "config-write",
          message: "the address could not be saved",
        }),
      );
      return;
    }

    // Empty draft = verify the stored/ambient token; the route never
    // erases it. Explicit draft = the route persists it on success.
    const draft = state.tokenDraft.trim();
    const body: Record<string, string> = { serverUrl: url };
    if (draft) body.token = draft;
    const outcome = await postVerify(body);
    setState((s) => decide(s, outcome));
  }, [state.serverUrl, state.tokenDraft, props.form]);

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

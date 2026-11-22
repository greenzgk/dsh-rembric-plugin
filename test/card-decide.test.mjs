// test/card-decide.test.mjs — the pure decision core.
//
// decide(state, outcome) is the whole card brain: no DOM, no fetch, no
// timers. Expected values are the card's contract, not values recomputed by
// the implementation.
import { describe, it, expect } from "vite-plus/test";

import { decide, bannerOf, resultMarkOf, validateServerUrl } from "../client/src/decide.ts";

/** Fresh card state: nothing verified yet, idle. */
function freshState(overrides = {}) {
  return {
    serverUrl: "http://127.0.0.1:8790",
    tokenDraft: "",
    tokenSource: "none",
    connected: null,
    busy: false,
    errorTarget: null,
    result: null,
    stored: false,
    verifiedUrl: "",
    ...overrides,
  };
}

describe("decide: success", () => {
  it("marks the card connected and clears the token draft", () => {
    const next = decide(freshState({ busy: true, tokenDraft: "tok-123" }), {
      type: "success",
      tokenSource: "request",
    });
    expect(next.connected).toBe(true);
    expect(next.busy).toBe(false);
    expect(next.errorTarget).toBeNull();
    expect(next.result).toEqual({ ok: true });
    expect(next.tokenDraft).toBe("");
    expect(next.stored).toBe(false);
    // The Connected hint must render the address this verification checked,
    // not whatever the field later shows.
    expect(next.verifiedUrl).toBe("http://127.0.0.1:8790");
  });

  it("reports a token that just arrived via request as coming from the store", () => {
    // The route persists an explicit token on success, so afterwards the
    // effective source is the credential store, not the one-shot request.
    const next = decide(freshState(), { type: "success", tokenSource: "request" });
    expect(next.tokenSource).toBe("store");
  });

  it("keeps store and env sources as they are", () => {
    expect(decide(freshState(), { type: "success", tokenSource: "store" }).tokenSource).toBe(
      "store",
    );
    expect(decide(freshState(), { type: "success", tokenSource: "env" }).tokenSource).toBe("env");
  });
});

describe("decide: empty token draft verifies the stored token", () => {
  it("an empty draft verifying successfully keeps the stored source and erases nothing", () => {
    // An empty token draft verifies the stored token. The draft was and
    // stays empty; the stored source survives the round-trip untouched.
    const next = decide(freshState({ tokenDraft: "", tokenSource: "store" }), {
      type: "success",
      tokenSource: "store",
    });
    expect(next.tokenDraft).toBe("");
    expect(next.tokenSource).toBe("store");
    expect(next.connected).toBe(true);
    expect(next.verifiedUrl).toBe("http://127.0.0.1:8790");
  });

  it("an empty draft hitting no-token points at the token field and keeps the draft empty", () => {
    // Nothing was typed and nothing is stored: the failure lands under the
    // token field; the draft is not rewritten to anything that could be
    // mistaken for a stored value.
    const next = decide(freshState({ tokenDraft: "", tokenSource: "none" }), {
      type: "failure",
      kind: "no-token",
      message: "no token is configured",
    });
    expect(next.tokenDraft).toBe("");
    expect(next.errorTarget).toBe("token");
    expect(next.connected).toBe(false);
  });

  it("an empty draft against an unreachable route reads Stored, never Connected", () => {
    const next = decide(freshState({ tokenDraft: "", tokenSource: "store" }), {
      type: "unavailable",
    });
    expect(next.stored).toBe(true);
    expect(next.connected).toBe(false);
    expect(next.tokenDraft).toBe("");
  });
});

describe("decide: failure routes the error to the guilty field", () => {
  const tokenFaults = ["rejected-token", "no-project-access", "no-token", "save-failed"];
  const serverFaults = ["no-mcp", "timeout", "unreachable"];

  for (const kind of tokenFaults) {
    it(`points a ${kind} failure at the token field`, () => {
      const next = decide(freshState({ busy: true }), {
        type: "failure",
        kind,
        message: `boom: ${kind}`,
      });
      expect(next.errorTarget).toBe("token");
      expect(next.connected).toBe(false);
      expect(next.busy).toBe(false);
      expect(next.result).toEqual({ ok: false, message: `boom: ${kind}` });
      // A failure does not rewrite what was last verified.
      expect(next.verifiedUrl).toBe("");
    });
  }

  for (const kind of serverFaults) {
    it(`points a ${kind} failure at the server field`, () => {
      const next = decide(freshState({ busy: true }), {
        type: "failure",
        kind,
        message: `boom: ${kind}`,
      });
      expect(next.errorTarget).toBe("server");
      expect(next.connected).toBe(false);
      expect(next.result).toEqual({ ok: false, message: `boom: ${kind}` });
    });
  }

  it("points an unknown failure kind at the server field", () => {
    const next = decide(freshState(), {
      type: "failure",
      kind: "weird-thing",
      message: "who knows",
    });
    expect(next.errorTarget).toBe("server");
  });

  it("keeps the token draft after a failure so the user can fix it", () => {
    const next = decide(freshState({ tokenDraft: "typo-token" }), {
      type: "failure",
      kind: "rejected-token",
      message: "the server rejected the token (HTTP 401)",
    });
    expect(next.tokenDraft).toBe("typo-token");
  });
});

describe("decide: verify route unavailable", () => {
  it("lands on Stored, never Connected", () => {
    const next = decide(freshState({ busy: true }), { type: "unavailable" });
    expect(next.stored).toBe(true);
    expect(next.connected).toBe(false);
    expect(next.busy).toBe(false);
    expect(next.errorTarget).toBeNull();
    expect(next.result).toEqual({ ok: true });
  });

  it("Stored never reads as Connected through the banner", () => {
    const banner = bannerOf(decide(freshState(), { type: "unavailable" }));
    expect(banner.label).toBe("Stored");
    expect(banner.label).not.toBe("Connected");
  });
});

describe("decide: purity", () => {
  it("returns a new object and never mutates the input state", () => {
    const state = Object.freeze(freshState({ busy: true }));
    const outcome = Object.freeze({ type: "failure", kind: "timeout", message: "m" });
    const next = decide(state, outcome);
    expect(next).not.toBe(state);
    expect(state.busy).toBe(true);
    expect(state.connected).toBeNull();
  });
});

describe("bannerOf", () => {
  it("shows Connected only when verification succeeded", () => {
    expect(bannerOf(freshState({ connected: true }))).toEqual({
      label: "Connected",
      tone: "ok",
    });
  });

  it("shows Stored when the address was saved but verification did not run", () => {
    expect(bannerOf(freshState({ stored: true }))).toEqual({
      label: "Stored",
      tone: "neutral",
    });
  });

  it("shows Not connected otherwise", () => {
    expect(bannerOf(freshState())).toEqual({ label: "Not connected", tone: "err" });
    expect(bannerOf(freshState({ connected: false }))).toEqual({
      label: "Not connected",
      tone: "err",
    });
  });
});

describe("resultMarkOf", () => {
  it("shows Validating while busy", () => {
    expect(resultMarkOf(freshState({ busy: true }))).toEqual({
      text: "Validating…",
      tone: "busy",
    });
  });

  it("shows the green check after a verified save", () => {
    expect(resultMarkOf(freshState({ connected: true, result: { ok: true } }))).toEqual({
      text: "✓ Token is valid",
      tone: "ok",
    });
  });

  it("shows Saved when the address was stored without verification", () => {
    expect(resultMarkOf(freshState({ stored: true, result: { ok: true } }))).toEqual({
      text: "✓ Saved",
      tone: "ok",
    });
  });

  it("shows the red cross with the failure message", () => {
    expect(
      resultMarkOf(
        freshState({ result: { ok: false, message: "the server rejected the token (HTTP 401)" } }),
      ),
    ).toEqual({ text: "✕ the server rejected the token (HTTP 401)", tone: "fail" });
  });

  it("shows nothing before the first save", () => {
    expect(resultMarkOf(freshState())).toBeNull();
  });
});

describe("validateServerUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validateServerUrl("http://127.0.0.1:8790")).toEqual({ ok: true });
    expect(validateServerUrl("https://rembric.example.com")).toEqual({ ok: true });
  });

  it("rejects anything that is not an http(s) URL with the fixed copy", () => {
    expect(validateServerUrl("not a url")).toEqual({
      ok: false,
      message: "That is not a URL. Expected something like http://127.0.0.1:8790",
    });
    expect(validateServerUrl("")).toEqual({
      ok: false,
      message: "That is not a URL. Expected something like http://127.0.0.1:8790",
    });
    expect(validateServerUrl("ftp://host")).toEqual({
      ok: false,
      message: "That is not a URL. Expected something like http://127.0.0.1:8790",
    });
  });
});

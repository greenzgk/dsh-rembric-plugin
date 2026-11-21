// client/src/decide.ts — the pure decision core of the Rembric settings card.
//
// Ticket #18 seam 1: every card transition is a function of (state, outcome)
// with no DOM, no fetch and no timers, so the whole brain is testable as a
// plain module. The card component only renders this state and feeds it
// outcomes; the verify route produces the outcomes from the host check.
//
// Shape from spec #14, plus `stored`: the address was persisted but the
// verification never ran (verify route unavailable) — the "Stored" banner
// the ticket requires, which the spec shape alone cannot express.

/** Where the effective token comes from. "none" means no token anywhere. */
export type TokenSource = "store" | "env" | "none";

/** Everything the card renders from. */
export interface CardState {
  /** Server address shown in the field; empty until the form provides one. */
  serverUrl: string;
  /** What the user typed in the token field. Empty = keep the stored token. */
  tokenDraft: string;
  /** Source of the effective token after the last verification. */
  tokenSource: TokenSource;
  /** null = never verified this session; otherwise the last verification. */
  connected: boolean | null;
  /** A save/verify round-trip is in flight. */
  busy: boolean;
  /** Which field carries the current error, if any. */
  errorTarget: "server" | "token" | null;
  /** Result of the last save attempt, shown in the save row. */
  result: { ok: true } | { ok: false; message: string } | null;
  /** Address saved while the verify route was unreachable ("Stored"). */
  stored: boolean;
  /**
   * The address the last successful verification actually checked. The
   * Connected hint renders this, not the live field value, so editing the
   * URL after a successful save cannot advertise an unverified address.
   */
  verifiedUrl: string;
}

/**
 * Outcome of one verification attempt, mapped from the verify route JSON:
 * success carries the token source the host used ("request" when the card
 * sent an explicit token), failure carries the host's failure kind.
 */
export type VerifyOutcome =
  | { type: "success"; tokenSource: TokenSource | "request" }
  | { type: "failure"; kind: string; message: string }
  | { type: "unavailable" };

/**
 * Kinds that mean the token is at fault; everything else is the address.
 * "save-failed" counts as the token's: the address saved fine, the token
 * is what could not be persisted.
 */
const TOKEN_FAULT_KINDS = new Set([
  "rejected-token",
  "no-project-access",
  "no-token",
  "save-failed",
]);

/**
 * The effective token source after a success whose token arrived with the
 * request: the route just persisted it, so from now on it lives in the
 * store. Shared by decide() and the card's open probe so the mapping
 * exists once.
 */
export function effectiveSource(source: TokenSource | "request"): TokenSource {
  return source === "request" ? "store" : source;
}

/**
 * The one transition function. Returns a fresh state; never mutates input.
 */
export function decide(state: CardState, outcome: VerifyOutcome): CardState {
  switch (outcome.type) {
    case "success":
      return {
        ...state,
        tokenSource: effectiveSource(outcome.tokenSource),
        tokenDraft: "",
        connected: true,
        busy: false,
        errorTarget: null,
        result: { ok: true },
        stored: false,
        // This is the address the route just checked; pin it for the hint.
        verifiedUrl: state.serverUrl.trim(),
      };
    case "failure":
      return {
        ...state,
        connected: false,
        busy: false,
        stored: false,
        errorTarget: TOKEN_FAULT_KINDS.has(outcome.kind) ? "token" : "server",
        result: { ok: false, message: outcome.message },
      };
    case "unavailable":
      // The address was saved but the verify route could not answer.
      // The ticket is explicit: this must never read as Connected.
      return {
        ...state,
        connected: false,
        busy: false,
        stored: true,
        errorTarget: null,
        result: { ok: true },
      };
  }
}

/** Banner label and tone for the current state. */
export function bannerOf(state: CardState): {
  label: string;
  tone: "ok" | "neutral" | "err";
} {
  if (state.connected === true) return { label: "Connected", tone: "ok" };
  if (state.stored) return { label: "Stored", tone: "neutral" };
  return { label: "Not connected", tone: "err" };
}

/** Save-row result mark for the current state, or null for nothing yet. */
export function resultMarkOf(state: CardState): {
  text: string;
  tone: "busy" | "ok" | "fail";
} | null {
  if (state.busy) return { text: "Validating…", tone: "busy" };
  if (!state.result) return null;
  if (state.result.ok) {
    return state.connected
      ? { text: "✓ Token is valid", tone: "ok" }
      : { text: "✓ Saved", tone: "ok" };
  }
  return { text: "✕ " + state.result.message, tone: "fail" };
}

/**
 * Client-side URL sanity check before touching the config form.
 * Rejection copy is the approved prototype string.
 */
export function validateServerUrl(url: string): { ok: true } | { ok: false; message: string } {
  if (/^https?:\/\/\S+$/.test(url.trim())) return { ok: true };
  return {
    ok: false,
    message: "That is not a URL. Expected something like http://127.0.0.1:8790",
  };
}

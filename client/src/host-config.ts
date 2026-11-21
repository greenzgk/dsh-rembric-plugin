// The card's view of the two host routes: the config route (prefill and save
// the server address) and the verify route (probe and persist the token).
// Fetching lives here so the component only renders state and feeds outcomes
// into decide(); tests can inject a fetch instead of starting a host.

import type { TokenSource, VerifyOutcome } from "./decide";

const CONFIG_PATH = "/plugins/rembric/config";
const VERIFY_PATH = "/plugins/rembric/verify";

/** The GET /plugins/rembric/config answer. hasToken never carries the token. */
export interface HostConfig {
  serverUrl: string;
  tokenSource: TokenSource;
  hasToken: boolean;
}

export type SaveResult = { ok: true } | { ok: false; message: string };

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function tokenSourceOf(value: unknown): TokenSource {
  return value === "store" || value === "env" ? value : "none";
}

/** Read the effective address and the token state; null when the route cannot answer. */
export async function fetchHostConfig(fetchImpl: typeof fetch = fetch): Promise<HostConfig | null> {
  try {
    const response = await fetchImpl(CONFIG_PATH, { method: "GET" });
    if (!response.ok) return null;
    const data = jsonObject(await response.json().catch(() => null));
    if (!data) return null;
    return {
      serverUrl: typeof data.serverUrl === "string" ? data.serverUrl : "",
      tokenSource: tokenSourceOf(data.tokenSource),
      hasToken: data.hasToken === true,
    };
  } catch {
    return null;
  }
}

/**
 * Save the address through the config route. The route answers before the
 * plugin restarts, so a lost connection after this resolves is expected.
 */
export async function saveHostConfig(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveResult> {
  try {
    const response = await fetchImpl(CONFIG_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverUrl }),
    });
    const data = jsonObject(await response.json().catch(() => null));
    if (response.ok && data?.ok === true) return { ok: true };
    const message =
      data && typeof data.error === "string" ? data.error : "the address could not be saved";
    return { ok: false, message };
  } catch {
    return { ok: false, message: "the address could not be saved" };
  }
}

/** Run the shared connection check; the route writes the token only on success. */
export async function verifyHostConnection(
  body: { serverUrl: string; token?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyOutcome> {
  try {
    const response = await fetchImpl(VERIFY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return outcomeFromJson(await response.json().catch(() => null));
  } catch {
    return { type: "unavailable" };
  }
}

function outcomeFromJson(value: unknown): VerifyOutcome {
  const data = jsonObject(value);
  if (!data) return { type: "unavailable" };
  if (data.ok === true) {
    const source = data.tokenSource;
    const tokenSource: TokenSource | "request" =
      source === "store" || source === "env" || source === "none" || source === "request"
        ? source
        : "none";
    return { type: "success", tokenSource };
  }
  if (data.ok === false) {
    return {
      type: "failure",
      kind: typeof data.kind === "string" ? data.kind : "error",
      message: typeof data.message === "string" ? data.message : "verification failed",
    };
  }
  return { type: "unavailable" };
}

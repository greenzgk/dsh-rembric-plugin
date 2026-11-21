// The settings card's server-config endpoint.
//
// The card sits in the bundle-config slot and gets no form state from the host,
// so it reads the effective server address here and saves a new one through the
// harness config editor. GET reports where the token comes from and whether one
// exists; it never reveals the token itself.
//
// POST answers before calling edit(): an ordinary config field restarts the
// plugin, so waiting for the edit would tear down the response mid-flight.
//
// Like the verify route, this route is guarded by the same request-rejection
// check and is not registered when the web server or connection service is
// absent. Without a config editor the route still answers GET and reports 501
// for POST, so the card shows an address error instead of hanging.

import { readJsonBody, sendJson } from "./verify-route.js";

export const CONFIG_PATH = "/plugins/rembric/config";

// Sources the connection check reports. "request" (a token typed into the
// card) never applies here because this route does not touch the token.
const TOKEN_SOURCES = new Set(["store", "env"]);

export function registerConfigRoute(ctx, deps) {
  const webServer = ctx.get("webServer");
  const connection = ctx.get("connection");
  if (!webServer || !connection) return;

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: CONFIG_PATH,
        handler: (req, res) => handleConfig(ctx, deps, connection, req, res),
      }),
    "rembric: config route",
  );
}

async function handleConfig(ctx, deps, connection, req, res) {
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    res.writeHead(rejection);
    res.end(rejection === 401 ? "unauthorized" : "forbidden");
    return;
  }

  if (req.method === "GET") {
    await answerConfig(ctx, deps, res);
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  await saveConfig(ctx, req, res);
}

async function answerConfig(ctx, deps, res) {
  const info = deps.serverInfo();
  const resolved = await resolveTokenForCard(ctx, deps);
  const tokenSource = TOKEN_SOURCES.has(resolved.source) ? resolved.source : "none";
  sendJson(res, 200, {
    serverUrl: info.url,
    tokenSource,
    hasToken: Boolean(resolved.value),
  });
}

// A failed lookup must not turn the whole answer into a 500: the card still
// needs the address, and a missing token is a valid state to report.
async function resolveTokenForCard(ctx, deps) {
  try {
    return await deps.resolveToken();
  } catch {
    ctx.logger.warn("rembric: config token lookup failed");
    return { value: null, source: "none" };
  }
}

async function saveConfig(ctx, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error?.code === "BODY_TOO_LARGE") {
      sendJson(res, 413, { error: "request body too large" });
      return;
    }
    if (error?.code === "INVALID_JSON") {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(`rembric: config request failed: ${message}`);
    sendJson(res, 500, { error: "the address could not be saved" });
    return;
  }

  const raw = typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
  if (!raw) {
    sendJson(res, 400, { error: "serverUrl is required" });
    return;
  }
  const serverUrl = normalizeServerUrl(raw);
  if (!serverUrl) {
    sendJson(res, 400, { error: "serverUrl must be an http(s) URL" });
    return;
  }

  const configEditor = ctx.get("configEditor");
  if (!configEditor || typeof configEditor.edit !== "function") {
    sendJson(res, 501, {
      error: "the host has no configuration editor, so the server URL cannot be saved",
    });
    return;
  }

  // Answer first: the edit restarts the plugin.
  sendJson(res, 200, { ok: true, serverUrl });
  try {
    await configEditor.edit(ctx.fiber.entry, (current) => ({ ...current, serverUrl }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(`rembric: server URL was answered but the config editor failed: ${message}`);
  }
}

// Same normalization the host applies when it reads the address: trim the
// trailing slashes and accept only http(s).
function normalizeServerUrl(raw) {
  const trimmed = raw.replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return trimmed;
}

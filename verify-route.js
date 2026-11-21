// verify-route.js — the settings card's server-side verify endpoint (ticket #17).
//
// POST /plugins/rembric/verify answers { serverUrl, token? } with a live probe
// of the Rembric server: on success the server name, the tool count, and where
// the active token came from; on failure the classified message. The token is
// never echoed back and never logged.
//
// The route is guarded by the same connection request-rejection check the
// harness applies to its own /api routes, so only host-authorized callers
// reach the probe. When the web server or the connection service is absent
// (trimmed / Electron builds) the route simply does not register and the rest
// of the plugin keeps working.

const VERIFY_PATH = "/plugins/rembric/verify";

// The body is two short strings; anything bigger is not this card.
const MAX_VERIFY_BODY_BYTES = 8 * 1024;

// deps is { checkConnection, resolveToken, saveToken } injected from
// host.js so this module never imports the host back (no module cycle).
export function registerVerifyRoute(ctx, deps) {
  const webServer = ctx.get("webServer");
  const connection = ctx.get("connection");
  if (!webServer || !connection) return;

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: VERIFY_PATH,
        handler: (req, res) => handleVerify(ctx, deps, connection, req, res),
      }),
    "rembric: verify route",
  );
}

async function handleVerify(ctx, deps, connection, req, res) {
  // The same fence the harness puts on its own /api routes: untrusted callers
  // are turned away before the body is read or the network is touched.
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    res.writeHead(rejection);
    res.end(rejection === 401 ? "unauthorized" : "forbidden");
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  // Kept in scope so the catch path can redact the token from any diagnostic.
  let activeToken = "";
  try {
    const body = await readJsonBody(req);
    const serverUrl = typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";
    if (!serverUrl) {
      sendJson(res, 400, { error: "serverUrl is required" });
      return;
    }

    // An empty or absent token means "verify the stored one" — fall back to the
    // same resolution the commands use (store > ambient env).
    const requestToken = typeof body.token === "string" ? body.token.trim() : "";
    let token = requestToken;
    let tokenSource = "request";
    activeToken = token;
    if (!token) {
      // The resolver can fail before the route ever holds the token value, and
      // its error text may carry the stored secret — with no value to redact
      // against, the failure is reported as a fixed diagnostic instead.
      let resolved;
      try {
        resolved = await deps.resolveToken(ctx);
      } catch {
        throw new Error("token resolution failed");
      }
      token = resolved.value ?? "";
      tokenSource = resolved.source;
      activeToken = token;
    }

    const result = await deps.checkConnection({ serverUrl, token });
    if (result.ok) {
      // A token that arrived with this request and verified is persisted
      // through the same path /rembric-login uses, so both write the same
      // credential reference. Tokens resolved from the store or ambient
      // env are already persisted — only the request path writes, and a
      // failed verification never writes.
      if (tokenSource === "request") {
        try {
          await deps.saveToken(requestToken);
        } catch (saveError) {
          // The verification passed but the token did not survive, so the
          // card must not claim Connected. The reason goes to the log,
          // redacted; the response carries only the fixed diagnostic.
          const reason = saveError instanceof Error ? saveError.message : String(saveError);
          ctx.logger.warn(
            redact(
              `rembric: verify succeeded but the token could not be saved: ${reason}`,
              requestToken,
            ),
          );
          sendJson(res, 200, {
            ok: false,
            kind: "save-failed",
            message: "the token could not be saved (the host log has the reason)",
          });
          return;
        }
      }
      sendJson(res, 200, {
        ok: true,
        serverName: result.serverName ?? null,
        toolCount: result.toolCount,
        tokenSource,
      });
    } else {
      sendJson(res, 200, { ok: false, kind: result.kind, message: result.message });
    }
  } catch (error) {
    if (error?.code === "BODY_TOO_LARGE") {
      sendJson(res, 413, { error: "request body too large" });
      return;
    }
    if (error?.code === "INVALID_JSON") {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    // Unexpected failure: log a redacted one-line diagnostic, answer with a
    // fixed message. Never a stack trace, never the token.
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn(redact(`rembric: verify request failed: ${message}`, activeToken));
    sendJson(res, 500, {
      ok: false,
      kind: "error",
      message: "verification could not be completed",
    });
  }
}

// Read the request body with a hard cap. A declared content-length over the cap
// is rejected before any bytes are read; a stream that lies about its length is
// cut off at the cap and drained so the socket is not left stalled.
function readJsonBody(req) {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_VERIFY_BODY_BYTES) {
    return Promise.reject(bodyTooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_VERIFY_BODY_BYTES) {
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        req.resume?.();
        reject(bodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { code: "INVALID_JSON" }));
        return;
      }
      resolve(parsed && typeof parsed === "object" ? parsed : {});
    });
  });
}

function bodyTooLarge() {
  return Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function redact(text, token) {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

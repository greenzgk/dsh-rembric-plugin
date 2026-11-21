// test/verify-route.test.mjs — ticket #17: the settings card's verify route.
//
// Seam (spec #14 seam 1, extended): host wiring under a fake context. The fake
// webServer records route registration, the fake connection service stubs the
// request-rejection check, and a fake fetch stands in for the Rembric server.
// No real network is touched anywhere in this file.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { apply } from "../host.js";
import { registerVerifyRoute } from "../verify-route.js";

const VERIFY_PATH = "/plugins/rembric/verify";

// Fake apply-context with the two services the verify route feature-detects.
// Mirrors makeApplyCtx (credential-store.test.mjs) plus a service registry:
// ctx.get(name) answers from the services map, and effect() actually runs its
// fn so registration is observable.
function makeVerifyCtx({ webServer = true, connection = true, rejection, storedToken } = {}) {
  const registeredRoutes = [];
  const warnings = [];
  const credentialWrites = [];
  const services = {};
  if (webServer) {
    services.webServer = {
      register(route) {
        registeredRoutes.push(route);
        return () => {
          const at = registeredRoutes.indexOf(route);
          if (at !== -1) registeredRoutes.splice(at, 1);
        };
      },
    };
  }
  if (connection) {
    services.connection = { requestRejection: () => rejection };
  }
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    emit: () => {},
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    commands: { register: () => () => {} },
    logger: { warn: (msg) => warnings.push(String(msg)) },
    credentials: {
      resolve: async () => (storedToken ? { value: storedToken, source: "file" } : undefined),
      set: async (ref, value) => {
        credentialWrites.push([ref, value]);
      },
    },
    agents: { list: () => [] },
    workingDirectory: { get: () => undefined },
  };
  return { ctx, registeredRoutes, warnings, credentialWrites };
}

// Minimal IncomingMessage stand-in: method + headers now, body events on the
// next microtask so the handler has time to attach its listeners.
function makeReq({ method = "POST", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

// Minimal ServerResponse stand-in recording what the handler wrote.
function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      return this;
    },
    end(chunk) {
      this.body = chunk ?? "";
      this.ended = true;
    },
  };
}

function verifyRoute(registeredRoutes) {
  return registeredRoutes.find((route) => route.path === VERIFY_PATH);
}

describe("verify route registration", () => {
  it("registers POST /plugins/rembric/verify as an exact route", () => {
    const { ctx, registeredRoutes } = makeVerifyCtx();
    apply(ctx, {});
    const route = verifyRoute(registeredRoutes);
    expect(route).toBeDefined();
    expect(route.kind).toBe("exact");
    expect(typeof route.handler).toBe("function");
  });

  it("does not register when the web server service is absent", () => {
    const { ctx, registeredRoutes } = makeVerifyCtx({ webServer: false });
    expect(() => apply(ctx, {})).not.toThrow();
    expect(verifyRoute(registeredRoutes)).toBeUndefined();
  });

  it("does not register when the connection service is absent", () => {
    const { ctx, registeredRoutes } = makeVerifyCtx({ connection: false });
    expect(() => apply(ctx, {})).not.toThrow();
    expect(verifyRoute(registeredRoutes)).toBeUndefined();
  });
});

describe("verify route authorization", () => {
  async function rejectedRequest(rejection) {
    const { ctx, registeredRoutes } = makeVerifyCtx({ rejection });
    apply(ctx, {});
    const req = makeReq({ body: JSON.stringify({ serverUrl: "http://memory.test" }) });
    const res = makeRes();
    await verifyRoute(registeredRoutes).handler(req, res);
    return res;
  }

  it("answers 401 unauthorized when the connection guard rejects", async () => {
    const res = await rejectedRequest(401);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
  });

  it("answers 403 forbidden when the connection guard rejects", async () => {
    const res = await rejectedRequest(403);
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("forbidden");
  });
});

// --- response shapes ----------------------------------------------------------

function okJson(result) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
  };
}
function httpError(status) {
  return { ok: false, status, headers: { get: () => null }, text: async () => "" };
}

// Fake healthy Rembric MCP server; records every request's url and auth header.
function healthyFetch(seen) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push({ url, auth: opts.headers.Authorization, method: body.method });
    if (body.method === "initialize") {
      return okJson({ protocolVersion: "2025-06-18", serverInfo: { name: "Rembric" } });
    }
    if (body.method === "notifications/initialized") return okJson({});
    if (body.method === "tools/list") {
      return okJson({ tools: [{ name: "memory.search" }, { name: "memory.remember" }] });
    }
    throw new Error("unexpected JSON-RPC method: " + body.method);
  };
}

// Runs one POST through the registered handler with globalThis.fetch stubbed.
async function postVerify(body, ctxOpts = {}, fetchImpl) {
  const { ctx, registeredRoutes, warnings, credentialWrites } = makeVerifyCtx(ctxOpts);
  apply(ctx, {});
  const req = makeReq({ body: typeof body === "string" ? body : JSON.stringify(body) });
  const res = makeRes();
  const prevFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    await verifyRoute(registeredRoutes).handler(req, res);
  } finally {
    globalThis.fetch = prevFetch;
  }
  return {
    res,
    warnings,
    credentialWrites,
    payload: res.body ? JSON.parse(res.body) : null,
  };
}

describe("verify route success", () => {
  it("verifies the stored token when the body carries none", async () => {
    const seen = [];
    const { res, payload } = await postVerify(
      { serverUrl: "http://memory.test" },
      { storedToken: "stored-tok-1" },
      healthyFetch(seen),
    );
    expect(res.statusCode).toBe(200);
    expect(payload).toEqual({
      ok: true,
      serverName: "Rembric",
      toolCount: 2,
      tokenSource: "store",
    });
    expect(seen[0].auth).toBe("Bearer stored-tok-1");
  });

  it("prefers an explicit body token and reports source 'request'", async () => {
    const seen = [];
    const { payload } = await postVerify(
      { serverUrl: "http://memory.test", token: "fresh-tok-2" },
      { storedToken: "stored-tok-1" },
      healthyFetch(seen),
    );
    expect(payload.tokenSource).toBe("request");
    expect(seen[0].auth).toBe("Bearer fresh-tok-2");
  });
});

describe("verify route failure classes", () => {
  const cases = [
    {
      name: "rejected token",
      initialize: () => httpError(401),
      kind: "rejected-token",
      message: "the server rejected the token (HTTP 401)",
    },
    {
      name: "no project access",
      initialize: () => httpError(403),
      kind: "no-project-access",
      message: "the token has no access to this project (HTTP 403)",
    },
    {
      name: "no MCP endpoint",
      initialize: () => httpError(404),
      kind: "no-mcp",
      message: "no MCP endpoint at this address (HTTP 404)",
    },
    {
      name: "timeout",
      initialize: () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
      kind: "timeout",
      message: "the server did not answer in time",
    },
    {
      name: "unreachable host",
      initialize: () => {
        throw new TypeError("fetch failed");
      },
      kind: "unreachable",
      message: "the host could not be reached",
    },
    {
      name: "no token configured anywhere",
      initialize: () => okJson({}),
      kind: "no-token",
      message: "no token is configured",
      noStoredToken: true,
    },
  ];

  for (const c of cases) {
    it("reports " + c.name + " as a classified failure, not a stack trace", async () => {
      const fetchImpl = async (url, opts) => {
        const body = JSON.parse(opts.body);
        return c.initialize(body);
      };
      const { res, payload } = await postVerify(
        { serverUrl: "http://memory.test" },
        c.noStoredToken ? {} : { storedToken: "tok-1" },
        fetchImpl,
      );
      expect(res.statusCode).toBe(200);
      expect(payload).toEqual({ ok: false, kind: c.kind, message: c.message });
    });
  }
});

describe("verify route body size limit", () => {
  async function runRaw({ headers, chunks }) {
    const { ctx, registeredRoutes } = makeVerifyCtx();
    apply(ctx, {});
    const req = new EventEmitter();
    req.method = "POST";
    req.headers = headers;
    const res = makeRes();
    const call = verifyRoute(registeredRoutes).handler(req, res);
    queueMicrotask(() => {
      for (const chunk of chunks) req.emit("data", Buffer.from(chunk));
      req.emit("end");
    });
    await call;
    return res;
  }

  it("rejects a declared content-length over the cap", async () => {
    const res = await runRaw({ headers: { "content-length": String(9 * 1024) }, chunks: [] });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "request body too large" });
  });

  it("cuts off a stream that exceeds the cap without a declared length", async () => {
    const big = "x".repeat(1024);
    const res = await runRaw({ headers: {}, chunks: Array.from({ length: 9 }, () => big) });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "request body too large" });
  });

  it("accepts a small body under the cap", async () => {
    const seen = [];
    const { res } = await postVerify(
      { serverUrl: "http://memory.test" },
      { storedToken: "tok-1" },
      healthyFetch(seen),
    );
    expect(res.statusCode).toBe(200);
  });
});

describe("verify route bad requests", () => {
  it("rejects a non-POST method with 405", async () => {
    const { ctx, registeredRoutes } = makeVerifyCtx();
    apply(ctx, {});
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await verifyRoute(registeredRoutes).handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: "method not allowed" });
  });

  it("rejects a malformed JSON body with 400", async () => {
    const { res } = await postVerify("{not json", {}, healthyFetch([]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid JSON body" });
  });

  it("rejects a missing serverUrl with 400", async () => {
    const { res } = await postVerify({ token: "tok-1" }, {}, healthyFetch([]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "serverUrl is required" });
  });

  it("rejects a blank serverUrl with 400", async () => {
    const { res } = await postVerify({ serverUrl: "   " }, {}, healthyFetch([]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "serverUrl is required" });
  });
});

describe("verify route token secrecy", () => {
  const SECRET = "super-secret-tok-9f3a";

  it("never echoes the token in a success response", async () => {
    const { res } = await postVerify(
      { serverUrl: "http://memory.test" },
      { storedToken: SECRET },
      healthyFetch([]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
  });

  it("redacts the token from diagnostics when the probe throws it into its message", async () => {
    const { ctx, registeredRoutes, warnings } = makeVerifyCtx();
    registerVerifyRoute(ctx, {
      resolveToken: async () => ({ value: SECRET, source: "store" }),
      checkConnection: async () => {
        throw new Error("socket hung up mid-handshake with " + SECRET);
      },
    });
    const req = makeReq({ body: JSON.stringify({ serverUrl: "http://memory.test" }) });
    const res = makeRes();
    await verifyRoute(registeredRoutes).handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      kind: "error",
      message: "verification could not be completed",
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).not.toContain(SECRET);
    expect(warnings[0]).toContain("[redacted]");
  });

  it("keeps the secret out of the log when the token resolver itself throws it", async () => {
    // The resolver fails before the route ever holds the token value, so
    // string-redaction cannot help — the resolver's own message must not
    // reach the warning log at all.
    const { ctx, registeredRoutes, warnings } = makeVerifyCtx();
    registerVerifyRoute(ctx, {
      resolveToken: async () => {
        throw new Error("credential store handed back raw value " + SECRET);
      },
      checkConnection: async () => ({ ok: true, serverName: "Rembric", toolCount: 0 }),
    });
    const req = makeReq({ body: JSON.stringify({ serverUrl: "http://memory.test" }) });
    const res = makeRes();
    await verifyRoute(registeredRoutes).handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).not.toContain(SECRET);
  });

  it("never echoes the token in a failure response", async () => {
    const { res } = await postVerify(
      { serverUrl: "http://memory.test" },
      { storedToken: SECRET },
      async () => httpError(401),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
  });
});

// --- token persistence (ticket #18) -------------------------------------------

describe("verify route token persistence", () => {
  it("stores an explicit token that verifies, under REMBRIC_API_TOKEN", async () => {
    const { credentialWrites } = await postVerify(
      { serverUrl: "http://memory.test", token: "fresh-tok-2" },
      { storedToken: "stored-tok-1" },
      healthyFetch([]),
    );
    expect(credentialWrites).toEqual([["REMBRIC_API_TOKEN", "fresh-tok-2"]]);
  });

  it("never touches the store when the body carries no token", async () => {
    const { credentialWrites } = await postVerify(
      { serverUrl: "http://memory.test" },
      { storedToken: "stored-tok-1" },
      healthyFetch([]),
    );
    expect(credentialWrites).toEqual([]);
  });

  it("does not store an explicit token that fails verification", async () => {
    const { credentialWrites } = await postVerify(
      { serverUrl: "http://memory.test", token: "bad-tok" },
      {},
      async () => httpError(401),
    );
    expect(credentialWrites).toEqual([]);
  });

  it("reports a save failure as a save-failed kind and keeps the secret out of the log", async () => {
    const SECRET = "persist-me-tok-77";
    const { ctx, registeredRoutes, warnings } = makeVerifyCtx();
    registerVerifyRoute(ctx, {
      resolveToken: async () => ({ value: undefined, source: "none" }),
      checkConnection: async () => ({ ok: true, serverName: "Rembric", toolCount: 3 }),
      saveToken: async () => {
        throw new Error("disk on fire while writing " + SECRET);
      },
    });
    const req = makeReq({
      body: JSON.stringify({ serverUrl: "http://memory.test", token: SECRET }),
    });
    const res = makeRes();
    await verifyRoute(registeredRoutes).handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      kind: "save-failed",
      message: "the token could not be saved (the host log has the reason)",
    });
    expect(res.body).not.toContain(SECRET);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("disk on fire");
    expect(warnings[0]).not.toContain(SECRET);
  });

  it("does not echo the explicit token in the success response", async () => {
    const SECRET = "persist-me-tok-77";
    const { res } = await postVerify(
      { serverUrl: "http://memory.test", token: SECRET },
      {},
      healthyFetch([]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
  });
});

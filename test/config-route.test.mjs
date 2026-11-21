// test/config-route.test.mjs — the settings card's server-config route.
//
// Host wiring under a fake context. GET answers the effective server address
// and where the token comes from; POST validates the address, answers, then
// saves it through the harness config editor (which restarts the plugin).
// No real network or config editor is touched.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";

import { apply } from "../host.js";
import { registerConfigRoute } from "../config-route.js";

const CONFIG_PATH = "/plugins/rembric/config";

// Fake apply-context with the services the route requires. Mirrors the
// makeVerifyCtx helper: ctx.inject runs its callback once every named service
// is active, restarts it on a reload, and effect() records the disposer on the
// running fiber.
function makeConfigCtx({
  webServer = true,
  connection = true,
  rejection,
  storedToken,
  configEditor,
} = {}) {
  const registeredRoutes = [];
  const warnings = [];
  const credentialWrites = [];
  let resolveCount = 0;
  const services = {};
  const fibers = [];
  let runningFiber = null;

  const ctx = {
    get: (name) => services[name],
    inject(names, callback) {
      const fiber = { names, callback, disposers: [], running: false };
      fibers.push(fiber);
      startFiber(fiber);
      return {
        dispose() {
          stopFiber(fiber);
        },
      };
    },
    on: () => () => {},
    emit: () => {},
    effect(fn) {
      const disposer = fn();
      if (runningFiber && typeof disposer === "function") runningFiber.disposers.push(disposer);
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    commands: { register: () => () => {} },
    logger: { warn: (msg) => warnings.push(String(msg)) },
    credentials: {
      resolve: async () => {
        resolveCount += 1;
        return storedToken ? { value: storedToken, source: "file" } : undefined;
      },
      set: async (ref, value) => {
        credentialWrites.push([ref, value]);
      },
    },
    agents: { list: () => [] },
    workingDirectory: { get: () => undefined },
    fiber: { entry: { id: "dsh-rembric-plugin" } },
  };

  // The scoped context in cordis exposes injected services as properties.
  for (const name of ["webServer", "connection"]) {
    Object.defineProperty(ctx, name, { get: () => services[name] });
  }

  function startFiber(fiber) {
    if (fiber.running || !fiber.names.every((name) => services[name])) return;
    fiber.running = true;
    runningFiber = fiber;
    try {
      fiber.callback(ctx);
    } finally {
      runningFiber = null;
    }
  }

  function stopFiber(fiber) {
    if (!fiber.running) return;
    fiber.running = false;
    for (const dispose of fiber.disposers.splice(0)) dispose();
  }

  // Adding a service (or replacing one, as a provider reload would) restarts
  // every fiber that names it.
  function activate(name) {
    services[name] =
      name === "webServer"
        ? {
            register(route) {
              registeredRoutes.push(route);
              return () => {
                const at = registeredRoutes.indexOf(route);
                if (at !== -1) registeredRoutes.splice(at, 1);
              };
            },
          }
        : { requestRejection: () => rejection };
    for (const fiber of fibers) {
      if (!fiber.names.includes(name)) continue;
      stopFiber(fiber);
      startFiber(fiber);
    }
  }

  function deactivate(name) {
    delete services[name];
    for (const fiber of fibers) {
      if (fiber.names.includes(name)) stopFiber(fiber);
    }
  }

  if (configEditor !== undefined) services.configEditor = configEditor;
  if (webServer) activate("webServer");
  if (connection) activate("connection");
  return {
    ctx,
    registeredRoutes,
    warnings,
    credentialWrites,
    resolveCount: () => resolveCount,
    activate,
    deactivate,
  };
}

// Minimal IncomingMessage / ServerResponse stand-ins, same shape as the verify
// route tests: body events land on the next microtask.
function makeReq({ method = "GET", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

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

function configRoute(routes) {
  return routes.find((route) => route.path === CONFIG_PATH);
}

function applyHost(options = {}, config = { serverUrl: "http://config.test/" }) {
  const harness = makeConfigCtx(options);
  apply(harness.ctx, config);
  return harness;
}

async function request(registeredRoutes, { method = "GET", headers = {}, body } = {}) {
  const req = makeReq({ method, headers, body });
  const res = makeRes();
  await configRoute(registeredRoutes).handler(req, res);
  return res;
}

function payload(res) {
  return res.body ? JSON.parse(res.body) : null;
}

describe("config route registration", () => {
  it("registers GET and POST /plugins/rembric/config as an exact route", () => {
    const { registeredRoutes } = applyHost();
    const routes = registeredRoutes.filter((route) => route.path === CONFIG_PATH);
    expect(routes).toHaveLength(1);
    expect(routes[0].kind).toBe("exact");
    expect(typeof routes[0].handler).toBe("function");
  });

  it("does not register when the web server service is absent", () => {
    const { registeredRoutes } = applyHost({ webServer: false });
    expect(configRoute(registeredRoutes)).toBeUndefined();
  });

  it("does not register when the connection service is absent", () => {
    const { registeredRoutes } = applyHost({ connection: false });
    expect(configRoute(registeredRoutes)).toBeUndefined();
  });

  it("registers when both services become active after apply", () => {
    const harness = applyHost({ webServer: false, connection: false });
    expect(configRoute(harness.registeredRoutes)).toBeUndefined();

    harness.activate("webServer");
    expect(configRoute(harness.registeredRoutes)).toBeUndefined();

    harness.activate("connection");
    expect(configRoute(harness.registeredRoutes)).toBeDefined();
  });

  it("unregisters the route when an injected service goes away", () => {
    const harness = applyHost();
    expect(configRoute(harness.registeredRoutes)).toBeDefined();

    harness.deactivate("connection");
    expect(configRoute(harness.registeredRoutes)).toBeUndefined();
  });

  it("keeps exactly one route when a service reloads", () => {
    const harness = applyHost();
    harness.activate("webServer");
    expect(harness.registeredRoutes.filter((route) => route.path === CONFIG_PATH)).toHaveLength(1);
  });
});

describe("GET /plugins/rembric/config", () => {
  it("answers the effective address and a stored token", async () => {
    const harness = applyHost({ storedToken: "tok-1" });
    const res = await request(harness.registeredRoutes);
    expect(res.statusCode).toBe(200);
    expect(payload(res)).toEqual({
      serverUrl: "http://config.test",
      tokenSource: "store",
      hasToken: true,
    });
    // Reading the config never writes a credential.
    expect(harness.credentialWrites).toEqual([]);
  });

  it("reports an ambient token as env", async () => {
    const harness = makeConfigCtx();
    registerConfigRoute(harness.ctx, {
      serverInfo: () => ({ url: "http://env.test:8790", origin: "env" }),
      resolveToken: async () => ({ value: "tok-2", source: "env" }),
    });
    const res = await request(harness.registeredRoutes);
    expect(payload(res)).toEqual({
      serverUrl: "http://env.test:8790",
      tokenSource: "env",
      hasToken: true,
    });
  });

  it("answers the default address and no token when neither is configured", async () => {
    const harness = applyHost({}, {});
    const res = await request(harness.registeredRoutes);
    expect(payload(res)).toEqual({
      serverUrl: "http://127.0.0.1:8790",
      tokenSource: "none",
      hasToken: false,
    });
  });

  it("treats an unknown token source as none", async () => {
    const harness = makeConfigCtx();
    registerConfigRoute(harness.ctx, {
      serverInfo: () => ({ url: "http://config.test", origin: "config" }),
      resolveToken: async () => ({ value: "tok-3", source: "mystery" }),
    });
    const res = await request(harness.registeredRoutes);
    expect(payload(res)).toEqual({
      serverUrl: "http://config.test",
      tokenSource: "none",
      hasToken: true,
    });
  });
});

describe("config route authorization", () => {
  for (const rejection of [401, 403]) {
    it("answers " + rejection + " before reading the request", async () => {
      const harness = applyHost({ rejection });
      const res = await request(harness.registeredRoutes, {
        method: "GET",
      });
      expect(res.statusCode).toBe(rejection);
      expect(res.body).toBe(rejection === 401 ? "unauthorized" : "forbidden");
    });
  }
});

describe("config route methods", () => {
  it("answers 405 for a method that is neither GET nor POST", async () => {
    const harness = applyHost();
    const res = await request(harness.registeredRoutes, { method: "PUT" });
    expect(res.statusCode).toBe(405);
    expect(payload(res)).toEqual({ error: "method not allowed" });
  });
});

describe("POST /plugins/rembric/config", () => {
  it("saves the normalized address through the config editor after answering", async () => {
    const events = [];
    const edits = [];
    const configEditor = {
      async edit(entry, change) {
        edits.push({
          entry,
          next: change({ serverUrl: "http://old.test", keep: true }, { inherited: 1 }),
          respondedBeforeEdit: events.includes("responded"),
        });
      },
    };
    const harness = applyHost({ configEditor });
    const res = makeRes();
    const end = res.end.bind(res);
    res.end = (chunk) => {
      events.push("responded");
      end(chunk);
    };
    await configRoute(harness.registeredRoutes).handler(
      makeReq({
        method: "POST",
        body: JSON.stringify({ serverUrl: " http://new.test:8790/// " }),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(payload(res)).toEqual({ ok: true, serverUrl: "http://new.test:8790" });
    expect(edits).toHaveLength(1);
    expect(edits[0].entry).toBe(harness.ctx.fiber.entry);
    expect(edits[0].next).toEqual({ keep: true, serverUrl: "http://new.test:8790" });
    // The response (and the restart it triggers) must not wait for the edit.
    expect(edits[0].respondedBeforeEdit).toBe(true);
    // Saving the address leaves the token alone.
    expect(harness.credentialWrites).toEqual([]);
    expect(harness.resolveCount()).toBe(0);
  });

  it("answers 501 when the config editor service is absent", async () => {
    const harness = applyHost();
    const res = await request(harness.registeredRoutes, {
      method: "POST",
      body: JSON.stringify({ serverUrl: "http://new.test:8790" }),
    });
    expect(res.statusCode).toBe(501);
    expect(payload(res).error).toMatch(/configuration editor/i);
  });

  it("answers 501 before reading or validating the body when the config editor is absent", async () => {
    const harness = applyHost();
    for (const body of ["{", JSON.stringify({ serverUrl: "not a url" })]) {
      const res = await request(harness.registeredRoutes, { method: "POST", body });
      expect(res.statusCode).toBe(501);
      expect(payload(res).error).toMatch(/configuration editor/i);
    }
  });

  it("answers 400 for a blank address and saves nothing", async () => {
    const edits = [];
    const configEditor = {
      async edit(entry, change) {
        edits.push({ entry, next: change({}, {}) });
      },
    };
    const harness = applyHost({ configEditor });
    const res = await request(harness.registeredRoutes, {
      method: "POST",
      body: JSON.stringify({ serverUrl: "   " }),
    });
    expect(res.statusCode).toBe(400);
    expect(payload(res)).toEqual({ error: "serverUrl is required" });
    expect(edits).toEqual([]);
  });

  it("answers 400 for a non-http address and saves nothing", async () => {
    const edits = [];
    const configEditor = {
      async edit(entry, change) {
        edits.push({ entry, next: change({}, {}) });
      },
    };
    const harness = applyHost({ configEditor });
    for (const serverUrl of ["not a url", "ftp://memory.test", "http://"]) {
      const res = await request(harness.registeredRoutes, {
        method: "POST",
        body: JSON.stringify({ serverUrl }),
      });
      expect(res.statusCode).toBe(400);
      expect(payload(res).error).toMatch(/http\(s\) URL/i);
    }
    expect(edits).toEqual([]);
  });

  it("answers 400 for malformed JSON and saves nothing", async () => {
    const edits = [];
    const configEditor = {
      async edit(entry, change) {
        edits.push({ entry, next: change({}, {}) });
      },
    };
    const harness = applyHost({ configEditor });
    const res = await request(harness.registeredRoutes, { method: "POST", body: "{" });
    expect(res.statusCode).toBe(400);
    expect(payload(res)).toEqual({ error: "invalid JSON body" });
    expect(edits).toEqual([]);
  });

  it("answers 413 when the declared body is too large and saves nothing", async () => {
    const edits = [];
    const configEditor = {
      async edit(entry, change) {
        edits.push({ entry, next: change({}, {}) });
      },
    };
    const harness = applyHost({ configEditor });
    const res = await request(harness.registeredRoutes, {
      method: "POST",
      headers: { "content-length": String(9 * 1024) },
      body: JSON.stringify({ serverUrl: "http://new.test:8790" }),
    });
    expect(res.statusCode).toBe(413);
    expect(payload(res)).toEqual({ error: "request body too large" });
    expect(edits).toEqual([]);
  });

  it("keeps the success response when the editor rejects after answering", async () => {
    const configEditor = {
      async edit() {
        throw new Error("Configuration entry is no longer available");
      },
    };
    const harness = applyHost({ configEditor });
    const res = await request(harness.registeredRoutes, {
      method: "POST",
      body: JSON.stringify({ serverUrl: "http://new.test:8790" }),
    });
    expect(res.statusCode).toBe(200);
    expect(payload(res)).toEqual({ ok: true, serverUrl: "http://new.test:8790" });
    expect(harness.warnings.join("\n")).toContain("Configuration entry is no longer available");
    expect(harness.warnings.join("\n")).toContain("rembric:");
  });
});

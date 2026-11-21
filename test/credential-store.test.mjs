// test/credential-store.test.mjs — token from the credential store.
//
// Covers the host-side behavior:
//   [A]/[B] pure config helpers (config-field read incl. Volatile unwrap, URL precedence)
//   [C]     connection-failure classification (pure)
//   [D]     connection check with a fake transport
//   [E]     token resolution through a fake ctx (store > env > none)
//   [F]/[G] /rembric-login and /rembric-status command behavior via fake ctx
//
// Expected values are literals, never recomputed by the code under test.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vite-plus/test";

import {
  readConfigValue,
  resolveServerUrl,
  classifyConnectionFailure,
  checkConnection,
  resolveToken,
} from "../host.js";
import { apply } from "../host.js";
import { registerRembricCommands } from "../commands.js";

// ============================================================================
// [A] Config-field read: plain value or Volatile wrapper
// ============================================================================
describe("[A] config-field read", () => {
  it("returns a plain string unchanged", () => {
    expect(readConfigValue("http://cfg:1")).toBe("http://cfg:1");
  });

  it("unwraps a Volatile wrapper through .get()", () => {
    expect(readConfigValue({ get: () => "http://live:9" })).toBe("http://live:9");
  });

  it("returns undefined for a missing field", () => {
    expect(readConfigValue(undefined)).toBeUndefined();
  });
});

// ============================================================================
// [B] Effective server URL: config > REMBRIC_SERVER_URL > local default
// ============================================================================
describe("[B] server URL precedence", () => {
  it("config wins over env and default", () => {
    expect(
      resolveServerUrl({ serverUrl: "http://cfg:1" }, { REMBRIC_SERVER_URL: "http://env:2" }),
    ).toEqual({ url: "http://cfg:1", origin: "config" });
  });

  it("volatile config field is read live on every call", () => {
    let current = "http://live:1";
    const config = { serverUrl: { get: () => current } };
    expect(resolveServerUrl(config, {})).toEqual({ url: "http://live:1", origin: "config" });
    current = "http://live:2";
    expect(resolveServerUrl(config, {})).toEqual({ url: "http://live:2", origin: "config" });
  });

  it("blank config falls through to REMBRIC_SERVER_URL", () => {
    expect(resolveServerUrl({ serverUrl: "   " }, { REMBRIC_SERVER_URL: "http://env:2" })).toEqual({
      url: "http://env:2",
      origin: "env",
    });
  });

  it("falls through to the local default when nothing is set", () => {
    expect(resolveServerUrl({}, {})).toEqual({ url: "http://127.0.0.1:8790", origin: "default" });
    // Explicit empty env: passing undefined would fall back to the real
    // process.env, making the test environment-dependent.
    expect(resolveServerUrl(undefined, {})).toEqual({
      url: "http://127.0.0.1:8790",
      origin: "default",
    });
  });

  it("strips trailing slashes from the effective URL", () => {
    expect(resolveServerUrl({ serverUrl: "http://cfg:1///" }, {})).toEqual({
      url: "http://cfg:1",
      origin: "config",
    });
    expect(resolveServerUrl({}, { REMBRIC_SERVER_URL: "http://env:2/" })).toEqual({
      url: "http://env:2",
      origin: "env",
    });
  });
});
// ============================================================================
// [C] Connection-failure classification (pure)
// ============================================================================
describe("[C] failure classification", () => {
  it("401 → the server rejected the token", () => {
    const err = Object.assign(new Error("Rembric MCP request failed: HTTP 401"), { status: 401 });
    expect(classifyConnectionFailure(err)).toEqual({
      kind: "rejected-token",
      message: "the server rejected the token (HTTP 401)",
    });
  });

  it("403 → no access to this project", () => {
    const err = Object.assign(new Error("Rembric MCP request failed: HTTP 403"), { status: 403 });
    expect(classifyConnectionFailure(err)).toEqual({
      kind: "no-project-access",
      message: "the token has no access to this project (HTTP 403)",
    });
  });

  it("404 → no MCP endpoint at this address", () => {
    const err = Object.assign(new Error("Rembric MCP request failed: HTTP 404"), { status: 404 });
    expect(classifyConnectionFailure(err)).toEqual({
      kind: "no-mcp",
      message: "no MCP endpoint at this address (HTTP 404)",
    });
  });

  it("TimeoutError → did not answer in time", () => {
    const err = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    expect(classifyConnectionFailure(err)).toEqual({
      kind: "timeout",
      message: "the server did not answer in time",
    });
  });

  it("AbortError from a deadline → timeout", () => {
    const err = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(classifyConnectionFailure(err)).toEqual({
      kind: "timeout",
      message: "the server did not answer in time",
    });
  });

  it("anything else → host unreachable", () => {
    const err = new TypeError("fetch failed");
    expect(classifyConnectionFailure(err)).toEqual({
      kind: "unreachable",
      message: "the host could not be reached",
    });
  });

  it("non-Error thrown values still classify", () => {
    expect(classifyConnectionFailure("boom").kind).toBe("unreachable");
  });
});
// ============================================================================
// [D] Connection check with a fake transport
// ============================================================================
describe("[D] checkConnection with fake transport", () => {
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
  function makeFetch(handlers) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, auth: opts.headers.Authorization, method: body.method });
      const handler = handlers[body.method];
      if (!handler) throw new Error(`unexpected JSON-RPC method: ${body.method}`);
      return handler(body);
    };
    return { calls, fetchImpl };
  }
  const healthyHandlers = {
    initialize: () => okJson({ protocolVersion: "2025-06-18", serverInfo: { name: "Rembric" } }),
    "notifications/initialized": () => okJson({}),
    "tools/list": () => okJson({ tools: [{ name: "memory.search" }, { name: "memory.remember" }] }),
  };

  it("accepts a working token and reports the tool count", async () => {
    const { calls, fetchImpl } = makeFetch(healthyHandlers);
    const result = await checkConnection({ serverUrl: "http://s:1", token: "tok-1", fetchImpl });
    expect(result).toEqual({ ok: true, toolCount: 2, serverName: "Rembric" });
    expect(calls[0].url).toBe("http://s:1/mcp");
    expect(calls[0].auth).toBe("Bearer tok-1");
  });

  it("probes the slug-scoped endpoint when a slug is given", async () => {
    const { calls, fetchImpl } = makeFetch(healthyHandlers);
    const result = await checkConnection({
      serverUrl: "http://s:1",
      token: "tok-1",
      slug: "proj-a",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("http://s:1/mcp/proj-a");
  });

  it("401 → rejected-token", async () => {
    const { fetchImpl } = makeFetch({
      initialize: () => httpError(401),
      "notifications/initialized": () => okJson({}),
    });
    const result = await checkConnection({ serverUrl: "http://s:1", token: "bad", fetchImpl });
    expect(result).toEqual({
      ok: false,
      kind: "rejected-token",
      message: "the server rejected the token (HTTP 401)",
    });
  });

  it("403 → no-project-access", async () => {
    const { fetchImpl } = makeFetch({
      initialize: () => okJson({ protocolVersion: "2025-06-18" }),
      "notifications/initialized": () => okJson({}),
      "tools/list": () => httpError(403),
    });
    const result = await checkConnection({
      serverUrl: "http://s:1",
      token: "t",
      slug: "p",
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      kind: "no-project-access",
      message: "the token has no access to this project (HTTP 403)",
    });
  });

  it("404 → no-mcp", async () => {
    const { fetchImpl } = makeFetch({ initialize: () => httpError(404) });
    const result = await checkConnection({ serverUrl: "http://s:1", token: "t", fetchImpl });
    expect(result).toEqual({
      ok: false,
      kind: "no-mcp",
      message: "no MCP endpoint at this address (HTTP 404)",
    });
  });

  it("hanging server → timeout", async () => {
    const fetchImpl = (url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          reject(opts.signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const result = await checkConnection({
      serverUrl: "http://s:1",
      token: "t",
      fetchImpl,
      timeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("timeout");
    expect(result.message).toBe("the server did not answer in time");
  });

  it("connection refused → unreachable", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await checkConnection({ serverUrl: "http://s:1", token: "t", fetchImpl });
    expect(result).toEqual({
      ok: false,
      kind: "unreachable",
      message: "the host could not be reached",
    });
  });

  it("missing token → no-token, no request made", async () => {
    const { calls, fetchImpl } = makeFetch({});
    const result = await checkConnection({ serverUrl: "http://s:1", token: null, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("no-token");
    expect(calls.length).toBe(0);
  });
});
// ============================================================================
// [E] Token resolution via fake ctx: store > env > none
// ============================================================================
describe("[E] resolveToken (credential reference REMBRIC_API_TOKEN)", () => {
  function ctxWith(resolveImpl) {
    return { credentials: { resolve: resolveImpl } };
  }

  it("an unknown provider source is treated as the store, not as the environment", async () => {
    // The plugin names only the ambient layers ("env", "project-env",
    // "user-env"); anything else the provider reports — "file" today, a
    // future "keychain" — is the provider's own store.
    const ctx = ctxWith(async () => ({ value: "vault-token", source: "keychain" }));
    expect(await resolveToken(ctx, { REMBRIC_API_TOKEN: "ambient-token" })).toEqual({
      value: "vault-token",
      source: "store",
    });
  });

  it("store value wins over the ambient variable", async () => {
    const ctx = ctxWith(async () => ({ value: "stored-token", source: "file" }));
    expect(await resolveToken(ctx, { REMBRIC_API_TOKEN: "ambient-token" })).toEqual({
      value: "stored-token",
      source: "store",
    });
  });

  it("provider 'env' source maps to 'env'", async () => {
    const ctx = ctxWith(async () => ({ value: "from-env", source: "env" }));
    expect(await resolveToken(ctx, {})).toEqual({ value: "from-env", source: "env" });
  });

  it("dotenv layers map to 'env' (ambient, not the store)", async () => {
    const ctx = ctxWith(async () => ({ value: "dotenv", source: "project-env" }));
    expect(await resolveToken(ctx, {})).toEqual({ value: "dotenv", source: "env" });
  });

  it("provider miss falls back to the ambient variable", async () => {
    const ctx = ctxWith(async () => undefined);
    expect(await resolveToken(ctx, { REMBRIC_API_TOKEN: "ambient-token" })).toEqual({
      value: "ambient-token",
      source: "env",
    });
  });

  it("empty stored value counts as absent", async () => {
    const ctx = ctxWith(async () => ({ value: "", source: "file" }));
    expect(await resolveToken(ctx, {})).toEqual({ value: null, source: "none" });
  });

  it("whitespace-only stored value counts as absent", async () => {
    const ctx = ctxWith(async () => ({ value: "   ", source: "file" }));
    expect(await resolveToken(ctx, {})).toEqual({ value: null, source: "none" });
  });

  it("empty ambient variable counts as absent", async () => {
    const ctx = ctxWith(async () => undefined);
    expect(await resolveToken(ctx, { REMBRIC_API_TOKEN: "  " })).toEqual({
      value: null,
      source: "none",
    });
  });

  it("nothing set anywhere → none", async () => {
    const ctx = ctxWith(async () => undefined);
    expect(await resolveToken(ctx, {})).toEqual({ value: null, source: "none" });
  });

  it("provider failure is treated as absent, not a crash", async () => {
    const ctx = ctxWith(async () => {
      throw new Error("provider exploded");
    });
    expect(await resolveToken(ctx, {})).toEqual({ value: null, source: "none" });
  });

  it("resolution never writes to the environment", async () => {
    const before = { ...process.env };
    const ctx = ctxWith(async () => ({ value: "stored-token", source: "file" }));
    await resolveToken(ctx, {});
    expect(process.env).toEqual(before);
  });
});
// ============================================================================
// [F] /rembric-login — save the credential reference, verify before success
// ============================================================================
describe("[F] /rembric-login", () => {
  function setup({ check = { ok: true, toolCount: 3 }, saveThrows = null } = {}) {
    const calls = { save: [], check: [] };
    const warned = [];
    const deps = {
      saveToken: async (t) => {
        if (saveThrows) throw saveThrows;
        calls.save.push(t);
      },
      checkConnection: async (opts) => {
        calls.check.push(opts);
        return check;
      },
      serverInfo: () => ({ url: "http://s:1", origin: "config" }),
      warnOnce: (message) => warned.push(message),
    };
    const registered = new Map();
    const ctx = {
      commands: {
        register: (def) => {
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
    };
    registerRembricCommands(ctx, deps);
    return { calls, warned, login: registered.get("rembric-login") };
  }

  it("is registered with input hint <token> and recordInput:false", () => {
    const { login } = setup();
    expect(login).toBeTruthy();
    expect(login.input).toEqual({ hint: "<token>" });
    expect(login.recordInput).toBe(false);
  });

  it("rejects empty input without saving", async () => {
    const { calls, login } = setup();
    const res = await login.handler({ rawInput: "   " });
    expect(res.kind).toBe("error");
    expect(res.text).toContain("usage");
    expect(calls.save.length).toBe(0);
    expect(calls.check.length).toBe(0);
  });

  it("saves the trimmed token and verifies it at the server before reporting success", async () => {
    const { calls, login } = setup();
    const res = await login.handler({ rawInput: "  tok-42  " });
    expect(calls.save).toEqual(["tok-42"]);
    expect(calls.check.length).toBe(1);
    expect(calls.check[0].token).toBe("tok-42");
    expect(calls.check[0].serverUrl).toBe("http://s:1");
    expect(res.kind).toBe("success");
  });

  it("never echoes the token in the reply", async () => {
    const { login } = setup();
    const ok = await login.handler({ rawInput: "tok-42" });
    const bad = await login.handler({ rawInput: "tok-42" });
    expect(ok.text).not.toContain("tok-42");
    expect(bad.text).not.toContain("tok-42");
  });

  it("failed check → error carrying the classifier message; token stays saved", async () => {
    const { calls, login } = setup({
      check: {
        ok: false,
        kind: "rejected-token",
        message: "the server rejected the token (HTTP 401)",
      },
    });
    const res = await login.handler({ rawInput: "tok-42" });
    expect(res.kind).toBe("error");
    expect(res.text).toContain("the server rejected the token (HTTP 401)");
    expect(calls.save).toEqual(["tok-42"]);
  });

  it("save failure → generic error with no raw-error echo, logged instead, no check attempted", async () => {
    // A provider error could embed the submitted value, so the chat reply
    // stays generic; the real reason goes to the host log via warnOnce.
    const { calls, login, warned } = setup({ saveThrows: new Error("vault rejected tok-42") });
    const res = await login.handler({ rawInput: "tok-42" });
    expect(res.kind).toBe("error");
    expect(res.text).toContain("could not save the token");
    expect(res.text).not.toContain("tok-42");
    expect(warned.some((m) => m.includes("vault rejected tok-42"))).toBe(true);
    expect(calls.check.length).toBe(0);
  });
});
// ============================================================================
// [G] /rembric-status — honest status readout, no connection attempt
// ============================================================================
describe("[G] /rembric-status", () => {
  function setupStatus({
    token = { value: "tok", source: "store" },
    server = { url: "http://s:1", origin: "config" },
    state = null,
  } = {}) {
    const calls = { check: [] };
    const deps = {
      resolveToken: async () => token,
      serverInfo: () => server,
      getStateForAgent: () => state,
      checkConnection: async (opts) => {
        calls.check.push(opts);
        return { ok: true, toolCount: 99 };
      },
      warnOnce: () => {},
    };
    const registered = new Map();
    const ctx = {
      commands: {
        register: (def) => {
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
    };
    registerRembricCommands(ctx, deps);
    return { calls, status: registered.get("rembric-status") };
  }

  it("is registered", () => {
    const { status } = setupStatus();
    expect(status).toBeTruthy();
  });

  it("reports the token source: store", async () => {
    const { status } = setupStatus({ token: { value: "tok", source: "store" } });
    const res = await status.handler({ agent: {} });
    expect(res.kind).toBe("success");
    expect(res.text).toContain("Token: store");
  });

  it("reports the token source: env", async () => {
    const { status } = setupStatus({ token: { value: "tok", source: "env" } });
    const res = await status.handler({ agent: {} });
    expect(res.text).toContain("Token: env");
  });

  it("missing token is reported as absence, not a connection error, and makes no connection attempt", async () => {
    const { calls, status } = setupStatus({ token: { value: null, source: "none" } });
    const res = await status.handler({ agent: {} });
    expect(res.kind).toBe("success");
    expect(res.text).toContain("Token: none");
    expect(res.text).toContain("/rembric-login <token>");
    expect(calls.check.length).toBe(0);
  });

  it("reports the effective server URL and where it came from", async () => {
    const a = setupStatus({ server: { url: "http://a:1", origin: "config" } });
    expect((await a.status.handler({ agent: {} })).text).toContain("Server: http://a:1 (config)");
    const b = setupStatus({ server: { url: "http://b:2", origin: "env" } });
    expect((await b.status.handler({ agent: {} })).text).toContain(
      "Server: http://b:2 (REMBRIC_SERVER_URL)",
    );
    const c = setupStatus({ server: { url: "http://c:3", origin: "default" } });
    expect((await c.status.handler({ agent: {} })).text).toContain("Server: http://c:3 (default)");
  });

  it("reports resolved slug with its resolution method, mode, and tool count", async () => {
    const { status } = setupStatus({
      state: { slug: "proj-a", slugSource: "rembric", mode: "project", toolCount: 5 },
    });
    const res = await status.handler({ agent: {} });
    expect(res.text).toContain("Project: proj-a (.rembric file)");
    expect(res.text).toContain("Mode: on (project)");
    expect(res.text).toContain("Tools: 5");
  });

  it("labels slug sources: env and fingerprint", async () => {
    const a = setupStatus({
      state: { slug: "p", slugSource: "env", mode: "project", toolCount: 1 },
    });
    expect((await a.status.handler({ agent: {} })).text).toContain(
      "Project: p (REMBRIC_PROJECT_SLUG)",
    );
    const b = setupStatus({
      state: { slug: "p", slugSource: "fingerprint", mode: "project", toolCount: 1 },
    });
    expect((await b.status.handler({ agent: {} })).text).toContain(
      "Project: p (repository binding)",
    );
  });

  it("no session state → honest off lines", async () => {
    const { status } = setupStatus({ state: null });
    const res = await status.handler({ agent: {} });
    expect(res.text).toContain("Mode: off");
    expect(res.text).toContain("Tools: 0");
    expect(res.text).toContain("Project: not resolved for this session");
  });
});
// ============================================================================
// [H] apply() wires the credential commands end-to-end (real host phase3)
// ============================================================================
describe("[H] apply() wires credential commands end-to-end", () => {
  const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  function makeApplyCtx({ resolveImpl, setCalls = [] } = {}) {
    const registered = new Map();
    const warnings = [];
    const handlers = new Map();
    const ctx = {
      handlers,
      on(name, fn) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
        return () => {};
      },
      emit(name, ...args) {
        // oxlint-disable-next-line unicorn/no-useless-spread -- defensive copy: iteration stays safe if a handler mutates the handler list during emit
        for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
      },
      effect() {
        return () => {};
      },
      commands: {
        register: (def) => {
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
      logger: { warn: (m) => warnings.push(String(m)) },
      credentials: {
        resolve: resolveImpl ?? (async () => undefined),
        set: async (ref, value) => {
          setCalls.push({ ref, value });
        },
      },
      agents: { list: () => [] },
      workingDirectory: { get: () => undefined },
      // No harness services in this fake: the verify route feature-detects and
      // stays unregistered, which is the Electron/trimmed-build case.
      get: () => undefined,
    };
    return { ctx, registered, warnings, setCalls };
  }

  function makeFakeAgent(sid) {
    return {
      id: sid,
      session: { id: sid, header: {} },
      ctx: {
        inject: (_names, fn) => {
          fn({
            tools: { register: () => {} },
            systemPrompt: { section: () => {} },
          });
          return { dispose: () => {} };
        },
      },
    };
  }

  function healthyFetch(seen) {
    return async (url, opts) => {
      const body = JSON.parse(opts.body);
      seen.push({ url, auth: opts.headers.Authorization, method: body.method });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : body.method === "tools/list"
            ? { tools: [{ name: "memory.search" }, { name: "memory.remember" }] }
            : {};
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      };
    };
  }

  async function statusText(registered, agent, want, ms = 2000) {
    const t0 = Date.now();
    let text = "";
    while (Date.now() - t0 < ms) {
      const res = await registered.get("rembric-status").handler({ agent });
      text = res.text;
      if (text.includes(want)) return text;
      await settle(10);
    }
    return text;
  }

  it("registers /rembric-login and /rembric-status through apply()", () => {
    const { ctx, registered } = makeApplyCtx();
    apply(ctx, {});
    expect(registered.has("rembric-login")).toBe(true);
    expect(registered.has("rembric-status")).toBe(true);
  });

  it("status through apply() reads the token from the credential store", async () => {
    const { ctx, registered } = makeApplyCtx({
      resolveImpl: async () => ({ value: "v", source: "file" }),
    });
    apply(ctx, {});
    const res = await registered.get("rembric-status").handler({ agent: {} });
    expect(res.text).toContain("Token: store");
  });

  it("status through apply() reports the volatile config URL as the effective server", async () => {
    const { ctx, registered } = makeApplyCtx();
    apply(ctx, { serverUrl: { get: () => "http://cfg:9" } });
    const res = await registered.get("rembric-status").handler({ agent: {} });
    expect(res.text).toContain("Server: http://cfg:9 (config)");
  });

  it("login through apply() stores under REMBRIC_API_TOKEN and verifies before success", async () => {
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = healthyFetch(seen);
    try {
      const { ctx, registered, setCalls } = makeApplyCtx();
      apply(ctx, { serverUrl: "http://login-test:1" });
      const res = await registered.get("rembric-login").handler({ rawInput: "tok-9", agent: {} });
      expect(setCalls).toEqual([{ ref: "REMBRIC_API_TOKEN", value: "tok-9" }]);
      expect(seen.some((c) => c.method === "initialize" && c.auth === "Bearer tok-9")).toBe(true);
      expect(res.kind).toBe("success");
      expect(res.text).not.toContain("tok-9");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("config.projectSlug no longer pins the project (injection removed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rembric-t15-"));
    const realFetch = globalThis.fetch;
    globalThis.fetch = healthyFetch([]);
    try {
      const { ctx, registered } = makeApplyCtx({
        resolveImpl: async () => ({ value: "tok", source: "store" }),
      });
      ctx.workingDirectory = { get: () => dir };
      apply(ctx, { serverUrl: "http://slug-test:1", projectSlug: "cfg-slug" });
      const agent = makeFakeAgent("s-slug");
      ctx.emit("agent/created", { agent });
      const text = await statusText(registered, agent, "Mode: on");
      expect(text).toContain("Mode: on (default)");
      expect(text).toContain("Project: not resolved for this session");
      expect(text).toContain("Tools: 2");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

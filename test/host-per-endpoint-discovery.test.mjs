// test/host-per-endpoint-discovery.test.mjs — T4 (spec #26): discovery belongs to
// the session's resolved project. Tools and crib-sheet are fetched from the
// session's own project endpoint, cached per endpoint and shared by sessions that
// resolve to the same project; the global default-project discovery and its failure
// cooldown are gone, so no request ever targets the bare /mcp endpoint.
//
// Seam (spec #26 Testing Decisions §2): the plugin entry point apply() driven by a
// fake harness ctx with a spy on globalThis.fetch that records every request the
// plugin actually makes. Prior art: test/host-fail-closed.test.mjs.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

// host.js keeps the per-endpoint discovery cache at module scope; without a fresh
// module per test, the first test's warm cache would hide every later test's requests.
let apply;

beforeEach(async () => {
  vi.resetModules();
  ({ apply } = await import("../host.js"));
});

const SERVER_URL = "http://rembric.test";
const ALPHA = `${SERVER_URL}/mcp/alpha`;
const BETA = `${SERVER_URL}/mcp/beta`;
const BARE = `${SERVER_URL}/mcp`;

let seq = 0;
const created = [];

function tempSlugDir(slug) {
  const dir = mkdtempSync(join(tmpdir(), "rembric-disc-"));
  writeFileSync(join(dir, ".rembric"), `PROJECT_SLUG=${slug}\n`);
  created.push(dir);
  return dir;
}

function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "-C", dir, ...args],
    { encoding: "utf8" },
  ).trim();
}

// A real single-commit git repo: resolution inside it posts /api/repositories/resolve,
// which the spy answers as bound — so the session gets the repository fingerprint
// header, unlike the non-git .rembric dirs above.
function gitRepoDir() {
  const dir = mkdtempSync(join(tmpdir(), "rembric-disc-git-"));
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  created.push(dir);
  return dir;
}

// ---- fake harness ctx --------------------------------------------------------
// Handlers are captured so the test can fire "agent/created" itself; emit awaits
// the async setupAgent, so assertions run after the session finished resolving
// and discovering — no polling needed.

function makeApplyCtx(tokenValue = "tok") {
  const handlers = new Map();
  const registered = new Map();
  const warnings = [];
  const dirs = new Map(); // session id -> working directory
  const ctx = {
    get: () => undefined,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((f) => f !== fn),
        );
    },
    async emit(name, ...args) {
      // oxlint-disable-next-line unicorn/no-useless-spread -- defensive copy: iteration stays safe if a handler mutates the handler list during emit
      for (const fn of [...(handlers.get(name) ?? [])]) await fn(...args);
    },
    effect: () => () => {},
    inject: () => ({ dispose: () => {} }),
    logger: { warn: (m) => warnings.push(String(m)) },
    credentials: {
      resolve: async () => (tokenValue ? { value: tokenValue, source: "store" } : undefined),
      set: async () => {},
    },
    agents: { list: () => [] },
    workingDirectory: { get: (session) => dirs.get(String(session?.id)) ?? process.cwd() },
    commands: {
      register: (def) => {
        registered.set(def.name, def);
        return () => registered.delete(def.name);
      },
    },
  };
  return { ctx, registered, warnings, dirs };
}

// Agent whose own ctx.inject records everything registered on it.
function makeRecordingAgent() {
  const id = `s-${++seq}`;
  const injected = { tools: [], sections: [] };
  const agent = {
    id,
    session: { id, header: {} },
    ctx: {
      inject: (_names, fn) => {
        fn({
          tools: { register: (def) => injected.tools.push(def) },
          systemPrompt: { section: (s) => injected.sections.push(s) },
        });
        return { dispose: () => {} };
      },
    },
  };
  return { agent, injected };
}

// ---- stubbed MCP transport ----------------------------------------------------
// routes: pathname -> { tools, instructions }. Every request (url, method, called
// tool name) is recorded. failNext() forces the next N matching requests to answer
// HTTP 401, simulating a failing endpoint.

function makeFetchSpy(routes, { resolvePayload } = {}) {
  const calls = [];
  const failures = new Map(); // `${pathname} ${method}` -> remaining forced failures
  let sidSeq = 0;
  const fetchSpy = async (url, opts = {}) => {
    const urlStr = String(url);
    const pathname = new URL(urlStr).pathname;
    const body = opts.body ? JSON.parse(opts.body) : {};
    const method = body.method ?? null;
    // Request headers are recorded too: tests assert the mcp-session-id echo and
    // the per-session X-Rembric-Repo-Fingerprint header.
    const headers = Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const call = { url: urlStr, pathname, method, name: body.params?.name ?? null, headers };
    calls.push(call);
    if (pathname === "/api/repositories/resolve") {
      const payload = resolvePayload ?? { ok: true, outcome: "unbound", reason: "not_bound" };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }
    const failKey = `${pathname} ${method}`;
    if ((failures.get(failKey) ?? 0) > 0 && routes[pathname]) {
      failures.set(failKey, failures.get(failKey) - 1);
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "{}",
      };
    }
    const route = routes[pathname];
    if (!route) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "{}",
      };
    }
    let result = {};
    let issuedSid = null;
    if (method === "initialize") {
      sidSeq += 1;
      issuedSid = `sess-${sidSeq}`;
      call.issuedSid = issuedSid;
      result = { protocolVersion: "2025-06-18", instructions: route.instructions };
    } else if (method === "tools/list") {
      result = { tools: route.tools };
    } else if (method === "tools/call") {
      result = {
        content: [{ type: "text", text: '{"results":[{"title":"note","snippet":"a fact"}]}' }],
        isError: false,
      };
    }
    const jsonrpc = { jsonrpc: "2.0", id: body.id ?? null, result };
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) =>
          issuedSid && String(name).toLowerCase() === "mcp-session-id" ? issuedSid : null,
      },
      json: async () => jsonrpc,
      text: async () => JSON.stringify(jsonrpc),
    };
  };
  return {
    calls,
    fetch: fetchSpy,
    failNext(pathname, method, times = 1) {
      failures.set(`${pathname} ${method}`, times);
    },
  };
}

const realFetch = globalThis.fetch;

function startPlugin(routes, opts = {}) {
  const { ctx, registered, warnings, dirs } = makeApplyCtx();
  const spy = makeFetchSpy(routes, opts);
  globalThis.fetch = spy.fetch;
  apply(ctx, { serverUrl: SERVER_URL });
  return { ctx, registered, warnings, dirs, spy, calls: spy.calls };
}

// Fire agent/created for a fresh recording agent pinned to `dir`; awaited, so the
// session is fully set up when it returns.
async function addAgent(run, dir) {
  const { agent, injected } = makeRecordingAgent();
  run.dirs.set(agent.session.id, dir);
  await run.ctx.emit("agent/created", { agent });
  return { agent, injected };
}

function mcpRequests(calls, url, method) {
  return calls.filter((c) => c.url === url && (method === undefined || c.method === method));
}

function toolNames(injected) {
  return injected.tools.map((t) => t.name);
}

function sectionText(injected, name = "context:rembric") {
  return injected.sections.find((s) => s.name === name)?.text ?? "";
}

function routes() {
  return {
    "/mcp/alpha": {
      tools: [
        { name: "memory.remember", description: "Remember a fact" },
        { name: "memory.search", description: "Search facts" },
      ],
      instructions: "ALPHA crib: call memory_remember to store a fact.",
    },
    "/mcp/beta": {
      tools: [{ name: "memory.context", description: "Load project context" }],
      instructions: "BETA crib: call memory_context to load context.",
    },
  };
}

beforeAll(() => {
  delete process.env.REMBRIC_PROJECT_SLUG;
});

afterEach(() => {
  delete process.env.REMBRIC_PROJECT_SLUG;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("discovery happens on the session's own project endpoint", () => {
  it("a bound session discovers and registers its tools from its own project's endpoint", async () => {
    const run = startPlugin(routes());
    const dir = tempSlugDir("alpha");
    const { injected } = await addAgent(run, dir);
    expect(toolNames(injected)).toEqual(["memory_remember", "memory_search"]);
    expect(mcpRequests(run.calls, ALPHA, "initialize").length).toBeGreaterThan(0);
    expect(mcpRequests(run.calls, ALPHA, "tools/list")).toHaveLength(1);
    expect(sectionText(injected)).toContain("ALPHA crib");
  });

  it("no request targets the bare endpoint that means the implicit default project", async () => {
    const run = startPlugin(routes());
    await addAgent(run, tempSlugDir("alpha"));
    await addAgent(run, tempSlugDir("beta"));
    expect(mcpRequests(run.calls, BARE)).toHaveLength(0);
    expect(run.calls.every((c) => c.pathname === "/mcp/alpha" || c.pathname === "/mcp/beta")).toBe(
      true,
    );
  });

  it("two agents resolving to the same project share one discovery", async () => {
    const run = startPlugin(routes());
    const first = await addAgent(run, tempSlugDir("alpha"));
    const second = await addAgent(run, tempSlugDir("alpha"));
    // Shared = the RESULT (tools + crib-sheet): exactly one tools/list per endpoint.
    expect(mcpRequests(run.calls, ALPHA, "tools/list")).toHaveLength(1);
    // The handshake stays per-session: the cache-miss discovery opens one session of
    // its own, and each of the two agents also initializes its own client — so
    // initialize runs 3 times while tools/list runs once.
    expect(mcpRequests(run.calls, ALPHA, "initialize")).toHaveLength(3);
    expect(toolNames(first.injected)).toEqual(["memory_remember", "memory_search"]);
    expect(toolNames(second.injected)).toEqual(["memory_remember", "memory_search"]);
    expect(sectionText(second.injected)).toContain("ALPHA crib");
  });

  it("an agent on a different project does not share the cache — nothing leaks across projects", async () => {
    const run = startPlugin(routes());
    const onAlpha = await addAgent(run, tempSlugDir("alpha"));
    const onBeta = await addAgent(run, tempSlugDir("beta"));
    expect(mcpRequests(run.calls, ALPHA, "tools/list")).toHaveLength(1);
    expect(mcpRequests(run.calls, BETA, "tools/list")).toHaveLength(1);
    expect(toolNames(onBeta.injected)).toEqual(["memory_context"]);
    expect(toolNames(onAlpha.injected)).toEqual(["memory_remember", "memory_search"]);
    expect(sectionText(onBeta.injected)).toContain("BETA crib");
    expect(sectionText(onBeta.injected)).not.toContain("ALPHA crib");
  });

  it("a command call from a session resolves its tool name against that session's own tools and hits its own endpoint", async () => {
    const run = startPlugin(routes());
    const { agent } = await addAgent(run, tempSlugDir("alpha"));
    const res = await run.registered.get("recall").handler({ agent, rawInput: "widget" });
    expect(res.kind).toBe("success");
    const toolCalls = run.calls.filter((c) => c.method === "tools/call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].url).toBe(ALPHA);
    expect(toolCalls[0].name).toBe("memory.search"); // underscored request resolved to the discovered dotted name
    // mcp-client is session-stateful: the call must echo the mcp-session-id issued to
    // THIS session by its own initialize — not the shared discovery client's session.
    const inits = mcpRequests(run.calls, ALPHA, "initialize");
    expect(inits.length).toBeGreaterThanOrEqual(2); // shared discovery init + this session's own init
    expect(inits[0].issuedSid).toBeTruthy();
    const ownSid = inits[inits.length - 1].issuedSid;
    expect(ownSid).not.toBe(inits[0].issuedSid);
    expect(toolCalls[0].headers["mcp-session-id"]).toBe(ownSid);
  });

  it("in a git-bound repo the per-session initialize carries the fingerprint header, the shared discovery does not", async () => {
    const run = startPlugin(routes(), {
      resolvePayload: { ok: true, outcome: "bound", slug: "alpha" },
    });
    const dir = gitRepoDir();
    const fingerprint = git(dir, "rev-parse", "HEAD");
    const { injected } = await addAgent(run, dir);
    expect(toolNames(injected)).toEqual(["memory_remember", "memory_search"]);
    const inits = mcpRequests(run.calls, ALPHA, "initialize");
    expect(inits).toHaveLength(2); // shared discovery session + this session's own
    // Discovery is endpoint-wide and never carries one session's fingerprint.
    expect(inits[0].headers["x-rembric-repo-fingerprint"]).toBeUndefined();
    // The session's own client does.
    expect(inits[1].headers["x-rembric-repo-fingerprint"]).toBe(fingerprint);
  });

  it("a failed discovery does not cool down — the next session retries its endpoint", async () => {
    const run = startPlugin(routes());
    const dir = tempSlugDir("alpha");
    run.spy.failNext("/mcp/alpha", "initialize", 1);
    const first = await addAgent(run, dir);
    expect(toolNames(first.injected)).toHaveLength(0);
    expect(run.warnings.some((w) => w.includes("discovery failed"))).toBe(true);
    const second = await addAgent(run, dir);
    expect(toolNames(second.injected)).toEqual(["memory_remember", "memory_search"]);
    expect(mcpRequests(run.calls, ALPHA, "initialize").length).toBeGreaterThanOrEqual(2);
    expect(run.warnings.some((w) => w.includes("cooling down"))).toBe(false);
  });
});

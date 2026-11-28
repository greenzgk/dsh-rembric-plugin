// test/host-fail-closed.test.mjs — fail-closed wiring through the plugin entry point.
//
// Ticket #28 (spec #26) at the apply() level: an off session (mode no_project,
// unbound or refused) registers zero memory tools and makes zero requests to the
// memory server; a no_project session carries a system-prompt off notice naming
// both enable paths and ending with the standing guard; /rembric-status reports
// the off mode and its reason, and never claims `on` for an off session.
// On sessions still register the discovered tools on their own project endpoint.
//
// Resolution itself is covered against real temp dirs in project-resolve.test.mjs;
// here the server is a spy on globalThis.fetch and the harness a fake ctx.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { apply } from "../host.js";

const SERVER_URL = "http://rembric.test";
const NOT_CONNECTED = "rembric: not connected for this session";
const GUARD =
  "Tell the user about this in your first reply. Do not create or edit a `.rembric` file yourself: " +
  "where a workspace's memories live is the user's decision. Only do it when the user explicitly asks, " +
  "and ask them for the project slug first.";

const realFetch = globalThis.fetch;
const created = [];
let seq = 0;

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `rembric-wire-${prefix}-`));
  created.push(dir);
  return dir;
}

function gitRepo() {
  const dir = tempDir("git");
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  return dir;
}

function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "-C", dir, ...args],
    { encoding: "utf8" },
  ).trim();
}

// Fake harness ctx driving apply(); rich enough that setupAgent runs for the
// listed agent: commands captured, per-agent injection recorded, credentials
// served, working directory pinned. Routes use ctx.inject(["webServer", ...])
// which stays uncalled — route behavior lives in other test files.
function makeApplyCtx({ agents, dir, tokenValue = "tok" }) {
  const registered = new Map();
  const warnings = [];
  return {
    registered,
    warnings,
    ctx: {
      get: () => undefined,
      on: () => () => {},
      emit: async () => {},
      effect: () => () => {},
      inject: () => ({ dispose: () => {} }),
      logger: { warn: (m) => warnings.push(String(m)) },
      credentials: {
        resolve: async () => (tokenValue ? { value: tokenValue, source: "store" } : undefined),
        set: async () => {},
      },
      agents: { list: () => agents },
      workingDirectory: { get: () => dir },
      commands: {
        register: (def) => {
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
    },
  };
}

// Agent whose own ctx.inject records everything registered on it.
function makeRecordingAgent(sid) {
  const injected = { tools: [], sections: [] };
  const agent = {
    id: sid,
    session: { id: sid, header: {} },
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

// Server spy: answers POST /api/repositories/resolve and JSON-RPC on /mcp
// endpoints; records every request (mcp-client parses via text(), like the
// real fetch path).
function makeFetchSpy(resolve) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url: String(url), method: body.method ?? null, headers: opts.headers });
    if (String(url).endsWith("/api/repositories/resolve")) {
      const payload = resolve?.payload ?? { ok: true, outcome: "unbound", reason: "not_bound" };
      return {
        ok: resolve?.ok ?? true,
        status: resolve?.status ?? 200,
        headers: { get: () => null },
        // project.js postResolve reads json(); mcp-client reads text() — both on
        // every response, matching what real fetch exposes.
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-06-18", instructions: "Remember facts with memory.remember." }
        : body.method === "tools/list"
          ? { tools: [{ name: "memory.remember" }, { name: "memory.search" }] }
          : {};
    const jsonrpc = { jsonrpc: "2.0", id: body.id ?? null, result };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => jsonrpc,
      text: async () => JSON.stringify(jsonrpc),
    };
  };
  return { calls, fetch };
}

// Install the spy, run apply(), return handles plus a restore — the spy must
// stay installed while the async setupAgent finishes, so callers restore only
// after polling status.
function startPlugin({ dir, slug, resolve, token = "tok" }) {
  if (slug === undefined) delete process.env.REMBRIC_PROJECT_SLUG;
  else process.env.REMBRIC_PROJECT_SLUG = slug;
  const { agent, injected } = makeRecordingAgent(`s-${++seq}`);
  const { ctx, registered, warnings } = makeApplyCtx({ agents: [agent], dir, tokenValue: token });
  const spy = makeFetchSpy(resolve);
  globalThis.fetch = spy.fetch;
  apply(ctx, { serverUrl: SERVER_URL });
  return {
    agent,
    injected,
    registered,
    warnings,
    calls: spy.calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function statusText(registered, agent, want, ms = 2000) {
  const t0 = Date.now();
  let text = "";
  while (Date.now() - t0 < ms) {
    const res = await registered.get("rembric-status").handler({ agent });
    text = res.text;
    if (text.includes(want)) return text;
    await new Promise((r) => setTimeout(r, 10));
  }
  return text;
}

function sectionText(injected, name = "context:rembric") {
  return injected.sections.find((s) => s.name === name)?.text ?? "";
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

describe("off outside git: inert and reported", () => {
  it("empty directory → zero requests, zero tools, off notice registered, status off", async () => {
    const dir = tempDir("plain");
    const run = startPlugin({ dir });
    try {
      const text = await statusText(run.registered, run.agent, "no_project");
      expect(text).toContain("Mode: off (no_project)");
      expect(text).toContain("Reason: no_choice");
      expect(text).toContain("Tools: 0");
      expect(text).not.toContain("Mode: on");
      expect(text).not.toContain("not resolved for this session");
      expect(run.calls).toHaveLength(0); // not even discovery
      expect(run.injected.tools).toHaveLength(0);
      const notice = sectionText(run.injected);
      expect(notice).toContain("REMBRIC_PROJECT_SLUG");
      expect(notice).toContain(".rembric");
      expect(notice.trimEnd().endsWith(GUARD)).toBe(true);
    } finally {
      run.restore();
    }
  });

  it("invalid REMBRIC_PROJECT_SLUG → off with invalid_env reason", async () => {
    const dir = tempDir("plain");
    const run = startPlugin({ dir, slug: "Bad Slug!" });
    try {
      const text = await statusText(run.registered, run.agent, "invalid_env");
      expect(text).toContain("Mode: off (no_project)");
      expect(text).toContain("Reason: invalid_env");
      expect(text).toContain("Tools: 0");
      expect(run.calls).toHaveLength(0);
      expect(sectionText(run.injected)).toContain("REMBRIC_PROJECT_SLUG");
    } finally {
      run.restore();
    }
  });

  it("no token outside git → still resolves and reports off, zero requests", async () => {
    const dir = tempDir("plain");
    const run = startPlugin({ dir, token: null });
    try {
      const text = await statusText(run.registered, run.agent, "no_project");
      expect(text).toContain("Mode: off (no_project)");
      expect(text).toContain("Reason: no_choice");
      expect(run.calls).toHaveLength(0);
    } finally {
      run.restore();
    }
  });

  it("off session: /recall reports not connected, no request made", async () => {
    const dir = tempDir("plain");
    const run = startPlugin({ dir });
    try {
      await statusText(run.registered, run.agent, "no_project");
      const res = await run.registered
        .get("recall")
        .handler({ agent: run.agent, rawInput: "anything" });
      expect(res.kind).toBe("error");
      expect(res.text).toContain(NOT_CONNECTED);
      expect(run.calls).toHaveLength(0);
    } finally {
      run.restore();
    }
  });

  it("unbound repository → off (unbound) with server reason, no /mcp request", async () => {
    const repo = gitRepo();
    const run = startPlugin({
      dir: repo,
      resolve: { payload: { ok: true, outcome: "unbound", reason: "not_bound" } },
    });
    try {
      const text = await statusText(run.registered, run.agent, "unbound");
      expect(text).toContain("Mode: off (unbound)");
      expect(text).toContain("Reason: not_bound");
      expect(text).toContain("Tools: 0");
      expect(run.calls.every((c) => c.url.endsWith("/api/repositories/resolve"))).toBe(true);
      expect(run.injected.tools).toHaveLength(0);
    } finally {
      run.restore();
    }
  });

  it("ambiguous repository → off (refused) with ambiguous reason, no /mcp request", async () => {
    const repo = gitRepo();
    const run = startPlugin({
      dir: repo,
      resolve: {
        ok: false,
        status: 409,
        payload: { code: "repository_ambiguous", slugs: ["alpha", "beta"] },
      },
    });
    try {
      const text = await statusText(run.registered, run.agent, "refused");
      expect(text).toContain("Mode: off (refused)");
      expect(text).toContain("Reason: ambiguous");
      expect(text).toContain("Tools: 0");
      expect(run.calls.every((c) => c.url.endsWith("/api/repositories/resolve"))).toBe(true);
    } finally {
      run.restore();
    }
  });
});

describe("on sessions keep working through apply()", () => {
  it(".rembric file → tools registered on /mcp/<slug>, status on (project)", async () => {
    const dir = tempDir("plain");
    writeFileSync(join(dir, ".rembric"), "PROJECT_SLUG=alpha\n");
    const run = startPlugin({ dir });
    try {
      const text = await statusText(run.registered, run.agent, "on (project)");
      expect(text).toContain("Project: alpha (.rembric file)");
      expect(text).toContain("Mode: on (project)");
      expect(text).toContain("Tools: 2");
      expect(
        run.calls.some((c) => c.url === `${SERVER_URL}/mcp/alpha` && c.method === "initialize"),
      ).toBe(true);
      expect(run.injected.tools).toHaveLength(2);
      // crib-sheet forwarded, tool names underscored for the model
      expect(sectionText(run.injected)).toContain("memory_remember");
    } finally {
      run.restore();
    }
  });

  it("REMBRIC_PROJECT_SLUG alone → on with env source label", async () => {
    const dir = tempDir("plain");
    const run = startPlugin({ dir, slug: "gamma" });
    try {
      const text = await statusText(run.registered, run.agent, "on (project)");
      expect(text).toContain("Project: gamma (REMBRIC_PROJECT_SLUG)");
      expect(text).toContain("Mode: on (project)");
      expect(
        run.calls.some((c) => c.url === `${SERVER_URL}/mcp/gamma` && c.method === "initialize"),
      ).toBe(true);
    } finally {
      run.restore();
    }
  });

  it(".rembric wins over env at the entry point too", async () => {
    const dir = tempDir("plain");
    writeFileSync(join(dir, ".rembric"), "PROJECT_SLUG=delta\n");
    const run = startPlugin({ dir, slug: "epsilon" });
    try {
      const text = await statusText(run.registered, run.agent, "on (project)");
      expect(text).toContain("Project: delta (.rembric file)");
      expect(
        run.calls.some((c) => c.url === `${SERVER_URL}/mcp/delta` && c.method === "initialize"),
      ).toBe(true);
      expect(run.calls.some((c) => c.url === `${SERVER_URL}/mcp/epsilon`)).toBe(false);
    } finally {
      run.restore();
    }
  });
});

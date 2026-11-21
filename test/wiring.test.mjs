// test/wiring.test.mjs — the event wiring commands.js exposes: wireFileRecall
// and wireSubagentLearnings, run against fake contexts and a real temp repo.
//
// Read-only w.r.t. plugin sources. Verifies:
//  [A] wireFileRecall with a SPY core — exact call contract (event name,
//      deps fields, args passed to core.fileRecall, nudge injection path).
//  [B] wireFileRecall with a REAL createSessionCore + fake post transport +
//      a real temp git repo — the real gating (knownSessions, trackedRepoPath,
//      per-session dedup) runs end to end.
//  [C] wireSubagentLearnings with a SPY core — event name, args, and that
//      the wire itself does NOT gate on the phrase (core does).
//  [D] wireSubagentLearnings with a REAL core — KEY_LEARNINGS_PHRASE gating,
//      <private> redaction-before-gate, learnings HTTP path.
//  [E] deps contract — every dep field the wire functions read is provided
//      by the deps object host.js builds in apply().

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll } from "vite-plus/test";

import { createSessionCore } from "../session-core.js";
import { wireFileRecall, wireSubagentLearnings } from "../commands.js";

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await settle(10);
  }
  return fn();
}

// ---- fake DSH ctx: captures handlers so the test can fire events ------------

function makeFakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((f) => f !== fn),
        );
    },
    emit(name, ...args) {
      // oxlint-disable-next-line unicorn/no-useless-spread -- defensive copy: iteration stays safe if a handler mutates the handler list during emit
      for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
    },
  };
}

// ---- fake deps with access-recording Proxy ------------------------------------
// The deps object host.js builds in apply(); this list must match it:
const HOST_PROVIDES = [
  "getStateForAgent",
  "getStateBySession",
  "makeNudgeMessage",
  "resolveToolName",
  "warnOnce",
  "resolveToken",
  "saveToken",
  "checkConnection",
  "serverInfo",
];

function makeDeps(fields) {
  const accessed = new Set();
  const proxy = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "string") accessed.add(key);
        return fields[key];
      },
    },
  );
  return { proxy, accessed };
}

// ---- fake HTTP transport ------------------------------------------------------

function fakeResponse(json = {}, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function makeFakePost(handler) {
  const log = [];
  const post = async (path, body, timeoutMs) => {
    log.push({ path, body, timeoutMs });
    return handler(path, body) ?? fakeResponse({});
  };
  return { post, log };
}

// Captured by sections A and C for the deps-contract check in section E.
let fileRecallDepsRead = new Set();
let learningsDepsRead = new Set();

// ============================================================================
// [A] wireFileRecall — spy core: exact wiring contract
// ============================================================================
describe("[A] wireFileRecall — spy core (wiring contract)", () => {
  let ctx;
  let calls;
  let nudges;
  let injected;
  let deps;

  beforeAll(() => {
    ctx = makeFakeCtx();
    calls = { fileRecall: [] };
    nudges = [];
    injected = [];
    const spyCore = {
      fileRecall: (...a) => {
        calls.fileRecall.push(a);
        return Promise.resolve(["hint A", "hint B"]);
      },
    };
    const state = {
      core: spyCore,
      cwd: "/repo",
      sid: "s1",
      agent: { inject: (m) => injected.push(m) },
    };
    deps = makeDeps({
      getStateBySession: (id) => (id === "s1" ? state : undefined),
      makeNudgeMessage: (line) => {
        nudges.push(line);
        return { __nudge: line };
      },
    });
    wireFileRecall(ctx, deps.proxy);
  });

  it('subscribes to "session/event" and nothing else', () => {
    expect(ctx.handlers.has("session/event")).toBe(true);
    expect([...ctx.handlers.keys()]).toEqual(["session/event"]);
  });

  it("A1: read tool/call triggers exactly one core.fileRecall", async () => {
    ctx.emit(
      "session/event",
      { id: "s1" },
      {
        type: "tool/call",
        data: { name: "read", arguments: JSON.stringify({ file_path: "/some/path/file.ts" }) },
      },
    );
    await waitFor(() => calls.fileRecall.length >= 1);
    expect(calls.fileRecall.length).toBe(1);
  });

  it("A1: core.fileRecall receives session id, cwd, and candidate paths", () => {
    const [sidArg, cwdArg, candArg] = calls.fileRecall[0] ?? [];
    expect(sidArg).toBe("s1");
    expect(cwdArg).toBe("/repo");
    expect(candArg).toEqual(["/some/path/file.ts"]);
  });

  it("A2: recall lines are nudged through deps.makeNudgeMessage into agent.inject", async () => {
    await waitFor(() => injected.length >= 2);
    expect(nudges).toEqual(["hint A", "hint B"]);
    expect(injected.map((m) => m?.__nudge)).toEqual(["hint A", "hint B"]);
  });

  it("A3: non-file tool (web_search) triggers no fileRecall", async () => {
    ctx.emit(
      "session/event",
      { id: "s1" },
      { type: "tool/call", data: { name: "web_search", arguments: "{}" } },
    );
    await settle(80);
    expect(calls.fileRecall.length).toBe(1);
  });

  it("A4: event type other than tool/call triggers no fileRecall", async () => {
    ctx.emit(
      "session/event",
      { id: "s1" },
      { type: "assistant/message", data: { message: { content: [] } } },
    );
    await settle(80);
    expect(calls.fileRecall.length).toBe(1);
  });

  it('A5: namespaced tool name "builtin.read" matches and extracts args.path', async () => {
    ctx.emit(
      "session/event",
      { id: "s1" },
      {
        type: "tool/call",
        data: { name: "builtin.read", arguments: JSON.stringify({ path: "/x/y/z.ts" }) },
      },
    );
    await waitFor(() => calls.fileRecall.length >= 2);
    expect(calls.fileRecall.length).toBe(2);
    expect(calls.fileRecall[1][2][0]).toBe("/x/y/z.ts");
  });

  it("A6: bash tool/call extracts the absolute path from args.command", async () => {
    ctx.emit(
      "session/event",
      { id: "s1" },
      {
        type: "tool/call",
        data: {
          name: "bash",
          arguments: JSON.stringify({ command: "cat /some/path/file.ts | wc -l" }),
        },
      },
    );
    await waitFor(() => calls.fileRecall.length >= 3);
    expect(calls.fileRecall.length).toBe(3);
    expect(calls.fileRecall[2][2][0]).toBe("/some/path/file.ts");
  });

  it("A7: tool/call for an unmapped session triggers no fileRecall", async () => {
    ctx.emit(
      "session/event",
      { id: "unknown" },
      { type: "tool/call", data: { name: "read", arguments: '{"file_path":"/a/b.ts"}' } },
    );
    await settle(80);
    expect(calls.fileRecall.length).toBe(3);
  });

  it("A8: wireFileRecall reads deps.getStateBySession + deps.makeNudgeMessage", () => {
    expect(deps.accessed.has("getStateBySession")).toBe(true);
    expect(deps.accessed.has("makeNudgeMessage")).toBe(true);
    fileRecallDepsRead = new Set(deps.accessed);
  });
});

// ============================================================================
// [B] wireFileRecall — REAL createSessionCore + fake transport + temp git repo
// ============================================================================
describe("[B] wireFileRecall — real core + fake transport + real git repo (real gating)", () => {
  let repo;
  let log;
  let core;
  let injected;
  let ctx;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "rembric-wire-"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
    const git = (...args) =>
      execFileSync(
        "git",
        ["-C", repo, "-c", "user.email=wiring@test.local", "-c", "user.name=wiring-test", ...args],
        { stdio: "pipe" },
      );
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");

    const { post, log: postLog } = makeFakePost((path) => {
      if (path.endsWith("/file-recall")) return fakeResponse({ lines: ["recall hint for widget"] });
      if (path === "/api/demo/sessions") return fakeResponse({ created: true });
      return fakeResponse({});
    });
    log = postLog;
    core = createSessionCore({
      agent: "rembric-dsh",
      baseUrl: "http://127.0.0.1:1",
      apiToken: "tok",
      slug: "demo",
      cwd: repo,
      post,
    });
    await core.ensureSession("s2");

    injected = [];
    ctx = makeFakeCtx();
    const state = { core, cwd: repo, sid: "s2", agent: { inject: (m) => injected.push(m) } };
    const deps = makeDeps({
      getStateBySession: (id) => (id === "s2" ? state : undefined),
      makeNudgeMessage: (line) => ({ __nudge: line }),
    });
    wireFileRecall(ctx, deps.proxy);
  });

  it("real core is enabled (baseUrl + apiToken + slug present)", () => {
    expect(core.disabled).toBe(false);
  });

  it("tracked file triggers real POST /api/demo/sessions/s2/file-recall", async () => {
    ctx.emit(
      "session/event",
      { id: "s2" },
      {
        type: "tool/call",
        data: {
          name: "read",
          arguments: JSON.stringify({ file_path: join(repo, "src", "widget.ts") }),
        },
      },
    );
    const gotPost = await waitFor(() =>
      log.some((e) => e.path === "/api/demo/sessions/s2/file-recall"),
    );
    expect(gotPost).toBe(true);
  });

  it("file-recall body.path is repo-relative", () => {
    const fr = log.find((e) => e.path === "/api/demo/sessions/s2/file-recall");
    expect(fr?.body?.path).toBe("src/widget.ts");
  });

  it("server recall line reaches agent.inject via deps.makeNudgeMessage", async () => {
    await waitFor(() => injected.length >= 1);
    expect(injected[0]?.__nudge).toBe("recall hint for widget");
  });

  it("second touch of the same path is de-duplicated by the core (no extra POST)", async () => {
    const before = log.filter((e) => e.path.endsWith("/file-recall")).length;
    ctx.emit(
      "session/event",
      { id: "s2" },
      {
        type: "tool/call",
        data: {
          name: "read",
          arguments: JSON.stringify({ file_path: join(repo, "src", "widget.ts") }),
        },
      },
    );
    await settle(200);
    expect(log.filter((e) => e.path.endsWith("/file-recall")).length).toBe(before);
  });

  it("untracked file is skipped by trackedRepoPath (no POST)", async () => {
    const before = log.filter((e) => e.path.endsWith("/file-recall")).length;
    writeFileSync(join(repo, "src", "ghost.ts"), "untracked\n");
    ctx.emit(
      "session/event",
      { id: "s2" },
      {
        type: "tool/call",
        data: {
          name: "read",
          arguments: JSON.stringify({ file_path: join(repo, "src", "ghost.ts") }),
        },
      },
    );
    await settle(200);
    expect(log.filter((e) => e.path.endsWith("/file-recall")).length).toBe(before);
  });
});

// ============================================================================
// [C] wireSubagentLearnings — spy core: wiring contract
// ============================================================================
describe("[C] wireSubagentLearnings — spy core (wiring contract)", () => {
  let ctx;
  let calls;
  let deps;

  beforeAll(() => {
    ctx = makeFakeCtx();
    calls = { postSubagentReport: [] };
    const spyCore = {
      postSubagentReport: (...a) => {
        calls.postSubagentReport.push(a);
        return Promise.resolve(true);
      },
    };
    const state = { core: spyCore, sid: "p1" };
    deps = makeDeps({
      getStateBySession: (id) => (id === "p1" ? state : undefined),
    });
    wireSubagentLearnings(ctx, deps.proxy);
  });

  it('subscribes only to event "subagent/end"', () => {
    expect(ctx.handlers.size).toBe(1);
    expect(ctx.handlers.has("subagent/end")).toBe(true);
  });

  it("subagent/end with a report triggers exactly one core.postSubagentReport", async () => {
    ctx.emit("subagent/end", {
      parentSessionId: "p1",
      lastAssistantMessage: [
        { type: "text", text: "Task done." },
        { type: "text", text: "## Key Learnings\n- widget uses X" },
      ],
    });
    await waitFor(() => calls.postSubagentReport.length >= 1);
    expect(calls.postSubagentReport.length).toBe(1);
  });

  it("postSubagentReport args: parentSessionId, joined+trimmed report text, undefined agentType", () => {
    const [parentArg, reportArg, typeArg] = calls.postSubagentReport[0] ?? [];
    expect(parentArg).toBe("p1");
    expect(reportArg).toBe("Task done.\n## Key Learnings\n- widget uses X");
    expect(typeArg).toBeUndefined();
  });

  it("non-matching report is still forwarded to core (KEY_LEARNINGS gate lives in core, not the wire)", async () => {
    ctx.emit("subagent/end", {
      parentSessionId: "p1",
      lastAssistantMessage: [{ type: "text", text: "plain summary, no magic words" }],
    });
    await waitFor(() => calls.postSubagentReport.length >= 2);
    expect(calls.postSubagentReport.length).toBe(2);
  });

  it("no call when parentSessionId is missing or unmapped", async () => {
    ctx.emit("subagent/end", {
      lastAssistantMessage: [{ type: "text", text: "## Key Learnings x" }],
    });
    ctx.emit("subagent/end", {
      parentSessionId: "zz",
      lastAssistantMessage: [{ type: "text", text: "## Key Learnings x" }],
    });
    await settle(100);
    expect(calls.postSubagentReport.length).toBe(2);
  });

  it("empty lastAssistantMessage triggers no call", async () => {
    ctx.emit("subagent/end", { parentSessionId: "p1", lastAssistantMessage: [] });
    await settle(100);
    expect(calls.postSubagentReport.length).toBe(2);
  });

  it("wireSubagentLearnings reads only deps.getStateBySession", () => {
    learningsDepsRead = new Set(deps.accessed);
    expect(learningsDepsRead.has("getStateBySession")).toBe(true);
    expect(learningsDepsRead.has("getStateForAgent")).toBe(false);
  });
});

// ============================================================================
// [D] wireSubagentLearnings — REAL core: KEY_LEARNINGS_PHRASE gating
// ============================================================================
describe("[D] wireSubagentLearnings — real core (KEY_LEARNINGS_PHRASE gating)", () => {
  let log;
  let ctx;

  beforeAll(async () => {
    const { post, log: postLog } = makeFakePost((path) =>
      path === "/api/demo/sessions" ? fakeResponse({ created: true }) : fakeResponse({}),
    );
    log = postLog;
    const core = createSessionCore({
      agent: "rembric-dsh",
      baseUrl: "http://127.0.0.1:1",
      apiToken: "tok",
      slug: "demo",
      cwd: "/repo",
      post,
    });
    await core.ensureSession("p2");
    const state = { core, sid: "p2" };
    ctx = makeFakeCtx();
    const deps = makeDeps({ getStateBySession: (id) => (id === "p2" ? state : undefined) });
    wireSubagentLearnings(ctx, deps.proxy);
  });

  const learningsPosts = () => log.filter((e) => e.path.endsWith("/learnings")).length;

  it('report containing "Key Learnings" POSTs /api/demo/sessions/p2/learnings', async () => {
    ctx.emit("subagent/end", {
      parentSessionId: "p2",
      lastAssistantMessage: [{ type: "text", text: "## Key Learnings\n- shipped it" }],
    });
    const learned = await waitFor(() => learningsPosts() >= 1);
    expect(learned).toBe(true);
  });

  it("body.report carries the full report text", () => {
    const entry = log.find((e) => e.path.endsWith("/learnings"));
    expect(entry?.body?.report).toBe("## Key Learnings\n- shipped it");
  });

  it("body carries no agentType key when agentType is undefined", () => {
    const entry = log.find((e) => e.path.endsWith("/learnings"));
    expect(entry).toBeTruthy();
    expect("agentType" in entry.body).toBe(false);
  });

  it('report without the "key learnings" phrase is gated out (no POST)', async () => {
    ctx.emit("subagent/end", {
      parentSessionId: "p2",
      lastAssistantMessage: [{ type: "text", text: "plain summary, no magic words" }],
    });
    await settle(200);
    expect(learningsPosts()).toBe(1);
  });

  it("phrase hidden inside <private> is redacted before the gate (no POST)", async () => {
    ctx.emit("subagent/end", {
      parentSessionId: "p2",
      lastAssistantMessage: [{ type: "text", text: "<private>Key Learnings: secret</private>" }],
    });
    await settle(200);
    expect(learningsPosts()).toBe(1);
  });

  it("parent session unknown to the core -> no POST", async () => {
    ctx.emit("subagent/end", {
      parentSessionId: "ghost",
      lastAssistantMessage: [{ type: "text", text: "## Key Learnings x" }],
    });
    await settle(200);
    expect(learningsPosts()).toBe(1);
  });
});

// ============================================================================
// [E] deps contract vs the object host.js builds
// ============================================================================
describe("[E] deps contract vs the object host.js builds in apply()", () => {
  it("every dep read by the wire functions is provided by host.js", () => {
    // Guard against a vacuous pass: if sections A and C did not run (e.g. a
    // `.only`/skip/filter run targeting this test alone), both sets are empty
    // and `missing` would be trivially empty. E must fail in that case.
    expect(fileRecallDepsRead.size).toBeGreaterThan(0);
    expect(learningsDepsRead.size).toBeGreaterThan(0);
    const used = new Set([...fileRecallDepsRead, ...learningsDepsRead]);
    console.log(
      `  wire functions read : ${[...used].sort((a, b) => a.localeCompare(b)).join(", ")}`,
    );
    console.log(`  host.js apply() provides: ${HOST_PROVIDES.join(", ")}`);
    const missing = [...used].filter((k) => !HOST_PROVIDES.includes(k));
    expect(missing).toEqual([]);
  });
});

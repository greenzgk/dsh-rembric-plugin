// test/wiring.test.mjs — integration test for the Phase 3 event wiring in
// commands.js: wireFileRecall + wireSubagentLearnings.
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
//      by host.js's phase3 object (host.js:435-441).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionCore } from '../session-core.js';
import { wireFileRecall, wireSubagentLearnings } from '../commands.js';

// ---- tiny assert harness -----------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${msg}`);
  } else {
    failed += 1;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}

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
        handlers.set(name, (handlers.get(name) ?? []).filter((f) => f !== fn));
    },
    emit(name, ...args) {
      for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
    },
  };
}

// ---- fake deps with access-recording Proxy ------------------------------------
// host.js apply() builds phase3 with exactly these five fields (host.js:435-441):
const HOST_PROVIDES = [
  'getStateForAgent',
  'getStateBySession',
  'makeNudgeMessage',
  'resolveToolName',
  'warnOnce',
];

function makeDeps(fields) {
  const accessed = new Set();
  const proxy = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === 'string') accessed.add(key);
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

// ============================================================================
// [A] wireFileRecall — spy core: exact wiring contract
// ============================================================================
console.log('\n[A] wireFileRecall — spy core (wiring contract)');
{
  const ctx = makeFakeCtx();
  const calls = { fileRecall: [] };
  const nudges = [];
  const injected = [];
  const spyCore = {
    fileRecall: (...a) => {
      calls.fileRecall.push(a);
      return Promise.resolve(['hint A', 'hint B']);
    },
  };
  const state = {
    core: spyCore,
    cwd: '/repo',
    sid: 's1',
    agent: { inject: (m) => injected.push(m) },
  };
  const deps = makeDeps({
    getStateBySession: (id) => (id === 's1' ? state : undefined),
    makeNudgeMessage: (line) => {
      nudges.push(line);
      return { __nudge: line };
    },
  });
  wireFileRecall(ctx, deps.proxy);

  assert(
    ctx.handlers.has('session/event'),
    'subscribes to event "session/event" (no other event)',
  );
  assert(
    ctx.handlers.size === 1 && [...ctx.handlers.keys()][0] === 'session/event',
    `only "session/event" subscribed (got: ${[...ctx.handlers.keys()].join(', ')})`,
  );

  // A1: read tool with JSON-string args carrying file_path
  ctx.emit(
    'session/event',
    { id: 's1' },
    {
      type: 'tool/call',
      data: { name: 'read', arguments: JSON.stringify({ file_path: '/some/path/file.ts' }) },
    },
  );
  await waitFor(() => calls.fileRecall.length >= 1);
  assert(calls.fileRecall.length === 1, 'read tool/call triggers exactly one core.fileRecall');
  const [sidArg, cwdArg, candArg] = calls.fileRecall[0] ?? [];
  assert(sidArg === 's1', `core.fileRecall arg1 = session id "s1" (got ${JSON.stringify(sidArg)})`);
  assert(cwdArg === '/repo', `core.fileRecall arg2 = state.cwd "/repo" (got ${JSON.stringify(cwdArg)})`);
  assert(
    Array.isArray(candArg) && candArg.length === 1 && candArg[0] === '/some/path/file.ts',
    `core.fileRecall arg3 = candidate paths ["/some/path/file.ts"] (got ${JSON.stringify(candArg)})`,
  );

  // A2: recall lines are nudged through deps.makeNudgeMessage into agent.inject
  await waitFor(() => injected.length >= 2);
  assert(
    nudges.length === 2 && nudges[0] === 'hint A' && nudges[1] === 'hint B',
    'deps.makeNudgeMessage called once per recall line',
  );
  assert(
    injected.length === 2 && injected[0]?.__nudge === 'hint A' && injected[1]?.__nudge === 'hint B',
    'agent.inject received exactly the objects deps.makeNudgeMessage returned',
  );

  // A3: non-file tool is ignored
  ctx.emit(
    'session/event',
    { id: 's1' },
    { type: 'tool/call', data: { name: 'web_search', arguments: '{}' } },
  );
  await settle(80);
  assert(calls.fileRecall.length === 1, 'non-file tool (web_search) triggers no fileRecall');

  // A4: other event types are ignored
  ctx.emit(
    'session/event',
    { id: 's1' },
    { type: 'assistant/message', data: { message: { content: [] } } },
  );
  await settle(80);
  assert(calls.fileRecall.length === 1, 'event type other than tool/call triggers no fileRecall');

  // A5: namespaced tool name (builtin.read) still matches
  ctx.emit(
    'session/event',
    { id: 's1' },
    {
      type: 'tool/call',
      data: { name: 'builtin.read', arguments: JSON.stringify({ path: '/x/y/z.ts' }) },
    },
  );
  await waitFor(() => calls.fileRecall.length >= 2);
  assert(
    calls.fileRecall.length === 2 && calls.fileRecall[1][2][0] === '/x/y/z.ts',
    'namespaced tool name "builtin.read" matches and extracts args.path',
  );

  // A6: shell tool extracts paths from the command string
  ctx.emit(
    'session/event',
    { id: 's1' },
    {
      type: 'tool/call',
      data: { name: 'bash', arguments: JSON.stringify({ command: 'cat /some/path/file.ts | wc -l' }) },
    },
  );
  await waitFor(() => calls.fileRecall.length >= 3);
  assert(
    calls.fileRecall.length === 3 && calls.fileRecall[2][2][0] === '/some/path/file.ts',
    'bash tool/call extracts the absolute path from args.command',
  );

  // A7: unknown session -> no call, no throw
  ctx.emit(
    'session/event',
    { id: 'unknown' },
    { type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"/a/b.ts"}' } },
  );
  await settle(80);
  assert(calls.fileRecall.length === 3, 'tool/call for an unmapped session triggers no fileRecall');

  // A8: deps actually read by this wire function
  assert(
    deps.accessed.has('getStateBySession') && deps.accessed.has('makeNudgeMessage'),
    `wireFileRecall reads deps.getStateBySession + deps.makeNudgeMessage (read: ${[...deps.accessed].join(', ')})`,
  );
  var fileRecallDepsRead = new Set(deps.accessed);
}

// ============================================================================
// [B] wireFileRecall — REAL createSessionCore + fake transport + temp git repo
// ============================================================================
console.log('\n[B] wireFileRecall — real core + fake transport + real git repo (real gating)');
{
  const repo = mkdtempSync(join(tmpdir(), 'rembric-wire-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'widget.ts'), 'export const widget = 1;\n');
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.email=wiring@test.local', '-c', 'user.name=wiring-test', ...args],
      { stdio: 'pipe' },
    );
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');

  const { post, log } = makeFakePost((path) => {
    if (path.endsWith('/file-recall')) return fakeResponse({ lines: ['recall hint for widget'] });
    if (path === '/api/demo/sessions') return fakeResponse({ created: true });
    return fakeResponse({});
  });
  const core = createSessionCore({
    agent: 'rembric-dsh',
    baseUrl: 'http://127.0.0.1:1',
    apiToken: 'tok',
    slug: 'demo',
    cwd: repo,
    post,
  });
  assert(core.disabled === false, 'real core is enabled (baseUrl + apiToken + slug present)');
  await core.ensureSession('s2');

  const injected = [];
  const state = { core, cwd: repo, sid: 's2', agent: { inject: (m) => injected.push(m) } };
  const ctx = makeFakeCtx();
  const deps = makeDeps({
    getStateBySession: (id) => (id === 's2' ? state : undefined),
    makeNudgeMessage: (line) => ({ __nudge: line }),
  });
  wireFileRecall(ctx, deps.proxy);

  ctx.emit(
    'session/event',
    { id: 's2' },
    {
      type: 'tool/call',
      data: { name: 'read', arguments: JSON.stringify({ file_path: join(repo, 'src', 'widget.ts') }) },
    },
  );
  const gotPost = await waitFor(
    () => log.some((e) => e.path === '/api/demo/sessions/s2/file-recall'),
  );
  assert(gotPost, 'tracked file triggers real POST /api/demo/sessions/s2/file-recall');
  const fr = log.find((e) => e.path === '/api/demo/sessions/s2/file-recall');
  assert(
    fr?.body?.path === 'src/widget.ts',
    `file-recall body.path is repo-relative "src/widget.ts" (got ${JSON.stringify(fr?.body?.path)})`,
  );
  await waitFor(() => injected.length >= 1);
  assert(
    injected[0]?.__nudge === 'recall hint for widget',
    'server recall line reaches agent.inject via deps.makeNudgeMessage',
  );

  // dedup: same path again must not re-POST
  const before = log.filter((e) => e.path.endsWith('/file-recall')).length;
  ctx.emit(
    'session/event',
    { id: 's2' },
    {
      type: 'tool/call',
      data: { name: 'read', arguments: JSON.stringify({ file_path: join(repo, 'src', 'widget.ts') }) },
    },
  );
  await settle(200);
  assert(
    log.filter((e) => e.path.endsWith('/file-recall')).length === before,
    'second touch of the same path is de-duplicated by the core (no extra POST)',
  );

  // untracked file must not POST
  writeFileSync(join(repo, 'src', 'ghost.ts'), 'untracked\n');
  ctx.emit(
    'session/event',
    { id: 's2' },
    {
      type: 'tool/call',
      data: { name: 'read', arguments: JSON.stringify({ file_path: join(repo, 'src', 'ghost.ts') }) },
    },
  );
  await settle(200);
  assert(
    log.filter((e) => e.path.endsWith('/file-recall')).length === before,
    'untracked file is skipped by trackedRepoPath (no POST)',
  );
}

// ============================================================================
// [C] wireSubagentLearnings — spy core: wiring contract
// ============================================================================
console.log('\n[C] wireSubagentLearnings — spy core (wiring contract)');
{
  const ctx = makeFakeCtx();
  const calls = { postSubagentReport: [] };
  const spyCore = {
    postSubagentReport: (...a) => {
      calls.postSubagentReport.push(a);
      return Promise.resolve(true);
    },
  };
  const state = { core: spyCore, sid: 'p1' };
  const deps = makeDeps({
    getStateBySession: (id) => (id === 'p1' ? state : undefined),
  });
  wireSubagentLearnings(ctx, deps.proxy);

  assert(
    ctx.handlers.size === 1 && ctx.handlers.has('subagent/end'),
    `subscribes only to event "subagent/end" (got: ${[...ctx.handlers.keys()].join(', ')})`,
  );

  const reportText = 'Task done.\n## Key Learnings\n- widget uses X';
  ctx.emit('subagent/end', {
    parentSessionId: 'p1',
    lastAssistantMessage: [
      { type: 'text', text: 'Task done.' },
      { type: 'text', text: '## Key Learnings\n- widget uses X' },
    ],
  });
  await waitFor(() => calls.postSubagentReport.length >= 1);
  assert(
    calls.postSubagentReport.length === 1,
    'subagent/end with a report triggers exactly one core.postSubagentReport',
  );
  const [parentArg, reportArg, typeArg] = calls.postSubagentReport[0] ?? [];
  assert(parentArg === 'p1', `arg1 = parentSessionId "p1" (got ${JSON.stringify(parentArg)})`);
  assert(
    reportArg === reportText,
    `arg2 = text blocks joined with \\n and trimmed (got ${JSON.stringify(reportArg)})`,
  );
  assert(
    typeArg === undefined,
    `arg3 (agentType) = undefined — SubagentRunEndInfo has no child-type field (got ${JSON.stringify(typeArg)})`,
  );

  // The wire does NOT duplicate the phrase gate — core owns it. Non-matching text
  // must still reach the core (which will settle false without a request).
  ctx.emit('subagent/end', {
    parentSessionId: 'p1',
    lastAssistantMessage: [{ type: 'text', text: 'plain summary, no magic words' }],
  });
  await waitFor(() => calls.postSubagentReport.length >= 2);
  assert(
    calls.postSubagentReport.length === 2,
    'non-matching report is still forwarded to core (KEY_LEARNINGS gate lives in core, not the wire)',
  );

  // missing parentSessionId / unknown parent -> no call
  ctx.emit('subagent/end', {
    lastAssistantMessage: [{ type: 'text', text: '## Key Learnings x' }],
  });
  ctx.emit('subagent/end', {
    parentSessionId: 'zz',
    lastAssistantMessage: [{ type: 'text', text: '## Key Learnings x' }],
  });
  await settle(100);
  assert(
    calls.postSubagentReport.length === 2,
    'no call when parentSessionId is missing or unmapped',
  );

  // empty blocks -> no call
  ctx.emit('subagent/end', { parentSessionId: 'p1', lastAssistantMessage: [] });
  await settle(100);
  assert(calls.postSubagentReport.length === 2, 'empty lastAssistantMessage triggers no call');

  var learningsDepsRead = new Set(deps.accessed);
  assert(
    learningsDepsRead.has('getStateBySession') && !learningsDepsRead.has('getStateForAgent'),
    `wireSubagentLearnings reads only deps.getStateBySession (read: ${[...learningsDepsRead].join(', ')})`,
  );
}

// ============================================================================
// [D] wireSubagentLearnings — REAL core: KEY_LEARNINGS_PHRASE gating
// ============================================================================
console.log('\n[D] wireSubagentLearnings — real core (KEY_LEARNINGS_PHRASE gating)');
{
  const { post, log } = makeFakePost((path) =>
    path === '/api/demo/sessions' ? fakeResponse({ created: true }) : fakeResponse({}),
  );
  const core = createSessionCore({
    agent: 'rembric-dsh',
    baseUrl: 'http://127.0.0.1:1',
    apiToken: 'tok',
    slug: 'demo',
    cwd: '/repo',
    post,
  });
  await core.ensureSession('p2');
  const state = { core, sid: 'p2' };
  const ctx = makeFakeCtx();
  const deps = makeDeps({ getStateBySession: (id) => (id === 'p2' ? state : undefined) });
  wireSubagentLearnings(ctx, deps.proxy);

  const learningsPosts = () => log.filter((e) => e.path.endsWith('/learnings')).length;

  ctx.emit('subagent/end', {
    parentSessionId: 'p2',
    lastAssistantMessage: [{ type: 'text', text: '## Key Learnings\n- shipped it' }],
  });
  const learned = await waitFor(() => learningsPosts() >= 1);
  assert(learned, 'report containing "Key Learnings" POSTs /api/demo/sessions/p2/learnings');
  const entry = log.find((e) => e.path.endsWith('/learnings'));
  assert(
    entry?.body?.report === '## Key Learnings\n- shipped it',
    `body.report carries the full report text (got ${JSON.stringify(entry?.body?.report)})`,
  );
  assert(
    entry && !('agentType' in entry.body),
    'body carries no agentType key when agentType is undefined',
  );

  // non-matching report -> gated out, no POST
  ctx.emit('subagent/end', {
    parentSessionId: 'p2',
    lastAssistantMessage: [{ type: 'text', text: 'plain summary, no magic words' }],
  });
  await settle(200);
  assert(learningsPosts() === 1, 'report without the "key learnings" phrase is gated out (no POST)');

  // phrase only inside <private> -> redacted before the gate -> no POST
  ctx.emit('subagent/end', {
    parentSessionId: 'p2',
    lastAssistantMessage: [{ type: 'text', text: '<private>Key Learnings: secret</private>' }],
  });
  await settle(200);
  assert(
    learningsPosts() === 1,
    'phrase hidden inside <private> is redacted before the gate (no POST)',
  );

  // unknown parent session (never ensureSession-ed) -> core returns false, no POST
  ctx.emit('subagent/end', {
    parentSessionId: 'ghost',
    lastAssistantMessage: [{ type: 'text', text: '## Key Learnings x' }],
  });
  await settle(200);
  assert(learningsPosts() === 1, 'parent session unknown to the core -> no POST');
}

// ============================================================================
// [E] deps contract vs host.js phase3
// ============================================================================
console.log('\n[E] deps contract vs host.js phase3 (host.js:435-441)');
{
  const used = new Set([...fileRecallDepsRead, ...learningsDepsRead]);
  console.log(`  wire functions read : ${[...used].sort().join(', ')}`);
  console.log(`  host.js phase3 gives: ${HOST_PROVIDES.join(', ')}`);
  const missing = [...used].filter((k) => !HOST_PROVIDES.includes(k));
  assert(
    missing.length === 0,
    `every dep read by the wire functions is provided by host.js (missing: ${missing.join(', ') || 'none'})`,
  );
}

// ---- summary -----------------------------------------------------------------
console.log(
  `\n${'='.repeat(64)}\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`,
);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}

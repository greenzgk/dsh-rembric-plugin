// test/project-resolve.test.mjs — project resolution contract (ticket #28, spec #26).
//
// Outside a git repository the project comes ONLY from an explicit choice in the
// session's starting directory: a `.rembric` file (wins) or REMBRIC_PROJECT_SLUG.
// No choice → mode `no_project` (off), with a reason and a human-readable message;
// `default` is never produced. Inside git the bound/unbound/ambiguous outcomes are
// unchanged. All resolution runs against real temporary directories; the memory
// server is stubbed via fetchImpl (and must see zero requests outside git).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { resolveProject } from "../project.js";

const SERVER_URL = "http://rembric.test";
const created = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `rembric-res-${prefix}-`));
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

function gitRepo({ commit = true } = {}) {
  const dir = tempDir("git");
  git(dir, "init", "-q");
  if (commit) git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  return dir;
}

// fetchImpl stub for POST /api/repositories/resolve; records every call.
function stubResolve(payload, { status = 200, ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status, json: async () => payload };
  };
  return { calls, fetchImpl };
}

// fetchImpl that must never be called; records and throws so any request fails loudly.
function forbiddenFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    throw new Error(`unexpected request to ${url}`);
  };
  return { calls, fetchImpl };
}

async function resolve(dir, env = {}, overrides = {}) {
  const { calls, fetchImpl } = forbiddenFetch();
  const result = await resolveProject({
    startDir: dir,
    env,
    serverUrl: SERVER_URL,
    apiToken: "tok",
    fetchImpl,
    ...overrides,
  });
  return { result, calls };
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("outside git: explicit choice only, else off", () => {
  it("no .rembric, no env → no_project with a no-choice reason and a message", async () => {
    const dir = tempDir("plain");
    const { result, calls } = await resolve(dir);
    expect(result.mode).toBe("no_project");
    expect(result.slug).toBeNull();
    expect(result.reason).toBe("no_choice");
    expect(result.message).toContain("off");
    expect(calls).toHaveLength(0); // resolution touched no server
  });

  it(".rembric file names the project", async () => {
    const dir = tempDir("plain");
    writeFileSync(join(dir, ".rembric"), "PROJECT_SLUG=alpha\n");
    const { result, calls } = await resolve(dir);
    expect(result.mode).toBe("project");
    expect(result.slug).toBe("alpha");
    expect(result.source).toBe("rembric");
    expect(calls).toHaveLength(0);
  });

  it("REMBRIC_PROJECT_SLUG alone names the project", async () => {
    const dir = tempDir("plain");
    const { result, calls } = await resolve(dir, { REMBRIC_PROJECT_SLUG: "beta" });
    expect(result.mode).toBe("project");
    expect(result.slug).toBe("beta");
    expect(result.source).toBe("env");
    expect(calls).toHaveLength(0);
  });

  it("invalid REMBRIC_PROJECT_SLUG is no choice → off, never a fallback", async () => {
    const dir = tempDir("plain");
    const { result, calls } = await resolve(dir, { REMBRIC_PROJECT_SLUG: "Bad Slug!" });
    expect(result.mode).toBe("no_project");
    expect(result.slug).toBeNull();
    expect(result.reason).toBe("invalid_env");
    expect(result.message).toContain("REMBRIC_PROJECT_SLUG");
    expect(calls).toHaveLength(0);
  });

  it(".rembric wins over REMBRIC_PROJECT_SLUG when both exist", async () => {
    const dir = tempDir("plain");
    writeFileSync(join(dir, ".rembric"), "PROJECT_SLUG=alpha\n");
    const { result } = await resolve(dir, { REMBRIC_PROJECT_SLUG: "beta" });
    expect(result.mode).toBe("project");
    expect(result.slug).toBe("alpha");
    expect(result.source).toBe("rembric");
  });

  it("a .rembric in a parent directory is ignored outside git (no walk)", async () => {
    const parent = tempDir("parent");
    writeFileSync(join(parent, ".rembric"), "PROJECT_SLUG=alpha\n");
    const child = join(parent, "child");
    mkdirSync(child);
    // No .git anywhere, so the probe says outside git; the file lives only in
    // the parent, and outside git only the starting directory is consulted.
    const { result } = await resolve(child);
    expect(result.mode).toBe("no_project");
    expect(result.slug).toBeNull();
    expect(result.reason).toBe("no_choice");
  });

  it("an explicit PROJECT_SLUG=default is honored (user chose it)", async () => {
    const dir = tempDir("plain");
    writeFileSync(join(dir, ".rembric"), "PROJECT_SLUG=default\n");
    const { result } = await resolve(dir);
    expect(result.mode).toBe("project");
    expect(result.slug).toBe("default");
    expect(result.source).toBe("rembric");
  });

  it("invalid .rembric content with no env → off (the file names nothing valid)", async () => {
    const dir = tempDir("plain");
    writeFileSync(join(dir, ".rembric"), "PROJECT_SLUG=Not Valid\n");
    const { result } = await resolve(dir);
    expect(result.mode).toBe("no_project");
    expect(result.slug).toBeNull();
    expect(result.reason).toBe("invalid_file");
  });

  it("no input combination outside git ever yields mode `default`", async () => {
    const withFile = tempDir("plain");
    writeFileSync(join(withFile, ".rembric"), "PROJECT_SLUG=gamma\n");
    const badFile = tempDir("plain");
    writeFileSync(join(badFile, ".rembric"), "PROJECT_SLUG=bad slug\n");
    const empty1 = tempDir("plain");
    const empty2 = tempDir("plain");
    const { calls, fetchImpl } = forbiddenFetch();
    const combos = [
      [withFile, {}],
      [withFile, { REMBRIC_PROJECT_SLUG: "other" }],
      [empty1, { REMBRIC_PROJECT_SLUG: "ok-slug" }],
      [empty2, { REMBRIC_PROJECT_SLUG: "BAD" }],
      [empty2, {}],
      [badFile, {}],
    ];
    for (const [dir, env] of combos) {
      const result = await resolveProject({
        startDir: dir,
        env,
        serverUrl: SERVER_URL,
        apiToken: "tok",
        fetchImpl,
      });
      expect(result.mode === "default").toBe(false);
      expect(["project", "no_project"]).toContain(result.mode);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("inside git: outcomes unchanged by #28", () => {
  it("repository bound to one project → project via fingerprint binding", async () => {
    const repo = gitRepo();
    const { calls, fetchImpl } = stubResolve({ ok: true, outcome: "bound", slug: "gamma" });
    const result = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: "tok",
      fetchImpl,
    });
    expect(result.mode).toBe("project");
    expect(result.slug).toBe("gamma");
    expect(result.source).toBe("fingerprint");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SERVER_URL}/api/repositories/resolve`);
    expect(calls[0].body.fingerprint).toBe(git(repo, "rev-parse", "HEAD"));
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
  });

  it("repository not bound → unbound with its own reason and remedy", async () => {
    const repo = gitRepo();
    const { calls, fetchImpl } = stubResolve({ ok: true, outcome: "unbound", reason: "not_bound" });
    const result = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: "tok",
      fetchImpl,
    });
    expect(result.mode).toBe("unbound");
    expect(result.reason).toBe("not_bound");
    expect(result.message).toContain("no Rembric project");
    expect(calls).toHaveLength(1);
  });

  it("repository bound to several projects → refused/ambiguous, names the slugs", async () => {
    const repo = gitRepo();
    const { calls, fetchImpl } = stubResolve(
      { code: "repository_ambiguous", slugs: ["alpha", "beta"] },
      {
        status: 409,
        ok: false,
      },
    );
    const result = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: "tok",
      fetchImpl,
    });
    expect(result.mode).toBe("refused");
    expect(result.reason).toBe("ambiguous");
    expect(result.message).toContain("alpha, beta");
    expect(calls).toHaveLength(1); // only the resolve POST; no tool traffic
  });

  it("explicit .rembric inside git still wins over the binding flow", async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, ".rembric"), "PROJECT_SLUG=delta\n");
    const { calls, fetchImpl } = stubResolve({ ok: true, outcome: "explicit" });
    const result = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: "tok",
      fetchImpl,
    });
    expect(result.mode).toBe("project");
    expect(result.slug).toBe("delta");
    expect(result.source).toBe("rembric-root");
    expect(calls[0].body.explicit).toEqual({ slug: "delta", source: "rembric-root" });
  });

  it("explicit slug differing from the server binding → project plus conflict note", async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, ".rembric"), "PROJECT_SLUG=eps\n");
    const { fetchImpl } = stubResolve({
      ok: true,
      outcome: "explicit",
      conflict: { boundSlugs: ["zeta"] },
    });
    const result = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: "tok",
      fetchImpl,
    });
    expect(result.mode).toBe("project");
    expect(result.slug).toBe("eps");
    expect(result.conflict.boundSlugs).toEqual(["zeta"]);
    expect(result.message).toContain("bound to 'zeta'");
  });

  it("inside git with no token → refused/no_credentials and zero requests", async () => {
    const repo = gitRepo();
    const { calls, fetchImpl } = forbiddenFetch();
    const result = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: null,
      fetchImpl,
    });
    expect(result.mode).toBe("refused");
    expect(result.reason).toBe("no_credentials");
    expect(calls).toHaveLength(0);
  });

  it("repository with no commit → unbound/no_fingerprint with the no-commit remedy", async () => {
    const repo = gitRepo({ commit: false });
    const { fetchImpl } = stubResolve({ ok: true, outcome: "unbound", reason: "no_fingerprint" });
    const result = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: "tok",
      fetchImpl,
    });
    expect(result.mode).toBe("unbound");
    expect(result.reason).toBe("no_fingerprint");
    expect(result.message).toContain("no commit yet");
  });

  it("shallow clone → unbound/no_fingerprint with the shallow remedy", async () => {
    const src = gitRepo();
    const shallow = join(tempDir("shallow-parent"), "clone");
    execFileSync("git", ["clone", "--depth", "1", `file://${src}`, shallow]);
    const { fetchImpl } = stubResolve({ ok: true, outcome: "unbound", reason: "no_fingerprint" });
    const result = await resolveProject({
      startDir: shallow,
      env: {},
      serverUrl: SERVER_URL,
      apiToken: "tok",
      fetchImpl,
    });
    expect(result.mode).toBe("unbound");
    expect(result.reason).toBe("no_fingerprint");
    expect(result.message).toContain("shallow clone");
  });
});

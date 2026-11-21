// test/client-card.test.mjs — Ticket 16: the client half's built artifact and
// its settings-slot registration.
//
// Seams (per spec #14 — no DOM rendering; the visual layout is checked by
// hand against approved prototype variant B):
//  [A] Built bundle shape: executing client.js only REGISTERS a lazy factory
//      under the package name via window.__ModuleLoader__.load; nothing runs
//      until the factory is materialized, and externals (react) arrive through
//      the factory's own require.
//  [B] Package contract: exports["./client"], the published files list, and
//      the dsh.client declaration (web platform + settings-UI dependency).
//  [C] apply() registers the card into the plugins.bundle.config slot keyed
//      by the package name, and the card's element tree carries the approved
//      variant B copy — while writing nothing.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, it, expect, beforeAll } from "vite-plus/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

beforeAll(() => {
  // The build is part of the tested property: the repo's own build step must
  // turn the TypeScript source into the lazy-CJS artifact.
  execFileSync(process.execPath, [join(root, "scripts", "build-client.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
});

// ---- stubs -----------------------------------------------------------------

// Recording React: every createElement becomes a plain object the test can
// walk. The card must be a plain function component (no hooks) so calling it
// directly renders its element tree.
function makeReactStub() {
  const calls = [];
  function createElement(type, props, ...children) {
    const el = { type, props: props ?? {}, children: children.flat(Infinity) };
    calls.push(el);
    return el;
  }
  return { react: { createElement }, calls };
}

function textOf(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node && typeof node === "object" && Array.isArray(node.children)) {
    return node.children.map(textOf).join("");
  }
  return "";
}

// Materialize the built bundle against fake loader/require/ctx and return
// everything the test observes.
function materialize() {
  const bundle = readFileSync(join(root, "client.js"), "utf8");
  const stub = makeReactStub();
  const requireCalls = [];
  const fakeRequire = (id) => {
    requireCalls.push(id);
    if (id === "react") return stub.react;
    throw new Error(`client bundle required an unexpected module: ${id}`);
  };
  const loaded = [];
  const window = { __ModuleLoader__: { load: (def) => loaded.push(def) } };
  vm.runInNewContext(bundle, { window });
  const plugin = loaded[0].factory(fakeRequire);
  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject: (name, fn) => {
        injected.push(name);
        fn();
      },
      register: (opts, component) => {
        registered.push({ opts, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return { stub, requireCalls, loaded, injected, registered };
}

// ---- [A] built bundle: lazy-CJS loader format -------------------------------

describe("[A] built bundle: lazy-CJS loader format", () => {
  it("executing the bundle registers a factory under the package name without materializing it", () => {
    const bundle = readFileSync(join(root, "client.js"), "utf8");
    const loaded = [];
    let requireCalls = 0;
    const window = { __ModuleLoader__: { load: (def) => loaded.push(def) } };
    const fakeRequire = (id) => {
      requireCalls += 1;
      if (id === "react") return { createElement: () => null };
      throw new Error(`unexpected require: ${id}`);
    };
    vm.runInNewContext(bundle, { window });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(pkg.name);
    expect(typeof loaded[0].factory).toBe("function");
    // Lazy: registration alone must not run the plugin or require anything.
    expect(requireCalls).toBe(0);

    // Materializing runs the plugin body and pulls externals via the factory's require.
    const exports = loaded[0].factory(fakeRequire);
    expect(requireCalls).toBeGreaterThan(0);
    expect(exports.inject).toContain("slots");
    expect(typeof exports.apply).toBe("function");
  });

  it("is a single file in load() format with no ESM statements", () => {
    const bundle = readFileSync(join(root, "client.js"), "utf8");
    expect(bundle.trimStart().startsWith("window.__ModuleLoader__.load(")).toBe(true);
    expect(bundle).not.toMatch(/^import\s/m);
    expect(bundle).not.toMatch(/^export\s/m);
  });
});

// ---- [B] package contract ---------------------------------------------------

describe("[B] package contract", () => {
  it('serves the built client through the "./client" export', () => {
    expect(pkg.exports["./client"]).toBe("./client.js");
  });

  it("publishes the built artifact in the files list", () => {
    expect(pkg.files).toContain("client.js");
  });

  it("declares dsh.client for the web platform with the settings-UI dependency", () => {
    expect(pkg.dsh.client.platform).toBe("web");
    // The settings-UI dependency: the plugin-manager owns the configuration
    // slot the card registers into.
    expect(pkg.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-plugin-manager");
  });
});

// ---- [C] settings-slot registration and static card content -----------------

describe("[C] settings-slot registration and static card content", () => {
  it("registers the card into plugins.bundle.config keyed by the package name", () => {
    const { injected, registered } = materialize();
    expect(injected).toContain("plugins.bundle.config");
    expect(registered).toHaveLength(1);
    expect(registered[0].opts.name).toBe("plugins.bundle.config");
    expect(registered[0].opts.key).toBe(pkg.name);
    expect(typeof registered[0].component).toBe("function");
  });

  it("renders the approved variant B copy", () => {
    const { registered } = materialize();
    const tree = registered[0].component({ view: "page" });
    const text = textOf(tree);
    for (const s of [
      "Rembric Plugin",
      "Memories for the current workspace.",
      "Not connected",
      "Set the server URL and a token below, then save.",
      "Server",
      "Rembric server URL",
      "Where the plugin sends and looks up memory.",
      "Token",
      "API token",
      "Save",
    ]) {
      expect(text).toContain(s);
    }
    // The token hint verbatim from the ticket / prototype.
    expect(text).toContain(
      "Same token can also be set with /rembric-login <token> in the chat; both paths write the same reference.",
    );
  });

  it("keeps the token field write-only and the card writes nothing", () => {
    const { stub, registered } = materialize();
    // A form whose mutate throws: the static card must never touch it.
    const poisonForm = {
      state: {},
      mutate: () => {
        throw new Error("ticket 16 card must not write config");
      },
    };
    const tree = registered[0].component({ view: "page", form: poisonForm });
    const inputs = stub.calls.filter((el) => el.type === "input");
    const token = inputs.find((el) => el.props.type === "password");
    const server = inputs.find((el) => el.props.type === "text");
    expect(token).toBeTruthy();
    expect(server).toBeTruthy();
    // Write-only: the password field carries no value/defaultValue.
    expect(token.props.value).toBeUndefined();
    expect(token.props.defaultValue).toBeUndefined();
    // No save handler yet — saving is ticket 18.
    const buttons = stub.calls.filter((el) => el.type === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.onClick).toBeUndefined();
    // Nothing has been saved: no result mark rendered yet.
    const text = textOf(tree);
    expect(text).not.toContain("\u2713");
    expect(text).not.toContain("\u2715");
    expect(text).not.toContain("Validating");
  });
});

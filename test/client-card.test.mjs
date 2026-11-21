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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, it, expect, beforeAll } from "vite-plus/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The committed bytes, captured at import time — BEFORE the rebuild below
// overwrites them. The freshness test compares the build output against this.
const committedSha = createHash("sha256")
  .update(readFileSync(join(root, "client.js")))
  .digest("hex");

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
// walk. The live card uses hooks; the stub answers them so a direct call
// renders the INITIAL state: useState returns the initial value with a
// no-op setter, useEffect never runs (so no fetch or timer can fire),
// useCallback is the identity. Interaction itself is covered by the pure
// decide() tests and the route tests, not here.
function makeReactStub() {
  const calls = [];
  function createElement(type, props, ...children) {
    const el = { type, props: props ?? {}, children: children.flat(Infinity) };
    calls.push(el);
    return el;
  }
  const noop = () => {};
  const react = {
    createElement,
    useState: (init) => [typeof init === "function" ? init() : init, noop],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    useMemo: (fn) => fn(),
  };
  return { react, calls };
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
  it("the committed client.js is exactly what the build produces", () => {
    // The committed artifact is the install fallback (lifecycle scripts can
    // be blocked), so a stale or hand-edited committed copy must fail here
    // rather than be silently masked by the beforeAll rebuild.
    const builtSha = createHash("sha256")
      .update(readFileSync(join(root, "client.js")))
      .digest("hex");
    expect(builtSha, "committed client.js is stale; run vp run build:client").toBe(committedSha);
  });

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

  it("renders without touching a form it was not asked to write", () => {
    const { stub, registered } = materialize();
    // A form whose mutate throws: rendering must never call it. The card
    // writes only when the user presses Save.
    const poisonForm = {
      state: {},
      mutate: () => {
        throw new Error("card must not write config during render");
      },
    };
    const tree = registered[0].component({ view: "page", form: poisonForm });
    expect(textOf(tree)).toContain("Not connected");
    const buttons = stub.calls.filter((el) => el.type === "button");
    expect(buttons).toHaveLength(1);
  });

  it("keeps the token field write-only: it shows the draft, never a stored secret", () => {
    const { stub, registered } = materialize();
    // A form that carries a stored token in config — the card must not
    // surface it in the password field. The draft starts empty.
    const form = {
      state: {
        status: "ready",
        value: { serverUrl: "http://memory.test:8790", token: "leaked-tok-1" },
        revision: 7,
      },
      mutate: async () => true,
    };
    registered[0].component({ view: "page", form });
    const inputs = stub.calls.filter((el) => el.type === "input");
    const token = inputs.find((el) => el.props.type === "password");
    const server = inputs.find((el) => el.props.type === "text");
    expect(token).toBeTruthy();
    expect(server).toBeTruthy();
    // Write-only: the password field carries the (empty) draft, never a
    // stored value, and no defaultValue either.
    expect(token.props.value).toBe("");
    expect(token.props.defaultValue).toBeUndefined();
    expect(textOf({ children: [token] })).not.toContain("leaked-tok-1");
  });

  it("seeds the server field from the config form value", () => {
    const { stub, registered } = materialize();
    const form = {
      state: {
        status: "ready",
        value: { serverUrl: "http://memory.test:8790" },
        revision: 7,
      },
      mutate: async () => true,
    };
    registered[0].component({ view: "page", form });
    const server = stub.calls
      .filter((el) => el.type === "input")
      .find((el) => el.props.type === "text");
    expect(server.props.value).toBe("http://memory.test:8790");
  });

  it("wires the single Save button and starts idle", () => {
    const { stub, registered } = materialize();
    const tree = registered[0].component({ view: "page" });
    const buttons = stub.calls.filter((el) => el.type === "button");
    expect(buttons).toHaveLength(1);
    expect(typeof buttons[0].props.onClick).toBe("function");
    expect(buttons[0].props.disabled).toBeFalsy();
    // Nothing has been saved yet: no result mark rendered.
    const text = textOf(tree);
    expect(text).not.toContain("\u2713");
    expect(text).not.toContain("\u2715");
    expect(text).not.toContain("Validating");
  });
});

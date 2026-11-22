// test/client-card.test.mjs — the client half's built artifact and its
// settings-slot registration.
//
// No DOM rendering here; the visual layout is checked by hand in the harness:
//  [A] Built bundle shape: executing client.js only REGISTERS a lazy factory
//      under the package name via window.__ModuleLoader__.load; nothing runs
//      until the factory is materialized, and externals (react and the
//      automatic JSX runtime) arrive through the factory's own require.
//  [B] Package contract: exports["./client"], the published files list, and
//      the dsh.client declaration (web platform + settings-UI dependency).
//  [C] apply() registers the card into the plugins.bundle.config slot keyed
//      by the package name, and the card's element tree carries the expected
//      copy — while writing nothing.

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

// The bundle's externals, single-sourced here so both require fakes below
// answer the same list: the card is React and, being authored in JSX, the
// automatic runtime.
const EXTERNALS = new Set(["react", "react/jsx-runtime"]);

function makeFakeRequire(modules) {
  const calls = [];
  const require = (id) => {
    calls.push(id);
    if (!EXTERNALS.has(id) || !Object.hasOwn(modules, id)) {
      throw new Error(`client bundle required an unexpected module: ${id}`);
    }
    return modules[id];
  };
  return { require, calls };
}

// Recording React: every element becomes a plain object the test can walk.
// By default the hooks are inert, so a direct component call renders the
// INITIAL state: useState returns the initial value with a no-op setter,
// useEffect never runs, useCallback is the identity. That keeps the copy and
// registration tests deterministic. mount() swaps in the small hooks runtime
// below for the interaction tests, where effects and rerenders are needed.
// The card is authored in JSX on the automatic runtime, so the stub answers
// "react/jsx-runtime" with jsx/jsxs/Fragment and folds children into the same
// shape createElement produced.
function makeReactStub() {
  const calls = [];
  function createElement(type, props, ...children) {
    const el = { type, props: props ?? {}, children: children.flat(Infinity) };
    calls.push(el);
    return el;
  }
  function jsx(type, props, key) {
    const next = { ...props };
    if (key !== undefined) next.key = key;
    const children = "children" in next ? next.children : undefined;
    delete next.children;
    return createElement(
      type,
      next,
      ...(Array.isArray(children) ? children : children === undefined ? [] : [children]),
    );
  }
  const noop = () => {};
  let hooks = null;
  const react = {
    createElement,
    useState: (init) =>
      hooks ? hooks.useState(init) : [typeof init === "function" ? init() : init, noop],
    useEffect: (...args) => (hooks ? hooks.useEffect(...args) : undefined),
    useCallback: (fn) => (hooks ? hooks.useCallback(fn) : fn),
    useRef: (init) => (hooks ? hooks.useRef(init) : { current: init }),
    useMemo: (fn) => (hooks ? hooks.useMemo(fn) : fn()),
  };
  const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol.for("react.fragment") };
  return {
    react,
    jsxRuntime,
    calls,
    setHooks(next) {
      hooks = next;
    },
  };
}

// A tiny hooks runtime for one card instance: slot storage, dependency-aware
// effects, and a flush() that runs effects, drains their asynchronous work
// (the injected fetch resolves immediately), and rerenders until stable. It
// is not a React clone; it is only as much as the card's mount/save paths use.
function createHooksRuntime(component, props) {
  const states = [];
  const refs = [];
  const effectSlots = [];
  const queuedEffects = [];
  let hookIndex = 0;
  let dirty = false;
  let element = null;

  const hooks = {
    useState(init) {
      const index = hookIndex++;
      if (!Object.hasOwn(states, index)) {
        states[index] = typeof init === "function" ? init() : init;
      }
      const setState = (next) => {
        const value = typeof next === "function" ? next(states[index]) : next;
        if (Object.is(value, states[index])) return;
        states[index] = value;
        dirty = true;
      };
      return [states[index], setState];
    },
    useRef(init) {
      const index = hookIndex++;
      if (!Object.hasOwn(refs, index)) refs[index] = { current: init };
      return refs[index];
    },
    useCallback(fn) {
      hookIndex += 1;
      return fn;
    },
    useMemo(fn) {
      hookIndex += 1;
      return fn();
    },
    useEffect(fn, deps) {
      const index = hookIndex++;
      const previous = effectSlots[index];
      const sameDeps =
        previous !== undefined &&
        Array.isArray(deps) &&
        Array.isArray(previous.deps) &&
        deps.length === previous.deps.length &&
        deps.every((value, i) => Object.is(value, previous.deps[i]));
      if (sameDeps) return;
      effectSlots[index] = { deps, cleanup: null };
      queuedEffects.push({ index, fn });
    },
  };

  function render() {
    hookIndex = 0;
    dirty = false;
    element = component(props);
    return element;
  }

  async function flush() {
    for (let round = 0; round < 50; round += 1) {
      if (dirty) render();
      const pending = queuedEffects.splice(0);
      for (const effect of pending) {
        const slot = effectSlots[effect.index];
        if (slot?.cleanup) slot.cleanup();
        const cleanup = effect.fn();
        if (slot) slot.cleanup = typeof cleanup === "function" ? cleanup : null;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty && queuedEffects.length === 0 && pending.length === 0) return element;
    }
    throw new Error("card effects did not settle");
  }

  return {
    render,
    flush,
    hooks,
    element: () => element,
  };
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function inputById(tree, id) {
  return findNode(tree, (node) => node.type === "input" && node.props.id === id);
}

function buttonOf(tree) {
  return findNode(tree, (node) => node.type === "button");
}

function textOf(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node && typeof node === "object" && Array.isArray(node.children)) {
    return node.children.map(textOf).join("");
  }
  return "";
}

// A minimal document: enough for apply() to create, tag, append, and remove
// its one style element. No DOM implementation is involved.
function makeFakeDocument() {
  const styles = [];
  const head = {
    append(node) {
      styles.push(node);
    },
  };
  const document = {
    head,
    createElement: (type) => ({
      type,
      dataset: {},
      textContent: "",
      remove() {
        const index = styles.indexOf(this);
        if (index !== -1) styles.splice(index, 1);
      },
    }),
  };
  return { document, styles };
}

// Materialize the built bundle against fake loader/require/ctx and return
// everything the test observes. A document is passed into the bundle's realm
// only when a test asks for it, so the default also covers the no-document
// case. options.fetch becomes the realm's global fetch for interaction tests.
// With `withEffect`, the fake ctx records the cleanup disposers apply()
// registers through ctx.effect. mount() renders the registered card with the
// live hooks runtime and returns it; tests then call flush() and read
// element().
function materialize(options = {}) {
  const bundle = readFileSync(join(root, "client.js"), "utf8");
  const stub = makeReactStub();
  const { require: fakeRequire, calls: requireCalls } = makeFakeRequire({
    react: stub.react,
    "react/jsx-runtime": stub.jsxRuntime,
  });
  const loaded = [];
  const window = { __ModuleLoader__: { load: (def) => loaded.push(def) } };
  const realm = { window };
  if (options.document !== undefined) realm.document = options.document;
  if (options.fetch !== undefined) realm.fetch = options.fetch;
  vm.runInNewContext(bundle, realm);
  const plugin = loaded[0].factory(fakeRequire);
  const injected = [];
  const registered = [];
  const disposers = [];
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
  if (options.withEffect) {
    ctx.effect = (execute) => {
      disposers.push(execute());
    };
  }
  plugin.apply(ctx);
  function mount(props = { view: "page" }) {
    const component = registered[0]?.component;
    if (typeof component !== "function") throw new Error("the card was not registered");
    const runtime = createHooksRuntime(component, props);
    stub.setHooks(runtime.hooks);
    runtime.render();
    return runtime;
  }
  return { stub, requireCalls, loaded, injected, registered, disposers, mount };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
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
    const window = { __ModuleLoader__: { load: (def) => loaded.push(def) } };
    const { require: fakeRequire, calls: requireCalls } = makeFakeRequire({
      react: { createElement: () => null },
      "react/jsx-runtime": {
        jsx: () => null,
        jsxs: () => null,
        Fragment: Symbol.for("react.fragment"),
      },
    });
    vm.runInNewContext(bundle, { window });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(pkg.name);
    expect(typeof loaded[0].factory).toBe("function");
    // Lazy: registration alone must not run the plugin or require anything.
    expect(requireCalls).toHaveLength(0);

    // Materializing runs the plugin body and pulls externals via the factory's require.
    const exports = loaded[0].factory(fakeRequire);
    expect(requireCalls.length).toBeGreaterThan(0);
    expect(exports.inject).toContain("slots");
    expect(typeof exports.apply).toBe("function");
  });

  it("is a single file in load() format with no ESM statements", () => {
    const bundle = readFileSync(join(root, "client.js"), "utf8");
    expect(bundle.trimStart().startsWith("window.__ModuleLoader__.load(")).toBe(true);
    expect(bundle).not.toMatch(/^import\s/m);
    expect(bundle).not.toMatch(/^export\s/m);
  });

  it("materializes through the automatic JSX runtime", () => {
    // A revert to createElement calls would stop requiring the runtime and
    // pass every other rendering assertion, so pin the require itself.
    const { requireCalls } = materialize();
    expect(requireCalls).toContain("react/jsx-runtime");
  });

  it("embeds the card stylesheet text in the bundle", () => {
    const bundle = readFileSync(join(root, "client.js"), "utf8");
    // The bundler reformats the stylesheet, so pin a selector from each area
    // of the card plus stored values, not the source's exact bytes.
    for (const fragment of [
      ".rembric-card {",
      ".rembric-card .rc-head h1 {",
      ".rembric-card .rc-dot-err {",
      "--line: #242c3a",
      "background: var(--err)",
    ]) {
      expect(bundle).toContain(fragment);
    }
  });

  it("keeps the stylesheet in card.css, not in the card component", () => {
    const css = readFileSync(join(root, "client", "src", "card.css"), "utf8");
    expect(css).toContain(".rembric-card {");
    const card = readFileSync(join(root, "client", "src", "card.tsx"), "utf8");
    expect(card).not.toContain(".rembric-card");
    expect(card).not.toContain("--line");
    expect(card).not.toContain("<style>");
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

  it("renders the card copy", () => {
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
    // The full token hint text.
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

  it("prefills the server field from the host config route, not from props.form", async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if ((init.method ?? "GET") === "GET") {
        return jsonResponse(200, {
          serverUrl: "http://memory.test:8790",
          tokenSource: "env",
          hasToken: true,
        });
      }
      return jsonResponse(200, { ok: false, kind: "no-token", message: "no token is configured" });
    };
    const { mount } = materialize({ fetch });
    // The decoy form would seed a different address if the card still read it.
    const card = mount({
      view: "page",
      form: {
        state: { value: { serverUrl: "http://stale.test:8790" } },
        mutate: async () => true,
      },
    });
    await card.flush();
    expect(inputById(card.element(), "rembric-server-input").props.value).toBe(
      "http://memory.test:8790",
    );
    expect(calls[0]).toEqual({ url: "/plugins/rembric/config", method: "GET" });
  });

  it("saves the address through POST config and then verifies it, with no form prop", async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method, body: init.body });
      if (method === "GET") {
        return jsonResponse(200, {
          serverUrl: "http://old.test:8790",
          tokenSource: "none",
          hasToken: false,
        });
      }
      if (url === "/plugins/rembric/config") {
        return jsonResponse(200, { ok: true, serverUrl: "http://new.test:8790" });
      }
      return jsonResponse(200, { ok: true, tokenSource: "store" });
    };
    const { mount } = materialize({ fetch });
    const card = mount();
    await card.flush();
    inputById(card.element(), "rembric-server-input").props.onChange({
      target: { value: "http://new.test:8790" },
    });
    await card.flush();
    buttonOf(card.element()).props.onClick();
    await card.flush();

    const configPosts = calls.filter(
      (call) => call.url === "/plugins/rembric/config" && call.method === "POST",
    );
    expect(configPosts).toHaveLength(1);
    expect(JSON.parse(configPosts[0].body)).toEqual({ serverUrl: "http://new.test:8790" });

    const verifyPosts = calls.filter(
      (call) => call.url === "/plugins/rembric/verify" && call.method === "POST",
    );
    // The first verify is the silent mount probe for the old address; the
    // last is the Save check for the new one.
    expect(JSON.parse(verifyPosts.at(-1).body)).toEqual({ serverUrl: "http://new.test:8790" });

    const text = textOf(card.element());
    expect(text).toContain("Connected");
    expect(text).toContain("Token is valid");
    expect(inputById(card.element(), "rembric-server-input").props.value).toBe(
      "http://new.test:8790",
    );
  });

  it("highlights the server field for an invalid address and saves nothing", async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if ((init.method ?? "GET") === "GET") {
        return jsonResponse(200, {
          serverUrl: "http://old.test:8790",
          tokenSource: "none",
          hasToken: false,
        });
      }
      return jsonResponse(200, { ok: true, tokenSource: "store" });
    };
    const { mount } = materialize({ fetch });
    const card = mount();
    await card.flush();
    inputById(card.element(), "rembric-server-input").props.onChange({
      target: { value: "not a url" },
    });
    await card.flush();
    buttonOf(card.element()).props.onClick();
    await card.flush();

    expect(
      calls.filter((call) => call.url === "/plugins/rembric/config" && call.method === "POST"),
    ).toHaveLength(0);
    const text = textOf(card.element());
    expect(text).toContain("That is not a URL");
    expect(text).toContain("Not connected");
  });

  it("shows the config route's 501 message on the server field and does not verify", async () => {
    const calls = [];
    const fetch = async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method });
      if (method === "GET") {
        return jsonResponse(200, { serverUrl: "", tokenSource: "none", hasToken: false });
      }
      if (url === "/plugins/rembric/config") {
        return jsonResponse(501, {
          error: "the host has no configuration editor, so the server URL cannot be saved",
        });
      }
      return jsonResponse(200, { ok: true, tokenSource: "store" });
    };
    const { mount } = materialize({ fetch });
    const card = mount();
    await card.flush();
    inputById(card.element(), "rembric-server-input").props.onChange({
      target: { value: "http://memory.test:8790" },
    });
    await card.flush();
    buttonOf(card.element()).props.onClick();
    await card.flush();

    expect(
      calls.filter((call) => call.url === "/plugins/rembric/verify" && call.method === "POST"),
    ).toHaveLength(0);
    expect(textOf(card.element())).toContain(
      "the host has no configuration editor, so the server URL cannot be saved",
    );
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

  it("renders no <style> element: apply() owns the stylesheet", () => {
    const { stub, registered } = materialize();
    registered[0].component({ view: "page" });
    expect(stub.calls.filter((el) => el.type === "style")).toHaveLength(0);
  });

  it("injects one tagged <style> through ctx.effect and removes it on cleanup", () => {
    const { document, styles } = makeFakeDocument();
    const { disposers } = materialize({ document, withEffect: true });
    expect(styles).toHaveLength(1);
    expect(styles[0].dataset.plugin).toBe("dsh-rembric-plugin");
    expect(styles[0].dataset.pluginCss).toBe("dsh-rembric-plugin/card");
    expect(styles[0].textContent).toContain(".rembric-card");
    // The tag's lifetime is tied to the fiber: cleanup is the effect disposer.
    expect(disposers).toHaveLength(1);
    disposers[0]();
    expect(styles).toHaveLength(0);
  });

  it("appends the style directly when ctx has no effect", () => {
    const { document, styles } = makeFakeDocument();
    expect(() => materialize({ document })).not.toThrow();
    expect(styles).toHaveLength(1);
  });

  it("skips style injection and still registers the card without a document", () => {
    const { injected, registered } = materialize();
    expect(injected).toContain("plugins.bundle.config");
    expect(registered).toHaveLength(1);
  });
});

import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    // CJS with React left external: the harness shell resolves both through
    // the factory's require against its frozen module table.
    format: ["cjs"],
    platform: "neutral",
    dts: false,
    deps: { neverBundle: ["react", "react/jsx-runtime"] },
  },
  fmt: {},
  test: {
    // Vitest's default include also matches dot-directories, so any checkout
    // that carries .worktrees/ or a stray package store ran duplicate copies
    // of the suite. Tests live only in test/; keep every other tree out.
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
  lint: {
    // Generated lazy-CJS bundle (scripts/build-client.mjs); linting it is
    // pointless and formatting would break build byte-equality.
    ignorePatterns: ["client.js"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});

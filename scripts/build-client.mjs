// scripts/build-client.mjs — build the client half into the harness's lazy-CJS
// loader format, as one file at the repo root: client.js.
//
// The harness shell evaluates the file and the only thing it does is register
// a factory:
//
//   window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => { ... } })
//
// Materializing the factory runs the plugin body; externals (react) resolve
// through the factory's own require against the shell's frozen module table.
// The harness's own client bundling preset is not published, so this script
// reproduces the format with vp pack (CJS) plus the wrapper below.
//
// Reproducible from a clean checkout: `pnpm install` runs it through the
// package "prepare" script, and the test suite rebuilds before asserting.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const vp = join(root, "node_modules", ".bin", "vp");

const outDir = mkdtempSync(join(tmpdir(), "rembric-client-build-"));
try {
  execFileSync(
    vp,
    [
      "pack",
      "client/src/index.ts",
      "--format",
      "cjs",
      "--out-dir",
      outDir,
      "--no-config",
      "--platform",
      "neutral",
      "--deps.never-bundle",
      "react",
      "--no-dts",
    ],
    { cwd: root, stdio: "pipe" },
  );
  const cjs = readFileSync(join(outDir, "index.cjs"), "utf8");
  const bundle =
    "window.__ModuleLoader__.load({id:" +
    JSON.stringify(pkg.name) +
    ",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n" +
    cjs +
    "\nreturn module.exports;}});\n";
  writeFileSync(join(root, "client.js"), bundle);
  console.log("built client.js (" + bundle.length + " bytes)");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

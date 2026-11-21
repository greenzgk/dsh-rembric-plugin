// client/src/index.ts — the client half of the Rembric plugin (ticket #16).
//
// The harness materializes this module inside its browser shell through the
// lazy-CJS loader: the built bundle registers a factory under the package
// name via window.__ModuleLoader__.load, and the factory's require resolves
// externals (react) against the shell's frozen module table. See
// scripts/build-client.mjs for the wrapper.
//
// Shape expected by the client runner: exports with an apply(ctx) method or
// function, plus the inject list of shell modules this half needs.
import type { ReactNode } from "react";

import { RembricSettingsCard } from "./card";

/** The keyed configuration slot the Plugins page dispatches to this bundle. */
interface BundleConfigSlot {
  inject(name: "plugins.bundle.config", register: () => void): void;
  register(
    opts: { name: "plugins.bundle.config"; key: string },
    component: (props: { view: "summary" | "page"; form?: unknown }) => ReactNode,
  ): () => void;
}

/** The slice of the client context this half uses. */
interface RembricClientContext {
  slots: BundleConfigSlot;
}

/** Shell modules this half needs; "slots" is the UI slot registry. */
export const inject = ["slots"];

/**
 * Register the static variant B card into the bundle's configuration slot,
 * keyed by this package's name so the Plugins page renders it on our page.
 */
export function apply(ctx: RembricClientContext): void {
  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register(
      { name: "plugins.bundle.config", key: "dsh-rembric-plugin" },
      RembricSettingsCard,
    ),
  );
}

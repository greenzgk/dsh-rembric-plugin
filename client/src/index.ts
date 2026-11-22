// The client half of the Rembric plugin.
//
// The harness materializes this module inside its browser shell through the
// lazy-CJS loader: the built bundle registers a factory under the package
// name via window.__ModuleLoader__.load, and the factory's require resolves
// externals (react and react/jsx-runtime) against the shell's frozen module
// table. See scripts/build-client.mjs for the wrapper.
//
// Shape expected by the client runner: exports with an apply(ctx) method or
// function, plus the inject list of shell modules this half needs.
import type { ReactNode } from "react";

import { RembricSettingsCard } from "./card";
import cardCss from "./card.css?inline";

/** The keyed configuration slot the Plugins page dispatches to this bundle. */
interface BundleConfigSlot {
  inject(name: "plugins.bundle.config", register: () => void): void;
  register(
    opts: { name: "plugins.bundle.config"; key: string },
    component: (props: { view: "summary" | "page" }) => ReactNode,
  ): () => void;
}

/** The slice of the client context this half uses. */
interface RembricClientContext {
  slots: BundleConfigSlot;
  /**
   * Cordis's disposable-effect hook. It is absent from a bare harness
   * context, which is why its absence must not break apply.
   */
  effect?: (execute: () => () => void, label?: string) => unknown;
}

/** The plugin id stamped on the injected style element. */
const PLUGIN_ID = "dsh-rembric-plugin";

/** Stable key the client module system uses to identify the card stylesheet. */
const CARD_CSS_KEY = "dsh-rembric-plugin/card";

/**
 * Add the card stylesheet as one tagged <style>. The returned disposer is the
 * teardown: the client module system removes the tag when the plugin is
 * disabled.
 */
function appendCardStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = CARD_CSS_KEY;
  style.textContent = cardCss;
  document.head.append(style);
  return () => style.remove();
}

/**
 * Install the stylesheet once for the plugin's lifetime. Without a document
 * there is nothing to style; without ctx.effect the tag is appended directly
 * and left in place, so apply still cannot fail.
 */
function installCardStyles(ctx: RembricClientContext): void {
  if (typeof document === "undefined") return;
  if (typeof ctx.effect === "function") {
    ctx.effect(appendCardStyles, "rembric: card styles");
    return;
  }
  appendCardStyles();
}

/** Shell modules this half needs; "slots" is the UI slot registry. */
export const inject = ["slots"];

/**
 * Register the settings card into the bundle's configuration slot, keyed by
 * this package's name so the Plugins page renders it on our page.
 */
export function apply(ctx: RembricClientContext): void {
  installCardStyles(ctx);
  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register({ name: "plugins.bundle.config", key: PLUGIN_ID }, RembricSettingsCard),
  );
}

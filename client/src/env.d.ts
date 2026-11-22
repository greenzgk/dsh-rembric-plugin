/**
 * Vite's `?inline` suffix inlines a stylesheet as its text. The lazy-CJS
 * client build needs exactly that: one JS bundle, no .css side asset.
 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}

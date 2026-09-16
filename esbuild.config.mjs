import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "node:module";
import { fileURLToPath } from "node:url";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  // Inline bundled fonts as base64 data URLs so they travel inside main.js.
  // BRAT only delivers main.js + manifest.json + styles.css, so a loose
  // fonts/ folder never reaches testers — 3C mode would fall back to default
  // fonts. Embedding makes the @font-face sources self-contained.
  loader: { ".ttf": "dataurl" },
  // jszip's async scheduling comes from two IE-era polyfills that build a
  // <script> element on a branch no modern engine takes. Obsidian's release
  // scanner reads that statically and fails the plugin, so they're swapped for
  // shims over queueMicrotask/MessageChannel.
  // jszip's `browser` field points at a prebuilt dist with the polyfills baked
  // in, where the aliases can't reach them; its lib entry requires them by name.
  alias: {
    jszip: fileURLToPath(new URL("node_modules/jszip/lib/index.js", import.meta.url)),
    immediate: fileURLToPath(new URL("shims/immediate.js", import.meta.url)),
    setimmediate: fileURLToPath(new URL("shims/setimmediate.js", import.meta.url)),
    "readable-stream": fileURLToPath(new URL("shims/readable-stream.js", import.meta.url)),
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}

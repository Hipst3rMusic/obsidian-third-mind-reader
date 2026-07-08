import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "node:module";

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
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}

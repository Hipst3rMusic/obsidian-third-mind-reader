import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "esbuild.config.mjs", "fonts/**"] },
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
	},
	{
		// Sole exception: injectBundledFonts() must attach a runtime <style>
		// element because the @font-face data-URLs are compiled into main.js
		// (esbuild dataurl loader) and can't live in styles.css. The plugin
		// forbids inline eslint-disable for this rule, so it's scoped off here.
		files: ["main.ts"],
		rules: { "obsidianmd/no-forbidden-elements": "off" },
	},
]);

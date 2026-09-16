import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default defineConfig([
	// `scripts/` holds build tooling that runs under Node, not plugin code that
	// ships to users — console output there is the point, so the Obsidian plugin
	// rules (no-console chief among them) don't apply. Same reasoning as
	// esbuild.config.mjs above it.
	{ ignores: ["main.js", "node_modules/**", "esbuild.config.mjs", "scripts/**", "fonts/**"] },
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
		rules: {
			// Each list replaces the rule's built-in one rather than extending it,
			// so the defaults must be spread back in.
			"obsidianmd/ui/sentence-case": ["warn", {
				brands: [...DEFAULT_BRANDS, "Third Mind Reader", "LM Studio", "Ollama", "OpenRouter", "Apple Books"],
				acronyms: [...DEFAULT_ACRONYMS, "3C"],
				ignoreWords: ["EPUBs", "PDFs"],
				// Literal model IDs contain brand names the rule would capitalise.
				ignoreRegex: ["claude-haiku-4-5-20251001"],
			}],
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

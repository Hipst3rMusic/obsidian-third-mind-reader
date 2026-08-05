/**
 * Stage a mobile-installable copy of the plugin at the vault root.
 *
 * Copies only the three files Obsidian actually loads — deliberately NOT
 * data.json, which is per-vault state (API keys, reading positions, library
 * overrides) and would clobber the target vault's on drag-and-drop.
 *
 * The staged manifest gets `isDesktopOnly: false` so mobile will load it; the
 * repo's manifest stays `true` until the mobile beta ships (Phase E).
 *
 * The inner folder is named for the plugin id so the dragged folder matches
 * what Obsidian expects, even though it keys off manifest.id rather than the
 * folder name.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = resolve(pluginDir, "../../..");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
const stageDir = join(vaultRoot, "Third Mind Reader Mobile", manifest.id);

mkdirSync(stageDir, { recursive: true });
for (const file of ["main.js", "styles.css"]) {
	copyFileSync(join(pluginDir, file), join(stageDir, file));
}
writeFileSync(
	join(stageDir, "manifest.json"),
	JSON.stringify({ ...manifest, isDesktopOnly: false }, null, 2) + "\n",
);

console.log(`Staged ${manifest.id} ${manifest.version} (isDesktopOnly: false) → ${stageDir}`);

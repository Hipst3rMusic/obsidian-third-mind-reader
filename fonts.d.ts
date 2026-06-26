// Font files are imported via esbuild's `dataurl` loader (esbuild.config.mjs):
// each import resolves to a `data:font/ttf;base64,...` string baked into main.js,
// so the bundled fonts ship with the plugin (BRAT only delivers main.js +
// manifest.json + styles.css — a loose fonts/ folder never reaches testers).
declare module "*.ttf" {
	const dataUrl: string;
	export default dataUrl;
}

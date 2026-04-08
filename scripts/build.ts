import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? process.cwd(), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

await Bun.build({
	entrypoints: ["src/index.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	naming: "index.js",
	define: {
		__MODAL_SDK_VERSION__: JSON.stringify(pkg.version),
	},
});

await Bun.build({
	entrypoints: ["src/index.ts"],
	outdir: "dist",
	target: "node",
	format: "cjs",
	naming: "index.cjs",
	define: {
		__MODAL_SDK_VERSION__: JSON.stringify(pkg.version),
	},
});

execSync("tsc -p tsconfig.build.json", { cwd: root, stdio: "inherit" });

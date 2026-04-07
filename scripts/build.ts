import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname!, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

const shared = {
	entryPoints: ["src/index.ts"],
	bundle: true,
	platform: "node" as const,
	define: {
		__MODAL_SDK_VERSION__: JSON.stringify(pkg.version),
	},
};

await build({ ...shared, format: "esm", outfile: "dist/index.js" });
await build({ ...shared, format: "cjs", outfile: "dist/index.cjs" });

execSync("tsc -p tsconfig.build.json", { cwd: root, stdio: "inherit" });

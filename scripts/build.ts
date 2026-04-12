import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname ?? process.cwd(), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

const external = [
	...Object.keys(pkg.dependencies ?? {}),
	...Object.keys(pkg.peerDependencies ?? {}),
];

writeFileSync(
	join(root, "src/utils/version.ts"),
	`export const SDK_VERSION = ${JSON.stringify(pkg.version)};\n`,
);

const shared = {
	entryPoints: ["src/index.ts"],
	bundle: true,
	platform: "node" as const,
	external,
};

await Promise.all([
	build({ ...shared, format: "esm", outfile: "dist/index.js" }),
	build({ ...shared, format: "cjs", outfile: "dist/index.cjs" }),
]);

execSync("tsc -p tsconfig.build.json", { cwd: root, stdio: "inherit" });

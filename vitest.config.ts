import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(
	readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
);

export default defineConfig({
	define: {
		__MODAL_SDK_VERSION__: JSON.stringify(pkg.version),
	},
	test: {
		maxConcurrency: 10,
		slowTestThreshold: 5000,
		testTimeout: 20000,
		reporters: ["verbose"],
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			modal: path.resolve(__dirname, "./src/index.ts"),
		},
	},
});

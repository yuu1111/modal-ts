import path from "node:path";
import { defineConfig } from "vitest/config";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
	test: {
		maxConcurrency: 10,
		slowTestThreshold: 5000,
		testTimeout: 20000,
		reporters: ["verbose"],
	},
	resolve: {
		alias: {
			modal: path.resolve(__dirname, "./src/index.ts"),
		},
	},
	define: {
		__MODAL_SDK_VERSION__: JSON.stringify(packageJson.version),
	},
});

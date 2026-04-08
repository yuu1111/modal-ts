import { homedir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { configFilePath } from "../src/config";

const originalConfigPath = process.env.MODAL_CONFIG_PATH;

afterEach(() => {
	if (originalConfigPath === undefined) {
		delete process.env.MODAL_CONFIG_PATH;
	} else {
		process.env.MODAL_CONFIG_PATH = originalConfigPath;
	}
});

test("GetConfigPath_WithEnvVar", () => {
	const customPath = "/custom/path/to/config.toml";
	process.env.MODAL_CONFIG_PATH = customPath;

	const result = configFilePath();
	expect(result).toBe(customPath);
});

test("GetConfigPath_WithoutEnvVar", () => {
	delete process.env.MODAL_CONFIG_PATH;

	const result = configFilePath();
	const expectedPath = path.join(homedir(), ".modal.toml");
	expect(result).toBe(expectedPath);
});

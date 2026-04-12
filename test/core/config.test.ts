import { homedir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configFilePath } from "../../src/core/config";

afterEach(() => {
	vi.unstubAllEnvs();
});

test("GetConfigPath_WithEnvVar", () => {
	const customPath = "/custom/path/to/config.toml";
	vi.stubEnv("MODAL_CONFIG_PATH", customPath);

	const result = configFilePath();
	expect(result).toBe(customPath);
});

test("GetConfigPath_WithoutEnvVar", () => {
	vi.stubEnv("MODAL_CONFIG_PATH", "");

	const result = configFilePath();
	const expectedPath = path.join(homedir(), ".modal.toml");
	expect(result).toBe(expectedPath);
});

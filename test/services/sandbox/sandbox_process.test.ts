import { expect, test } from "vitest";
import { ContainerProcess } from "../../../src/services/sandbox/sandbox_process";

test("ContainerProcess poll caches returncode", async () => {
	const commandRouterClient = {
		execPoll: async () => ({ code: 7 }),
		execWait: async () => {
			throw new Error("wait should not be called after poll completed");
		},
		execStdinWrite: async () => ({}),
		execStdioRead: async function* () {},
	};
	const process = new ContainerProcess(
		"ta-1",
		"exec-1",
		commandRouterClient as never,
	);

	await expect(process.poll()).resolves.toBe(7);
	expect(process.returncode).toBe(7);
	await expect(process.wait()).resolves.toBe(7);
});

test("ContainerProcess returncode requires completion", () => {
	const commandRouterClient = {
		execPoll: async () => ({}),
		execWait: async () => ({ signal: 9 }),
		execStdinWrite: async () => ({}),
		execStdioRead: async function* () {},
	};
	const process = new ContainerProcess(
		"ta-1",
		"exec-1",
		commandRouterClient as never,
	);

	expect(() => process.returncode).toThrow("You must call wait()");
});

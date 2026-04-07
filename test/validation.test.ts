import { expect, test } from "vitest";
import type { ModalClientParams } from "../src/client";
import type { ClsWithOptionsParams } from "../src/cls";
import { checkForRenamedParams } from "../src/validation";
import { createMockModalClients } from "./support/grpc_mock";

test("checkForRenamedParams", () => {
	expect(() =>
		checkForRenamedParams({ timeout: 5000 }, { timeout: "timeoutMs" }),
	).toThrow("Parameter 'timeout' has been renamed to 'timeoutMs'.");

	expect(() =>
		checkForRenamedParams({ timeoutMs: 5000 }, { timeout: "timeoutMs" }),
	).not.toThrow();

	expect(() =>
		checkForRenamedParams(null, { timeout: "timeoutMs" }),
	).not.toThrow();

	expect(() =>
		checkForRenamedParams(undefined, { timeout: "timeoutMs" }),
	).not.toThrow();

	expect(() =>
		checkForRenamedParams({}, { timeout: "timeoutMs" }),
	).not.toThrow();
});

test("ModalClient constructor rejects old 'timeout' parameter", async () => {
	const { ModalClient } = await import("modal");

	expect(
		() => new ModalClient({ timeout: 5000 } as unknown as ModalClientParams),
	).toThrow("Parameter 'timeout' has been renamed to 'timeoutMs'.");
});

test("Cls.withOptions rejects old parameter names", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (_: unknown) => ({
		functionId: "fid",
		handleMetadata: {
			methodHandleMetadata: { echo_string: {} },
			classParameterInfo: { schema: [] },
		},
	}));

	const cls = await mc.cls.fromName("libmodal-test-support", "EchoCls");

	await expect(
		cls
			.withOptions({ timeout: 5000 } as unknown as ClsWithOptionsParams)
			.instance(),
	).rejects.toThrow("Parameter 'timeout' has been renamed to 'timeoutMs'.");

	await expect(
		cls
			.withOptions({ memory: 512 } as unknown as ClsWithOptionsParams)
			.instance(),
	).rejects.toThrow("Parameter 'memory' has been renamed to 'memoryMiB'.");

	await expect(
		cls
			.withOptions({ memoryLimit: 1024 } as unknown as ClsWithOptionsParams)
			.instance(),
	).rejects.toThrow(
		"Parameter 'memoryLimit' has been renamed to 'memoryLimitMiB'.",
	);
});

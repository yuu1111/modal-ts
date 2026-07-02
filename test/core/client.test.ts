import { ModalClient, NotFoundError } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test } from "vitest";
import { createMockModalClients } from "../support/grpc_mock";

test("ModalClient with custom middleware", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => {
		throw new ClientError("/FunctionGet", Status.NOT_FOUND, "not found");
	});

	await expect(
		mc.functions.fromName("test-app", "non-existent"),
	).rejects.toThrow(NotFoundError);

	mock.assertExhausted();

	// Verify the constructor accepts grpcMiddleware without error
	const mc2 = new ModalClient({
		tokenId: "test-token",
		tokenSecret: "test-secret",
		grpcMiddleware: [
			async function* (call, options) {
				return yield* call.next(call.request, options);
			},
		],
	});
	mc2.close();
});

test("ModalClient getImageBuilderVersion uses profile override", async () => {
	const mc = new ModalClient({
		tokenId: "test-token",
		tokenSecret: "test-secret",
		imageBuilderVersion: "2025.01",
	});

	await expect(mc.getImageBuilderVersion("prod")).resolves.toBe("2025.01");
	mc.close();
});

test("ModalClient getImageBuilderVersion fetches environment metadata", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/EnvironmentGetOrCreate", (req) => {
		expect(req).toMatchObject({ deploymentName: "prod" });
		return {
			environmentId: "env-1",
			metadata: {
				name: "prod",
				settings: { imageBuilderVersion: "2025.02" },
			},
		};
	});

	await expect(mc.getImageBuilderVersion("prod")).resolves.toBe("2025.02");
	mock.assertExhausted();
});

test("ModalClient Python-style static constructors and isClosed", async () => {
	const fromEnv = await ModalClient.from_env();
	expect(fromEnv).toBeInstanceOf(ModalClient);
	expect(fromEnv.is_closed()).toBe(false);
	fromEnv.close();
	expect(fromEnv.isClosed()).toBe(true);

	const fromCredentials = await ModalClient.fromCredentials(
		"ak-test",
		"as-test",
	);
	expect(fromCredentials.profile.tokenId).toBe("ak-test");
	expect(fromCredentials.profile.tokenSecret).toBe("as-test");
	fromCredentials.close();
});

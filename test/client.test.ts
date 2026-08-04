import { ModalClient } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test } from "vitest";
import { createMockModalClients } from "./support/grpc_mock";

test("ModalClient with custom middleware", async () => {
	// Verify that ModalClient correctly stores custom middleware.
	// The grpcMiddleware option is only applied when creating a real gRPC channel
	// (i.e., when cpClient is not injected). This test verifies the constructor
	// accepts the option without error, and that the client functions normally.
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => {
		throw new ClientError("/FunctionGet", Status.NOT_FOUND, "not found");
	});

	try {
		await mc.functions.fromName("test-app", "non-existent");
	} catch (_err) {
		// Expected: NotFoundError
	}

	mock.assertExhausted();

	// Also verify the constructor accepts grpcMiddleware without error
	const middlewareCalled = { value: false };
	const mc2 = new ModalClient({
		tokenId: "test-token",
		tokenSecret: "test-secret",
		grpcMiddleware: [
			async function* (call, options) {
				middlewareCalled.value = true;
				return yield* call.next(call.request, options);
			},
		],
	});
	mc2.close();
	expect(mc2).toBeDefined();
});

test("resolveImageBuilderVersion falls back to default without an environment", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	// No environment configured, so no RPC should be made.
	expect(await mc.resolveImageBuilderVersion()).toBe("2024.10");
	mock.assertExhausted();
});

test("resolveImageBuilderVersion uses the environment's actual version", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	(mc as { profile: { environment: string } }).profile.environment = "main";

	mock.handleUnary("/EnvironmentGetOrCreate", (req) => {
		expect(req).toMatchObject({ deploymentName: "main" });
		return {
			environmentId: "env-main",
			metadata: { name: "main", settings: { imageBuilderVersion: "2025.06" } },
		};
	});

	expect(await mc.resolveImageBuilderVersion()).toBe("2025.06");
	// Second call is served from cache, no extra RPC.
	expect(await mc.resolveImageBuilderVersion()).toBe("2025.06");
	mock.assertExhausted();
});

test("resolveImageBuilderVersion prefers the configured profile value", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	mc.profile.environment = "main";
	mc.profile.imageBuilderVersion = "2025.06";

	mock.handleUnary("/EnvironmentGetOrCreate", () => ({
		environmentId: "env-main",
		metadata: { name: "main", settings: { imageBuilderVersion: "2026.01" } },
	}));

	expect(await mc.resolveImageBuilderVersion()).toBe("2025.06");
	mock.assertExhausted();
});

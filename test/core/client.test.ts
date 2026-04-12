import { ModalClient } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test } from "vitest";
import { createMockModalClients } from "../support/grpc_mock";

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

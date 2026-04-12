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

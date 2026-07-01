import { interact } from "modal";
import { expect, test } from "vitest";
import { createMockModalClients } from "../support/grpc_mock";

test("interact starts PTY shell", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionStartPtyShell", (req) => {
		expect(req).toEqual({});
		return {};
	});

	await interact(mc);
	mock.assertExhausted();
});

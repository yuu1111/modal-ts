import { Function_, NotFoundError } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test, vi } from "vitest";
import type { ModalGrpcClient } from "../../src/client";
import { cborEncode } from "../../src/serialization";
import { createMockModalClients, MockGrpcClient } from "../support/grpc_mock";

const _mockFunctionProto = {
	functionId: "fid-echo",
	handleMetadata: {
		supportedInputFormats: [4],
	},
};

function mockRemoteCall(
	mock: ReturnType<typeof createMockModalClients>["mockCpClient"],
	expectedResult: unknown,
	options?: {
		functionCallId?: string;
		invocationType?: number;
	},
) {
	const fcId = options?.functionCallId ?? "fc-123";

	mock.handleUnary("FunctionMap", (req) => {
		if (options?.invocationType !== undefined) {
			expect(req.functionCallInvocationType).toBe(options.invocationType);
		}
		return {
			functionCallId: fcId,
			functionCallJwt: "jwt-test",
			pipelinedInputs: [{ inputJwt: "input-jwt-test" }],
		};
	});

	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return {
			outputs: [
				{
					result: {
						status: 1,
						data: cborEncode(expectedResult),
					},
					dataFormat: 4,
				},
			],
		};
	});
}

test("FunctionCall", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (req) => {
		expect(req).toMatchObject({
			appName: "modal-ts-test-support",
			objectTag: "echo_string",
		});
		return _mockFunctionProto;
	});

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"echo_string",
	);

	// kwargs call
	mockRemoteCall(mock, "output: hello");
	const resultKwargs = await function_.remote([], { s: "hello" });
	expect(resultKwargs).toBe("output: hello");

	// args call
	mockRemoteCall(mock, "output: hello");
	const resultArgs = await function_.remote(["hello"]);
	expect(resultArgs).toBe("output: hello");

	mock.assertExhausted();
});

test("FunctionCallLargeInput", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (_req) => {
		return {
			functionId: "fid-bytelength",
			handleMetadata: { supportedInputFormats: [4] },
		};
	});

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"bytelength",
	);

	const len = 3 * 1000 * 1000;
	const input = new Uint8Array(len);

	// Large input triggers blob upload via BlobCreate + fetch
	mock.handleUnary("BlobCreate", (req) => {
		expect(req.contentLength).toBe(cborEncode([[input], {}]).length);
		return { blobId: "blob-123", uploadUrl: "https://blob.test/upload" };
	});

	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(new Response(null, { status: 200 }));

	mock.handleUnary("FunctionMap", (req) => {
		// The input should reference the blob, not contain inline data
		const pipelined = (req.pipelinedInputs as Record<string, unknown>[])?.[0];
		const fnInput = pipelined?.input as Record<string, unknown>;
		expect(fnInput.argsBlobId).toBe("blob-123");
		return {
			functionCallId: "fc-large",
			functionCallJwt: "jwt-test",
			pipelinedInputs: [{ inputJwt: "input-jwt-test" }],
		};
	});

	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return {
			outputs: [
				{
					result: {
						status: 1,
						data: cborEncode(len),
					},
					dataFormat: 4,
				},
			],
		};
	});

	const result = await function_.remote([input]);
	expect(result).toBe(len);
	expect(fetchSpy).toHaveBeenCalledOnce();

	fetchSpy.mockRestore();
	mock.assertExhausted();
});

test("FunctionNotFound", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (_req) => {
		throw new ClientError(
			"/modal.client.ModalClient/FunctionGet",
			Status.NOT_FOUND,
			"Function not found",
		);
	});

	const promise = mc.functions.fromName(
		"modal-ts-test-support",
		"not_a_real_function",
	);
	await expect(promise).rejects.toThrowError(NotFoundError);

	mock.assertExhausted();
});

test("FunctionCallInputPlane", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	const ipMock = new MockGrpcClient();

	// Patch ipClient to return our input plane mock
	mc.ipClient = () => ipMock as unknown as ModalGrpcClient;

	mock.handleUnary("FunctionGet", (req) => {
		expect(req).toMatchObject({
			appName: "modal-ts-test-support",
			objectTag: "input_plane",
		});
		return {
			functionId: "fid-ip",
			handleMetadata: {
				supportedInputFormats: [4],
				inputPlaneUrl: "https://input-plane.test",
			},
		};
	});

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"input_plane",
	);

	// Input plane uses AttemptStart + AttemptAwait instead of FunctionMap + FunctionGetOutputs
	ipMock.handleUnary("AttemptStart", (_req) => {
		return { attemptToken: "attempt-token-123" };
	});

	ipMock.handleUnary("AttemptAwait", (_req) => {
		return {
			output: {
				result: {
					status: 1,
					data: cborEncode("output: hello"),
				},
				dataFormat: 4,
			},
		};
	});

	const result = await function_.remote(["hello"]);
	expect(result).toBe("output: hello");

	mock.assertExhausted();
	ipMock.assertExhausted();
});

test("FunctionGetCurrentStats", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGetCurrentStats", (req) => {
		expect(req).toMatchObject({ functionId: "fid-stats" });
		return { backlog: 3, numTotalTasks: 7 };
	});

	const function_ = new Function_(mc, "fid-stats");
	const stats = await function_.getCurrentStats();
	expect(stats).toEqual({ backlog: 3, numTotalRunners: 7 });

	mock.assertExhausted();
});

test("FunctionUpdateAutoscaler", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionUpdateSchedulingParams", (req) => {
		expect(req).toMatchObject({
			functionId: "fid-auto",
			settings: {
				minContainers: 1,
				maxContainers: 10,
				bufferContainers: 2,
				scaledownWindow: 300,
			},
		});
		return {};
	});

	const function_ = new Function_(mc, "fid-auto");
	await function_.updateAutoscaler({
		minContainers: 1,
		maxContainers: 10,
		bufferContainers: 2,
		scaledownWindowMs: 300 * 1000,
	});

	mock.handleUnary("/FunctionUpdateSchedulingParams", (req) => {
		expect(req).toMatchObject({
			functionId: "fid-auto",
			settings: { minContainers: 2 },
		});
		return {};
	});

	await function_.updateAutoscaler({ minContainers: 2 });

	mock.assertExhausted();
});

test("FunctionGetWebUrl", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (req) => {
		expect(req).toMatchObject({
			appName: "modal-ts-test-support",
			objectTag: "web_endpoint",
		});
		return {
			functionId: "fid-web",
			handleMetadata: { webUrl: "https://endpoint.internal" },
		};
	});

	const web_endpoint = await mc.functions.fromName(
		"modal-ts-test-support",
		"web_endpoint",
	);
	expect(await web_endpoint.getWebUrl()).toBe("https://endpoint.internal");

	mock.assertExhausted();
});

test("FunctionGetWebUrlOnNonWebFunction", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (req) => {
		expect(req).toMatchObject({
			appName: "modal-ts-test-support",
			objectTag: "echo_string",
		});
		return {
			functionId: "fid-echo-no-web",
			handleMetadata: { supportedInputFormats: [4] },
		};
	});

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"echo_string",
	);
	expect(await function_.getWebUrl()).toBeUndefined();

	mock.assertExhausted();
});

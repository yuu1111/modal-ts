import { InvalidError, NotFoundError } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test } from "vitest";
import {
	DataFormat,
	GenericResult_GenericStatus,
} from "../../../src/generated/modal_proto/api";
import { Function_ } from "../../../src/services/function/function";
import { cborEncode } from "../../../src/utils/serialization";
import { createMockModalClients } from "../../support/grpc_mock";

function makeFunctionGetResponse(overrides: Record<string, unknown> = {}) {
	return {
		functionId: "fn-123",
		handleMetadata: {
			functionName: "echo_string",
			definitionId: "def-123",
			supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
			supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
			...((overrides.handleMetadata as Record<string, unknown>) ?? {}),
		},
		...Object.fromEntries(
			Object.entries(overrides).filter(([k]) => k !== "handleMetadata"),
		),
	};
}

function makeSuccessOutput(value: unknown) {
	return {
		outputs: [
			{
				result: {
					status: GenericResult_GenericStatus.GENERIC_STATUS_SUCCESS,
					data: cborEncode(value),
				},
				dataFormat: DataFormat.DATA_FORMAT_CBOR,
			},
		],
	};
}

function mockFunctionInvocation(
	mock: ReturnType<typeof createMockModalClients>["mockCpClient"],
	result: unknown,
) {
	mock.handleUnary("/FunctionMap", () => ({
		functionCallId: "fc-mock-001",
		functionCallJwt: "jwt-mock",
		pipelinedInputs: [{ inputJwt: "input-jwt-mock" }],
	}));

	mock.handleUnary("/FunctionGetOutputs", () => makeSuccessOutput(result));
}

test("FunctionCall", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () =>
		makeFunctionGetResponse({
			handleMetadata: { functionName: "echo_string" },
		}),
	);

	mockFunctionInvocation(mock, "output: hello");

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"echo_string",
	);

	const resultKwargs = await function_.remote([], { s: "hello" });
	expect(resultKwargs).toBe("output: hello");

	mockFunctionInvocation(mock, "output: hello");

	const resultArgs = await function_.remote(["hello"]);
	expect(resultArgs).toBe("output: hello");

	mock.assertExhausted();
});

test("FunctionCallJsMap", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () =>
		makeFunctionGetResponse({
			handleMetadata: { functionName: "identity_with_repr" },
		}),
	);

	mockFunctionInvocation(mock, [{ a: "b" }, "{'a': 'b'}"]);

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"identity_with_repr",
	);

	const resultKwargs = await function_.remote([new Map([["a", "b"]])]);
	expect(resultKwargs).toStrictEqual([{ a: "b" }, "{'a': 'b'}"]);

	mock.assertExhausted();
});

test("FunctionCallDateTimeRoundtrip", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () =>
		makeFunctionGetResponse({
			handleMetadata: { functionName: "identity_with_repr" },
		}),
	);

	const testDate = new Date("2024-01-15T10:30:45.123Z");

	mockFunctionInvocation(mock, [testDate, "datetime.datetime(2024, 1, 15)"]);

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"identity_with_repr",
	);

	const result = await function_.remote([testDate]);

	expect(Array.isArray(result)).toBe(true);
	expect(result).toHaveLength(2);

	const [identityResult, reprResult] = result as [unknown, string];

	expect(reprResult).toContain("datetime.datetime");
	expect(reprResult).toContain("2024");

	expect(identityResult).toBeInstanceOf(Date);
	const receivedDate = identityResult as Date;

	const timeDiff = Math.abs(testDate.getTime() - receivedDate.getTime());

	expect(timeDiff).toBeLessThan(1);
	expect(receivedDate.getTime()).toBe(testDate.getTime());

	mock.assertExhausted();
});

test("FunctionCallLargeInput", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () =>
		makeFunctionGetResponse({
			handleMetadata: { functionName: "bytelength" },
		}),
	);

	const len = 3 * 1000 * 1000;

	// Large input triggers blob upload
	mock.handleUnary("/BlobCreate", () => ({
		blobId: "blob-mock-001",
		uploadUrl: "https://mock-blob-upload.test/upload",
	}));

	mockFunctionInvocation(mock, len);

	// Mock the fetch for blob upload
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (
			url === "https://mock-blob-upload.test/upload" &&
			init?.method === "PUT"
		) {
			return new Response(null, { status: 200 });
		}
		return originalFetch(input, init);
	};

	try {
		const function_ = await mc.functions.fromName(
			"modal-ts-test-support",
			"bytelength",
		);
		const input = new Uint8Array(len);
		const result = await function_.remote([input]);
		expect(result).toBe(len);
	} finally {
		globalThis.fetch = originalFetch;
	}

	mock.assertExhausted();
});

test("FunctionNotFound", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => {
		throw new ClientError("/FunctionGet", Status.NOT_FOUND, "not found");
	});

	const promise = mc.functions.fromName(
		"modal-ts-test-support",
		"not_a_real_function",
	);
	await expect(promise).rejects.toThrowError(NotFoundError);

	mock.assertExhausted();
});

test("FunctionCallInputPlane", async () => {
	// The mock system only supports cpClient, so we test the control plane path.
	// Input plane (AttemptStart/AttemptAwait) requires a separate ipClient mock.
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () =>
		makeFunctionGetResponse({
			handleMetadata: {
				functionName: "input_plane",
				supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
				supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
			},
		}),
	);

	mockFunctionInvocation(mock, "output: hello");

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"input_plane",
	);
	const result = await function_.remote(["hello"]);
	expect(result).toBe("output: hello");

	mock.assertExhausted();
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

	mock.handleUnary("/FunctionGet", () =>
		makeFunctionGetResponse({
			handleMetadata: {
				functionName: "echo_string",
				supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
			},
		}),
	);

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"echo_string",
	);
	expect(await function_.getWebUrl()).toBeUndefined();

	mock.assertExhausted();
});

test("FunctionFromNameWithDotNotation", async () => {
	const { mockClient: mc } = createMockModalClients();

	const promise = mc.functions.fromName(
		"modal-ts-test-support",
		"MyClass.myMethod",
	);
	await expect(promise).rejects.toThrowError(
		`Cannot retrieve Cls methods using 'functions.fromName()'. Use:\n  const cls = await client.cls.fromName("modal-ts-test-support", "MyClass");\n  const instance = await cls.instance();\n  const m = instance.method("myMethod");`,
	);
});

test("FunctionCallPreCborVersionError", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	// Pre-1.2 function only supports PICKLE, not CBOR
	mock.handleUnary("/FunctionGet", () => ({
		functionId: "fn-old",
		handleMetadata: {
			functionName: "identity_with_repr",
			supportedInputFormats: [DataFormat.DATA_FORMAT_PICKLE],
			supportedOutputFormats: [DataFormat.DATA_FORMAT_PICKLE],
		},
	}));

	const function_ = await mc.functions.fromName(
		"test-support-1-1",
		"identity_with_repr",
	);

	const promise = function_.remote([], { s: "hello" });
	await expect(promise).rejects.toThrowError(
		/Redeploy with Modal Python SDK >= 1.2/,
	);

	mock.assertExhausted();
});

test("WebEndpointRemoteCallError", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => ({
		functionId: "fn-web",
		handleMetadata: {
			functionName: "web_endpoint_echo",
			webUrl: "https://web-endpoint.mock.test",
			supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
		},
	}));

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"web_endpoint_echo",
	);

	const promise = function_.remote(["hello"]);
	await expect(promise).rejects.toThrowError(InvalidError);
	await expect(promise).rejects.toThrowError(
		/A webhook Function cannot be invoked for remote execution with '\.remote'/,
	);

	mock.assertExhausted();
});

test("WebEndpointSpawnCallError", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => ({
		functionId: "fn-web",
		handleMetadata: {
			functionName: "web_endpoint_echo",
			webUrl: "https://web-endpoint.mock.test",
			supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
		},
	}));

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"web_endpoint_echo",
	);

	const promise = function_.spawn(["hello"]);
	await expect(promise).rejects.toThrowError(InvalidError);
	await expect(promise).rejects.toThrowError(
		/A webhook Function cannot be invoked for remote execution with '\.spawn'/,
	);

	mock.assertExhausted();
});

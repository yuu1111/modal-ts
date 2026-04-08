import { FunctionTimeoutError } from "modal";
import { expect, test } from "vitest";
import { cborEncode } from "../../src/serialization";
import { createMockModalClients } from "../support/grpc_mock";

const _mockFunctionProto = {
	functionId: "fid-echo",
	handleMetadata: {
		supportedInputFormats: [4],
	},
};

const _mockSleepFunctionProto = {
	functionId: "fid-sleep",
	handleMetadata: {
		supportedInputFormats: [4],
	},
};

test("FunctionSpawn", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	// Lookup echo_string
	mock.handleUnary("FunctionGet", (_req) => {
		return _mockFunctionProto;
	});

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"echo_string",
	);

	// Spawn with kwargs - uses ASYNC invocation type
	mock.handleUnary("FunctionMap", (req) => {
		expect(req.functionCallInvocationType).toBe(3);
		return {
			functionCallId: "fc-spawn-1",
			functionCallJwt: "jwt-test",
			pipelinedInputs: [{ inputJwt: "input-jwt-test" }],
		};
	});

	const functionCall = await function_.spawn([], { s: "hello" });
	expect(functionCall.functionCallId).toBeDefined();

	// Get results after spawn
	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return {
			outputs: [
				{
					result: { status: 1, data: cborEncode("output: hello") },
					dataFormat: 4,
				},
			],
		};
	});

	let resultKwargs = await functionCall.get();
	expect(resultKwargs).toBe("output: hello");

	// Get results again - same results should still be available
	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return {
			outputs: [
				{
					result: { status: 1, data: cborEncode("output: hello") },
					dataFormat: 4,
				},
			],
		};
	});

	resultKwargs = await functionCall.get();
	expect(resultKwargs).toBe("output: hello");

	// Lookup sleep function
	mock.handleUnary("FunctionGet", (_req) => {
		return _mockSleepFunctionProto;
	});

	const sleep = await mc.functions.fromName("modal-ts-test-support", "sleep");

	// Spawn sleep with long running input
	mock.handleUnary("FunctionMap", (_req) => {
		return {
			functionCallId: "fc-spawn-sleep",
			functionCallJwt: "jwt-test",
			pipelinedInputs: [{ inputJwt: "input-jwt-test" }],
		};
	});

	const sleepCall = await sleep.spawn([], { t: 5 });
	expect(sleepCall.functionCallId).toBeDefined();

	// Getting outputs with timeout 0 raises error immediately when no output available
	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return { outputs: [] };
	});

	const promise = sleepCall.get({ timeoutMs: 0 });
	await expect(promise).rejects.toThrowError(FunctionTimeoutError);

	mock.assertExhausted();
});

test("FunctionCallGet0", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (_req) => {
		return _mockSleepFunctionProto;
	});

	const sleep = await mc.functions.fromName("modal-ts-test-support", "sleep");

	// Spawn
	mock.handleUnary("FunctionMap", (_req) => {
		return {
			functionCallId: "fc-get0",
			functionCallJwt: "jwt-test",
			pipelinedInputs: [{ inputJwt: "input-jwt-test" }],
		};
	});

	const call = await sleep.spawn([0.5]);

	// Polling with timeout 0 should raise an error since not finished yet
	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return { outputs: [] };
	});

	await expect(call.get({ timeoutMs: 0 })).rejects.toThrowError(
		FunctionTimeoutError,
	);

	// Now the function call finishes - return null result
	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return {
			outputs: [
				{
					result: { status: 1, data: cborEncode(null) },
					dataFormat: 4,
				},
			],
		};
	});

	expect(await call.get()).toBe(null);

	// Now we can get the result with timeout 0 as well
	mock.handleUnary("FunctionGetOutputs", (_req) => {
		return {
			outputs: [
				{
					result: { status: 1, data: cborEncode(null) },
					dataFormat: 4,
				},
			],
		};
	});

	expect(await call.get({ timeoutMs: 0 })).toBe(null);

	mock.assertExhausted();
});

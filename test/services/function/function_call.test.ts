import { FunctionTimeoutError } from "modal";
import { expect, test } from "vitest";
import {
	DataFormat,
	GenericResult_GenericStatus,
} from "../../../src/generated/modal_proto/api";
import { cborEncode } from "../../../src/utils/serialization";
import { createMockModalClients } from "../../support/grpc_mock";

function makeFunctionGetResponse(functionName: string) {
	return {
		functionId: "fn-123",
		handleMetadata: {
			functionName,
			definitionId: "def-123",
			supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
			supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
		},
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

test("FunctionSpawn", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	// Look up echo_string function
	mock.handleUnary("/FunctionGet", () =>
		makeFunctionGetResponse("echo_string"),
	);

	// Spawn call (async invocation) -> FunctionMap
	mock.handleUnary("/FunctionMap", () => ({
		functionCallId: "fc-spawn-001",
		functionCallJwt: "jwt-spawn",
		pipelinedInputs: [{ inputJwt: "input-jwt-spawn" }],
	}));

	const function_ = await mc.functions.fromName(
		"modal-ts-test-support",
		"echo_string",
	);

	let functionCall = await function_.spawn([], { s: "hello" });
	expect(functionCall.functionCallId).toMatch(/^fc-/);

	// First .get() call
	mock.handleUnary("/FunctionGetOutputs", () =>
		makeSuccessOutput("output: hello"),
	);
	let resultKwargs = await functionCall.get();
	expect(resultKwargs).toBe("output: hello");

	// Second .get() call (re-fetching same result)
	mock.handleUnary("/FunctionGetOutputs", () =>
		makeSuccessOutput("output: hello"),
	);
	resultKwargs = await functionCall.get();
	expect(resultKwargs).toBe("output: hello");

	// Look up sleep function
	mock.handleUnary("/FunctionGet", () => makeFunctionGetResponse("sleep"));

	// Spawn sleep with long duration
	mock.handleUnary("/FunctionMap", () => ({
		functionCallId: "fc-spawn-002",
		functionCallJwt: "jwt-spawn-2",
		pipelinedInputs: [{ inputJwt: "input-jwt-spawn-2" }],
	}));

	const sleep = await mc.functions.fromName("modal-ts-test-support", "sleep");
	functionCall = await sleep.spawn([], { t: 5 });
	expect(functionCall.functionCallId).toMatch(/^fc-/);

	// Simulate timeout: return empty outputs (no result yet).
	// Use timeoutMs: 0 so the timeout fires immediately after the first empty poll.
	mock.handleUnary("/FunctionGetOutputs", () => ({ outputs: [] }));

	const promise = functionCall.get({ timeoutMs: 0 });
	await expect(promise).rejects.toThrowError(FunctionTimeoutError);

	mock.assertExhausted();
});

test("FunctionCallGet0", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => makeFunctionGetResponse("sleep"));

	mock.handleUnary("/FunctionMap", () => ({
		functionCallId: "fc-spawn-003",
		functionCallJwt: "jwt-spawn-3",
		pipelinedInputs: [{ inputJwt: "input-jwt-spawn-3" }],
	}));

	const sleep = await mc.functions.fromName("modal-ts-test-support", "sleep");

	const call = await sleep.spawn([0.5]);

	// timeoutMs: 0 with no result yet -> timeout error
	mock.handleUnary("/FunctionGetOutputs", () => ({ outputs: [] }));
	await expect(call.get({ timeoutMs: 0 })).rejects.toThrowError(
		FunctionTimeoutError,
	);

	// Now the function finishes -> returns null
	mock.handleUnary("/FunctionGetOutputs", () => makeSuccessOutput(null));
	expect(await call.get()).toBe(null);

	// Calling again with timeoutMs: 0 on completed call -> returns null
	mock.handleUnary("/FunctionGetOutputs", () => makeSuccessOutput(null));
	expect(await call.get({ timeoutMs: 0 })).toBe(null);

	mock.assertExhausted();
});

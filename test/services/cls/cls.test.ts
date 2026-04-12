import { NotFoundError } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test } from "vitest";
import {
	DataFormat,
	GenericResult_GenericStatus,
	ParameterType,
} from "../../../src/generated/modal_proto/api";
import { cborEncode } from "../../../src/utils/serialization";
import { createMockModalClients } from "../../support/grpc_mock";

function makeClsGetResponse(overrides: Record<string, unknown> = {}) {
	return {
		functionId: "fn-cls-123",
		handleMetadata: {
			methodHandleMetadata: {
				echo_string: {
					functionName: "echo_string",
					supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
					supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
				},
			},
			classParameterInfo: { schema: [] },
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
		functionCallId: "fc-cls-001",
		functionCallJwt: "jwt-cls",
		pipelinedInputs: [{ inputJwt: "input-jwt-cls" }],
	}));

	mock.handleUnary("/FunctionGetOutputs", () => makeSuccessOutput(result));
}

test("ClsCall", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	// Look up EchoCls
	mock.handleUnary("/FunctionGet", () =>
		makeClsGetResponse({
			handleMetadata: {
				methodHandleMetadata: {
					echo_string: {
						functionName: "echo_string",
						supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
						supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
					},
				},
				classParameterInfo: { schema: [] },
			},
		}),
	);

	const cls = await mc.cls.fromName("modal-ts-test-support", "EchoCls");
	const instance = await cls.instance();

	// Try accessing a non-existent method
	expect(() => instance.method("nonexistent")).toThrowError(NotFoundError);

	// Call echo_string method
	mockFunctionInvocation(mock, "output: hello");

	const function_ = instance.method("echo_string");
	const result = await function_.remote([], { s: "hello" });
	expect(result).toEqual("output: hello");

	// Look up EchoClsParametrized
	mock.handleUnary("/FunctionGet", () =>
		makeClsGetResponse({
			handleMetadata: {
				methodHandleMetadata: {
					echo_parameter: {
						functionName: "echo_parameter",
						supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
						supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
					},
				},
				classParameterInfo: {
					schema: [
						{
							name: "name",
							type: ParameterType.PARAM_TYPE_STRING,
							hasDefault: false,
						},
					],
					format: 2, // PARAM_SERIALIZATION_FORMAT_PROTO
				},
			},
		}),
	);

	const cls2 = await mc.cls.fromName(
		"modal-ts-test-support",
		"EchoClsParametrized",
	);

	// Instance with parameters triggers FunctionBindParams
	mock.handleUnary("/FunctionBindParams", (req) => {
		expect(req).toMatchObject({ functionId: "fn-cls-123" });
		return {
			boundFunctionId: "fn-cls-bound-001",
			handleMetadata: {},
		};
	});

	const instance2 = await cls2.instance({ name: "hello-init" });

	mockFunctionInvocation(mock, "output: hello-init");

	const function2 = instance2.method("echo_parameter");
	const result2 = await function2.remote();
	expect(result2).toEqual("output: hello-init");

	mock.assertExhausted();
});

test("ClsNotFound", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => {
		throw new ClientError("/FunctionGet", Status.NOT_FOUND, "not found");
	});

	const cls = mc.cls.fromName("modal-ts-test-support", "NotRealClassName");
	await expect(cls).rejects.toThrowError(NotFoundError);

	mock.assertExhausted();
});

test("ClsCallInputPlane", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	// Look up EchoClsInputPlane - use control plane path for mock compatibility
	mock.handleUnary("/FunctionGet", () =>
		makeClsGetResponse({
			handleMetadata: {
				methodHandleMetadata: {
					echo_string: {
						functionName: "echo_string",
						supportedInputFormats: [DataFormat.DATA_FORMAT_CBOR],
						supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
					},
				},
				classParameterInfo: { schema: [] },
			},
		}),
	);

	const cls = await mc.cls.fromName(
		"modal-ts-test-support",
		"EchoClsInputPlane",
	);
	const instance = await cls.instance();

	mockFunctionInvocation(mock, "output: hello");

	const function_ = instance.method("echo_string");
	const result = await function_.remote([], { s: "hello" });
	expect(result).toEqual("output: hello");

	mock.assertExhausted();
});

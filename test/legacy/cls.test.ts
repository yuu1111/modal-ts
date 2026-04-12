import { NotFoundError } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test } from "vitest";
import type { ModalGrpcClient } from "@/core/client";
import { cborEncode } from "@/utils/serialization";
import { createMockModalClients, MockGrpcClient } from "../support/grpc_mock";

const _mockClsFunctionProto = {
	functionId: "fid-cls",
	handleMetadata: {
		methodHandleMetadata: {
			echo_string: { supportedInputFormats: [4] },
		},
		classParameterInfo: { schema: [] },
	},
};

function mockRemoteCall(
	mock: ReturnType<typeof createMockModalClients>["mockCpClient"],
	expectedResult: unknown,
) {
	mock.handleUnary("FunctionMap", (_req) => {
		return {
			functionCallId: "fc-cls-123",
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

test("ClsCall", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (req) => {
		expect(req).toMatchObject({
			appName: "modal-ts-test-support",
			objectTag: "EchoCls.*",
		});
		return _mockClsFunctionProto;
	});

	const cls = await mc.cls.fromName("modal-ts-test-support", "EchoCls");
	const instance = await cls.instance();

	// Try accessing a non-existent method
	expect(() => instance.method("nonexistent")).toThrowError(NotFoundError);

	const function_ = instance.method("echo_string");

	mockRemoteCall(mock, "output: hello");
	const result = await function_.remote([], { s: "hello" });
	expect(result).toEqual("output: hello");

	// Parametrized class
	mock.handleUnary("FunctionGet", (req) => {
		expect(req).toMatchObject({
			appName: "modal-ts-test-support",
			objectTag: "EchoClsParametrized.*",
		});
		return {
			functionId: "fid-cls-param",
			handleMetadata: {
				methodHandleMetadata: {
					echo_parameter: { supportedInputFormats: [4] },
				},
				classParameterInfo: {
					format: 2,
					schema: [{ name: "name", hasDefault: false, type: 1 }],
				},
			},
		};
	});

	const cls2 = await mc.cls.fromName(
		"modal-ts-test-support",
		"EchoClsParametrized",
	);

	// Binding parameters triggers FunctionBindParams
	mock.handleUnary("FunctionBindParams", (req) => {
		expect(req).toMatchObject({ functionId: "fid-cls-param" });
		return {
			boundFunctionId: "fid-cls-param-bound",
			handleMetadata: {
				methodHandleMetadata: {
					echo_parameter: { supportedInputFormats: [4] },
				},
			},
		};
	});

	const instance2 = await cls2.instance({ name: "hello-init" });

	const function2 = instance2.method("echo_parameter");

	mockRemoteCall(mock, "output: hello-init");
	const result2 = await function2.remote();
	expect(result2).toEqual("output: hello-init");

	mock.assertExhausted();
});

test("ClsNotFound", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("FunctionGet", (_req) => {
		throw new ClientError(
			"/modal.client.ModalClient/FunctionGet",
			Status.NOT_FOUND,
			"Class not found",
		);
	});

	const cls = mc.cls.fromName("modal-ts-test-support", "NotRealClassName");
	await expect(cls).rejects.toThrowError(NotFoundError);

	mock.assertExhausted();
});

test("ClsCallInputPlane", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	const ipMock = new MockGrpcClient();

	// Patch ipClient to return our input plane mock
	mc.ipClient = () => ipMock as unknown as ModalGrpcClient;

	mock.handleUnary("FunctionGet", (req) => {
		expect(req).toMatchObject({
			appName: "modal-ts-test-support",
			objectTag: "EchoClsInputPlane.*",
		});
		return {
			functionId: "fid-cls-ip",
			handleMetadata: {
				methodHandleMetadata: {
					echo_string: {
						supportedInputFormats: [4],
						inputPlaneUrl: "https://input-plane.test",
					},
				},
				classParameterInfo: { schema: [] },
			},
		};
	});

	const cls = await mc.cls.fromName(
		"modal-ts-test-support",
		"EchoClsInputPlane",
	);
	const instance = await cls.instance();

	const function_ = instance.method("echo_string");

	// Input plane uses AttemptStart + AttemptAwait
	ipMock.handleUnary("AttemptStart", (_req) => {
		return { attemptToken: "attempt-token-cls" };
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

	const result = await function_.remote([], { s: "hello" });
	expect(result).toEqual("output: hello");

	mock.assertExhausted();
	ipMock.assertExhausted();
});

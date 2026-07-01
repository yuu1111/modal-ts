import { expect, test } from "vitest";
import { GenericResult_GenericStatus } from "../../../src/generated/modal_proto/api";
import { Image } from "../../../src/services/image/image";
import {
	SidecarContainer,
	SidecarService,
} from "../../../src/services/sandbox/sandbox_sidecar";

test("SidecarService.create sends container create request", async () => {
	const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
	const access = {
		exec: async () => {
			throw new Error("unexpected exec");
		},
		commandRouter: async () =>
			[
				"ta-test",
				{
					containerCreate: async (request: Record<string, unknown>) => {
						calls.push({ method: "containerCreate", request });
						return {
							containerId: "tc-worker",
							containerName: "worker",
						};
					},
				},
			] as const,
		mergeEnvIntoSecrets: async () => [],
	};

	const service = new SidecarService(access as never);
	const container = await service.create(
		"worker",
		new Image({} as never, "im-built", ""),
		{
			command: ["sleep", "60"],
			env: { ROLE: "worker" },
			workdir: "/srv",
		},
	);

	expect(container.containerId).toBe("tc-worker");
	expect(container.containerName).toBe("worker");
	expect(calls).toHaveLength(1);
	expect(calls[0]?.request).toMatchObject({
		taskId: "ta-test",
		containerName: "worker",
		imageId: "im-built",
		args: ["sleep", "60"],
		env: { ROLE: "worker" },
		workdir: "/srv",
		secretIds: [],
		volumeMounts: [],
	});
});

test("SidecarContainer poll returns exit code", async () => {
	const access = {
		exec: async () => {
			throw new Error("unexpected exec");
		},
		commandRouter: async () =>
			[
				"ta-test",
				{
					containerWait: async () => ({
						result: {
							status: GenericResult_GenericStatus.GENERIC_STATUS_SUCCESS,
							exitcode: 7,
						},
					}),
				},
			] as const,
		mergeEnvIntoSecrets: async () => [],
	};

	const container = new SidecarContainer(
		access as never,
		"tc-worker",
		"worker",
	);

	expect(await container.poll()).toBe(7);
});

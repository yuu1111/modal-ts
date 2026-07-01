import { Cron, Period, SchedulerPlacement } from "modal";
import { expect, test } from "vitest";
import { deployApp } from "../../../src/services/deploy/deploy";
import { createMockModalClients } from "../../support/grpc_mock";

test("deployApp passes schedule and scheduler placement", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/AppGetOrCreate", (req) => {
		expect(req).toMatchObject({
			appName: "scheduled-app",
			environmentName: "",
		});
		return { appId: "ap-123" };
	});

	mock.handleUnary("/FunctionPrecreate", (req) => {
		expect(req).toMatchObject({
			appId: "ap-123",
			functionName: "tick",
		});
		return { functionId: "fu-precreated" };
	});

	mock.handleUnary("/FunctionCreate", (req) => {
		expect(req).toMatchObject({
			appId: "ap-123",
			existingFunctionId: "fu-precreated",
			function: {
				functionName: "tick",
				schedule: {
					cron: {
						cronString: "*/5 * * * *",
						timezone: "America/New_York",
					},
				},
				schedulerPlacement: {
					regions: ["us-east-1"],
					nonpreemptible: true,
				},
			},
		});
		return {
			functionId: "fu-123",
			handleMetadata: { definitionId: "de-123" },
		};
	});

	mock.handleUnary("/AppPublish", (req) => {
		expect(req).toMatchObject({
			appId: "ap-123",
			name: "scheduled-app",
			functionIds: { tick: "fu-123" },
			definitionIds: { "fu-123": "de-123" },
		});
		return {};
	});

	const result = await deployApp(mc, {
		name: "scheduled-app",
		functions: [
			{
				functionName: "tick",
				moduleName: "scheduled",
				schedule: new Cron("*/5 * * * *", {
					timezone: "America/New_York",
				}),
				schedulerPlacement: new SchedulerPlacement({
					region: "us-east-1",
					nonpreemptible: true,
				}),
			},
		],
	});

	expect(result.functionIds).toEqual({ tick: "fu-123" });
	mock.assertExhausted();
});

test("Period builds a period schedule proto", () => {
	const schedule = new Period({ days: 1, seconds: 0.5 }).toProto();

	expect(schedule).toMatchObject({
		period: {
			days: 1,
			seconds: 0.5,
		},
	});
});

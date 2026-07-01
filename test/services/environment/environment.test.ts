import { expect, test } from "vitest";
import { createMockModalClients } from "../../support/grpc_mock";

test("EnvironmentService fromName createIfMissing", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/EnvironmentGetOrCreate", (req) => {
		expect(req).toMatchObject({
			deploymentName: "prod",
			objectCreationType: 1,
		});
		return {
			environmentId: "en-123",
			metadata: {
				name: "prod",
				settings: {
					webhookSuffix: "prod-hooks",
					imageBuilderVersion: "2024.10",
				},
			},
		};
	});

	const env = await mc.environments.fromName("prod", {
		createIfMissing: true,
	});

	expect(env.environmentId).toBe("en-123");
	expect(env.info()).toEqual({
		name: "prod",
		webhookSuffix: "prod-hooks",
		imageBuilderVersion: "2024.10",
	});
	mock.assertExhausted();
});

test("EnvironmentService create list delete update", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/EnvironmentCreate", (req) => {
		expect(req).toMatchObject({
			name: "staging",
			isManaged: true,
		});
		return {};
	});

	await mc.environments.create("staging", { restricted: true });

	mock.handleUnary("/EnvironmentList", () => ({
		items: [
			{
				name: "staging",
				webhookSuffix: "staging-hooks",
				createdAt: 123,
				default: false,
				isManaged: true,
				environmentId: "en-456",
				currentConcurrentTasks: 2,
				currentConcurrentGpus: 1,
				effectiveCycleSpendLimit: 100,
				currentCycleUsage: 12.5,
				spendLimitReached: false,
			},
		],
	}));

	expect(await mc.environments.list()).toEqual([
		{
			name: "staging",
			webhookSuffix: "staging-hooks",
			createdAt: 123,
			default: false,
			restricted: true,
			environmentId: "en-456",
			currentConcurrentTasks: 2,
			currentConcurrentGpus: 1,
			effectiveCycleSpendLimit: 100,
			currentCycleUsage: 12.5,
			spendLimitReached: false,
		},
	]);

	mock.handleUnary("/EnvironmentGetOrCreate", () => ({
		environmentId: "en-456",
		metadata: { name: "staging", settings: {} },
	}));

	const env = await mc.environments.fromName("staging");

	mock.handleUnary("/EnvironmentUpdate", (req) => {
		expect(req).toMatchObject({
			currentName: "staging",
			name: "stage",
			webSuffix: "stage-hooks",
		});
		return {
			name: "stage",
			webhookSuffix: "stage-hooks",
			createdAt: 123,
			default: false,
			isManaged: true,
			environmentId: "en-456",
			currentConcurrentTasks: 2,
			currentConcurrentGpus: 1,
			effectiveCycleSpendLimit: 100,
			currentCycleUsage: 12.5,
			spendLimitReached: false,
		};
	});

	await env.update({ name: "stage", webSuffix: "stage-hooks" });

	mock.handleUnary("/EnvironmentDelete", (req) => {
		expect(req).toMatchObject({ name: "stage" });
		return {};
	});

	await mc.environments.delete("stage");

	mock.assertExhausted();
});

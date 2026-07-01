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

test("Environment members list update remove", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/EnvironmentGetOrCreate", () => ({
		environmentId: "en-789",
		metadata: { name: "restricted", settings: {} },
	}));
	const env = await mc.environments.fromName("restricted");

	mock.handleUnary("/EnvironmentGetManaged", () => ({
		principalRoles: [
			{ userId: "u-1", userName: "alice", role: 2 },
			{ serviceUserId: "su-1", serviceUserName: "bot", role: 1 },
		],
		additionalRoles: [],
	}));
	expect(await env.members.list()).toEqual({
		users: { alice: "contributor" },
		serviceUsers: { bot: "viewer" },
		service_users: { bot: "viewer" },
	});

	mock.handleUnary("/EnvironmentGetManaged", () => ({
		principalRoles: [],
		additionalRoles: [
			{ userId: "u-2", userName: "bob", role: 1 },
			{ serviceUserId: "su-2", serviceUserName: "worker", role: 1 },
		],
	}));
	mock.handleUnary("/EnvironmentRoleSet", (req) => {
		expect(req).toMatchObject({
			environmentId: "en-789",
			userId: "u-2",
			role: 1,
		});
		return {};
	});
	mock.handleUnary("/EnvironmentRoleSet", (req) => {
		expect(req).toMatchObject({
			environmentId: "en-789",
			serviceUserId: "su-2",
			role: 2,
		});
		return {};
	});
	await env.members.update({
		users: { bob: "viewer" },
		service_users: { worker: "contributor" },
	});

	mock.handleUnary("/EnvironmentGetManaged", () => ({
		principalRoles: [
			{ userId: "u-1", userName: "alice", role: 2 },
			{ serviceUserId: "su-1", serviceUserName: "bot", role: 1 },
		],
		additionalRoles: [],
	}));
	mock.handleUnary("/EnvironmentRoleSet", (req) => {
		expect(req).toMatchObject({
			environmentId: "en-789",
			userId: "u-1",
			role: 0,
		});
		return {};
	});
	mock.handleUnary("/EnvironmentRoleSet", (req) => {
		expect(req).toMatchObject({
			environmentId: "en-789",
			serviceUserId: "su-1",
			role: 0,
		});
		return {};
	});
	await env.members.remove({ users: ["alice"], serviceUsers: ["bot"] });

	mock.assertExhausted();
});

test("Environment billing report scopes workspace billing to environment", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	const start = new Date("2026-01-01T00:00:00.000Z");
	const end = new Date("2026-01-02T00:00:00.000Z");

	mock.handleUnary("/EnvironmentGetOrCreate", () => ({
		environmentId: "en-bill",
		metadata: { name: "prod", settings: {} },
	}));
	const env = await mc.environments.fromName("prod");

	mock.handleUnary("/WorkspaceBillingReport", (req) => {
		expect(req).toMatchObject({
			startTimestamp: start,
			endTimestamp: end,
			resolution: "h",
			tagNames: ["team"],
			environmentIds: ["en-bill"],
		});
		return [
			{
				objectId: "fu-1",
				description: "function",
				environmentName: "prod",
				interval: start,
				cost: "1.23",
				costByResource: { cpu: "1.23" },
				tags: { team: "sdk" },
			},
		];
	});

	await expect(
		env.billing.report({ start, end, resolution: "h", tagNames: ["team"] }),
	).resolves.toEqual([
		{
			objectId: "fu-1",
			description: "function",
			environmentName: "prod",
			intervalStart: start,
			cost: "1.23",
			costByResource: { cpu: "1.23" },
			tags: { team: "sdk" },
		},
	]);

	mock.assertExhausted();
});

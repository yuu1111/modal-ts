import { expect, test } from "vitest";
import { MemberRole } from "../../../src/generated/modal_proto/api";
import { createMockModalClients } from "../../support/grpc_mock";

test("Workspace fromContext settings dashboard members", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/WorkspaceNameLookup", () => ({
		username: "acme",
	}));

	const workspace = await mc.workspaces.fromContext();
	expect(workspace.name).toBe("acme");

	mock.handleUnary("/WorkspaceDashboardUrlGet", (req) => {
		expect(req).toMatchObject({ environmentName: "" });
		return { url: "https://modal.com/apps/acme" };
	});
	expect(await workspace.getDashboardUrl()).toBe("https://modal.com/apps/acme");

	mock.handleUnary("/WorkspaceSettings", () => ({
		defaultEnvironmentName: "main",
		imageBuilderVersion: "2024.10",
	}));
	expect(await workspace.settings()).toEqual({
		defaultEnvironmentName: "main",
		imageBuilderVersion: "2024.10",
	});

	mock.handleUnary("/WorkspaceSettings", () => ({
		defaultEnvironmentName: "main",
		imageBuilderVersion: "2024.10",
	}));
	expect(await workspace.settingsManager.list()).toEqual({
		defaultEnvironmentName: "main",
		imageBuilderVersion: "2024.10",
	});
	expect(workspace.settings_manager.valid_settings()).toEqual([
		"defaultEnvironmentName",
		"imageBuilderVersion",
	]);

	mock.handleUnary("/WorkspaceSetDefaultEnvironment", (req) => {
		expect(req).toMatchObject({ environmentName: "prod" });
		return {};
	});
	await workspace.settingsManager.set("defaultEnvironmentName", "prod");

	mock.handleUnary("/WorkspaceSetImageBuilderVersion", (req) => {
		expect(req).toMatchObject({ newImageBuilderVersion: "2025.01" });
		return { imageBuilderVersion: "2025.01" };
	});
	expect(
		await workspace.settingsManager.set("imageBuilderVersion", "2025.01"),
	).toBe("2025.01");

	mock.handleUnary("/WorkspaceMembersList", () => ({
		members: [
			{
				memberDisplayname: "Bob",
				email: "bob@example.com",
				userId: "u-bob",
				memberRole: MemberRole.MEMBER_ROLE_USER,
				joinedAt: 2,
				lastActiveAt: 3,
			},
			{
				memberDisplayname: "Alice",
				email: "alice@example.com",
				userId: "u-alice",
				memberRole: MemberRole.MEMBER_ROLE_OWNER,
				joinedAt: 1,
				lastActiveAt: 0,
			},
		],
	}));

	const members = await workspace.members.list();
	expect(members.map((member) => member.name)).toEqual(["Alice", "Bob"]);
	expect(members[0]).toMatchObject({
		email: "alice@example.com",
		role: "owner",
	});
	expect(members[1]?.lastActiveAt).toEqual(new Date(3000));

	mock.assertExhausted();
});

test("Workspace proxy tokens", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/WorkspaceNameLookup", () => ({ username: "acme" }));
	const workspace = await mc.workspaces.fromContext();

	mock.handleUnary("/WebhookTokenCreate", (req) => {
		expect(req).toMatchObject({ scoped: true });
		return {
			tokenId: "wk-123",
			tokenSecret: "secret",
		};
	});
	expect(await workspace.proxyTokens.create({ scoped: true })).toEqual({
		tokenId: "wk-123",
		tokenSecret: "secret",
	});

	mock.handleUnary("/WebhookTokenListForEnvironment", (req) => {
		expect(req).toMatchObject({ environmentName: "prod" });
		return {
			tokens: [{ tokenId: "wk-123", createdAt: 10, scoped: true }],
		};
	});
	expect(await workspace.proxyTokens.list({ environmentName: "prod" })).toEqual(
		[{ tokenId: "wk-123", createdAt: new Date(10_000), scoped: true }],
	);

	mock.handleUnary("/EnvironmentGetOrCreate", (req) => {
		expect(req).toMatchObject({ deploymentName: "prod" });
		return {
			environmentId: "en-prod",
			metadata: { name: "prod", settings: {} },
		};
	});
	mock.handleUnary("/WebhookTokenEnvironmentAdd", (req) => {
		expect(req).toMatchObject({
			tokenId: "wk-123",
			environmentId: "en-prod",
		});
		return {};
	});
	await workspace.proxyTokens.allow("wk-123", "prod");

	mock.handleUnary("/WebhookTokenDelete", (req) => {
		expect(req).toMatchObject({ tokenId: "wk-123" });
		return {};
	});
	await workspace.proxyTokens.delete("wk-123");

	mock.assertExhausted();
});

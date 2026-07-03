import { getDefaultClient, type ModalClient } from "@/core/client";
import {
	MemberRole,
	type WorkspaceBillingReportItem as WorkspaceBillingReportItemProto,
	type WorkspaceMembersListItem,
} from "@/generated/modal_proto/api";

/**
 * @description Workspace settings
 */
export type WorkspaceSettings = {
	defaultEnvironmentName: string;
	imageBuilderVersion: string;
};

export type WorkspaceSettingName =
	| "defaultEnvironmentName"
	| "imageBuilderVersion";

export type WorkspaceBillingReportRow = {
	objectId: string;
	description: string;
	environmentName: string;
	intervalStart: Date;
	cost: string;
	costByResource: Record<string, string>;
	tags: Record<string, string>;
};

/**
 * @description Workspace member role
 */
export type WorkspaceMemberRole = "user" | "manager" | "owner";

/**
 * @description Workspace member information
 */
export type WorkspaceMemberInfo = {
	name: string;
	email: string;
	userId: string;
	role: WorkspaceMemberRole;
	joinedAt: Date;
	lastActiveAt?: Date;
};

/**
 * @description Result of creating a proxy token
 */
export type TokenData = {
	tokenId: string;
	tokenSecret: string;
};

/**
 * @description Proxy token information
 */
export type ProxyTokenInfo = {
	tokenId: string;
	createdAt: Date;
	scoped: boolean;
};

/**
 * @description Service for managing workspaces
 */
export class WorkspaceService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Gets the Workspace associated with the current credentials
	 */
	async fromContext(): Promise<Workspace> {
		const resp = await this.#client.cpClient.workspaceNameLookup({});
		return new Workspace(
			this.#client,
			resp.username || resp.workspaceName || "",
		);
	}

	async from_context(): Promise<Workspace> {
		return await this.fromContext();
	}
}

/**
 * @description Modal Workspace
 */
export class Workspace {
	readonly name: string;
	readonly billing: WorkspaceBillingManager;
	readonly members: WorkspaceMembersManager;
	readonly proxyTokens: WorkspaceProxyTokenManager;
	readonly settingsManager: WorkspaceSettingsManager;
	readonly #client: ModalClient;

	/**
	 * @internal
	 */
	constructor(client: ModalClient, name: string) {
		this.#client = client;
		this.name = name;
		this.billing = new WorkspaceBillingManager(client);
		this.members = new WorkspaceMembersManager(client);
		this.proxyTokens = new WorkspaceProxyTokenManager(client);
		this.settingsManager = new WorkspaceSettingsManager(client);
	}

	static async from_context(): Promise<Workspace> {
		return await getDefaultClient().workspaces.fromContext();
	}

	static async fromContext(): Promise<Workspace> {
		return await Workspace.from_context();
	}

	get proxy_tokens(): WorkspaceProxyTokenManager {
		return this.proxyTokens;
	}

	get settings_manager(): WorkspaceSettingsManager {
		return this.settingsManager;
	}

	/**
	 * @description Gets the dashboard URL
	 */
	async getDashboardUrl(environment?: string): Promise<string> {
		const resp = await this.#client.cpClient.workspaceDashboardUrlGet({
			environmentName: this.#client.environmentName(environment),
		});
		return resp.url;
	}

	/**
	 * @description Gets Workspace settings
	 */
	async settings(): Promise<WorkspaceSettings> {
		const resp = await this.#client.cpClient.workspaceSettings({});
		return {
			defaultEnvironmentName: resp.defaultEnvironmentName,
			imageBuilderVersion: resp.imageBuilderVersion,
		};
	}

	/**
	 * @description Sets the default Environment
	 */
	async setDefaultEnvironment(environmentName: string): Promise<void> {
		await this.#client.cpClient.workspaceSetDefaultEnvironment({
			environmentName,
		});
	}

	/**
	 * @description Sets the Workspace image builder version
	 */
	async setImageBuilderVersion(version: string): Promise<string> {
		const resp = await this.#client.cpClient.workspaceSetImageBuilderVersion({
			newImageBuilderVersion: version,
		});
		return resp.imageBuilderVersion;
	}
}

/**
 * @description Workspace settings manager
 */
export class WorkspaceSettingsManager {
	readonly #client: ModalClient;

	/**
	 * @internal
	 */
	constructor(client: ModalClient) {
		this.#client = client;
	}

	async list(): Promise<WorkspaceSettings> {
		const resp = await this.#client.cpClient.workspaceSettings({});
		return {
			defaultEnvironmentName: resp.defaultEnvironmentName,
			imageBuilderVersion: resp.imageBuilderVersion,
		};
	}

	async set(
		name: WorkspaceSettingName,
		value: string,
	): Promise<string | undefined> {
		switch (name) {
			case "defaultEnvironmentName":
				await this.#client.cpClient.workspaceSetDefaultEnvironment({
					environmentName: value,
				});
				return;
			case "imageBuilderVersion": {
				const resp =
					await this.#client.cpClient.workspaceSetImageBuilderVersion({
						newImageBuilderVersion: value,
					});
				return resp.imageBuilderVersion;
			}
		}
	}

	validSettings(): WorkspaceSettingName[] {
		return ["defaultEnvironmentName", "imageBuilderVersion"];
	}

	valid_settings(): WorkspaceSettingName[] {
		return this.validSettings();
	}
}

/**
 * @description Workspace billing manager
 */
export class WorkspaceBillingManager {
	readonly #client: ModalClient;

	/**
	 * @internal
	 */
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Returns a billing report for Workspace usage
	 */
	async report(params: {
		start: Date;
		end?: Date;
		resolution?: string;
		tagNames?: string[];
	}): Promise<WorkspaceBillingReportRow[]> {
		const rows: WorkspaceBillingReportRow[] = [];
		const stream = await this.#client.cpClient.workspaceBillingReport({
			startTimestamp: params.start,
			endTimestamp: params.end ?? new Date(),
			resolution: params.resolution ?? "d",
			tagNames: params.tagNames ?? [],
			environmentIds: [],
			appIds: [],
		});
		for await (const item of stream) {
			rows.push(workspaceBillingReportRowFromProto(item));
		}
		return rows;
	}
}

/**
 * @description Workspace members manager
 */
export class WorkspaceMembersManager {
	readonly #client: ModalClient;

	/**
	 * @internal
	 */
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Returns the list of Workspace members
	 */
	async list(): Promise<WorkspaceMemberInfo[]> {
		const resp = await this.#client.cpClient.workspaceMembersList({});
		return resp.members
			.map(workspaceMemberInfoFromProto)
			.sort((a, b) => a.name.localeCompare(b.name));
	}
}

/**
 * @description Workspace proxy token manager
 */
export class WorkspaceProxyTokenManager {
	readonly #client: ModalClient;

	/**
	 * @internal
	 */
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Creates a proxy token
	 */
	async create(params: { scoped?: boolean } = {}): Promise<TokenData> {
		const resp = await this.#client.cpClient.webhookTokenCreate({
			scoped: params.scoped ?? false,
		});
		return {
			tokenId: resp.tokenId,
			tokenSecret: resp.tokenSecret,
		};
	}

	/**
	 * @description Returns the list of proxy tokens
	 */
	async list(
		params: { environmentName?: string } = {},
	): Promise<ProxyTokenInfo[]> {
		const resp = params.environmentName
			? await this.#client.cpClient.webhookTokenListForEnvironment({
					environmentName: params.environmentName,
				})
			: await this.#client.cpClient.webhookTokenList({});
		return resp.tokens.map((token) => ({
			tokenId: token.tokenId,
			createdAt: new Date(token.createdAt * 1000),
			scoped: token.scoped,
		}));
	}

	/**
	 * @description Allows a proxy token to access an Environment
	 */
	async allow(tokenId: string, environmentName: string): Promise<void> {
		const env = await this.#client.environments.fromName(environmentName);
		await this.#client.cpClient.webhookTokenEnvironmentAdd({
			tokenId,
			environmentId: env.environmentId,
		});
	}

	/**
	 * @description Revokes a proxy token's access to an Environment
	 */
	async revoke(tokenId: string, environmentName: string): Promise<void> {
		const env = await this.#client.environments.fromName(environmentName);
		await this.#client.cpClient.webhookTokenEnvironmentRemove({
			tokenId,
			environmentId: env.environmentId,
		});
	}

	/**
	 * @description Deletes a proxy token
	 */
	async delete(tokenId: string): Promise<void> {
		await this.#client.cpClient.webhookTokenDelete({ tokenId });
	}
}

function workspaceMemberInfoFromProto(
	item: WorkspaceMembersListItem,
): WorkspaceMemberInfo {
	return {
		name: item.memberDisplayname,
		email: item.email,
		userId: item.userId,
		role: memberRoleFromProto(item.memberRole),
		joinedAt: new Date(item.joinedAt * 1000),
		...(item.lastActiveAt
			? { lastActiveAt: new Date(item.lastActiveAt * 1000) }
			: {}),
	};
}

function memberRoleFromProto(role: MemberRole): WorkspaceMemberRole {
	switch (role) {
		case MemberRole.MEMBER_ROLE_USER:
			return "user";
		case MemberRole.MEMBER_ROLE_MANAGER:
			return "manager";
		case MemberRole.MEMBER_ROLE_OWNER:
			return "owner";
		default:
			throw new Error(`Unknown workspace member role: ${role}`);
	}
}

function workspaceBillingReportRowFromProto(
	item: WorkspaceBillingReportItemProto,
): WorkspaceBillingReportRow {
	return {
		objectId: item.objectId,
		description: item.description,
		environmentName: item.environmentName,
		intervalStart: item.interval ?? new Date(0),
		cost: item.cost,
		costByResource: item.costByResource,
		tags: item.tags,
	};
}

import { getDefaultClient, type ModalClient } from "@/core/client";
import {
	MemberRole,
	type WorkspaceBillingReportItem as WorkspaceBillingReportItemProto,
	type WorkspaceMembersListItem,
} from "@/generated/modal_proto/api";

/**
 * @description Workspace 設定
 */
export type WorkspaceSettings = {
	defaultEnvironmentName: string;
	imageBuilderVersion: string;
};

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
 * @description Workspace メンバーのロール
 */
export type WorkspaceMemberRole = "user" | "manager" | "owner";

/**
 * @description Workspace メンバー情報
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
 * @description Proxy token の作成結果
 */
export type TokenData = {
	tokenId: string;
	tokenSecret: string;
};

/**
 * @description Proxy token 情報
 */
export type ProxyTokenInfo = {
	tokenId: string;
	createdAt: Date;
	scoped: boolean;
};

/**
 * @description Workspace を管理するサービス
 */
export class WorkspaceService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 現在の認証情報に紐づく Workspace を取得する
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
	}

	static async from_context(): Promise<Workspace> {
		return await getDefaultClient().workspaces.fromContext();
	}

	get proxy_tokens(): WorkspaceProxyTokenManager {
		return this.proxyTokens;
	}

	/**
	 * @description Dashboard URL を取得する
	 */
	async getDashboardUrl(environment?: string): Promise<string> {
		const resp = await this.#client.cpClient.workspaceDashboardUrlGet({
			environmentName: this.#client.environmentName(environment),
		});
		return resp.url;
	}

	/**
	 * @description Workspace 設定を取得する
	 */
	async settings(): Promise<WorkspaceSettings> {
		const resp = await this.#client.cpClient.workspaceSettings({});
		return {
			defaultEnvironmentName: resp.defaultEnvironmentName,
			imageBuilderVersion: resp.imageBuilderVersion,
		};
	}

	/**
	 * @description デフォルト Environment を設定する
	 */
	async setDefaultEnvironment(environmentName: string): Promise<void> {
		await this.#client.cpClient.workspaceSetDefaultEnvironment({
			environmentName,
		});
	}

	/**
	 * @description Workspace の image builder version を設定する
	 */
	async setImageBuilderVersion(version: string): Promise<string> {
		const resp = await this.#client.cpClient.workspaceSetImageBuilderVersion({
			newImageBuilderVersion: version,
		});
		return resp.imageBuilderVersion;
	}
}

/**
 * @description Workspace billing 管理
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
	 * @description Workspace usage の billing report を返す
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
 * @description Workspace メンバー管理
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
	 * @description Workspace メンバー一覧を返す
	 */
	async list(): Promise<WorkspaceMemberInfo[]> {
		const resp = await this.#client.cpClient.workspaceMembersList({});
		return resp.members
			.map(workspaceMemberInfoFromProto)
			.sort((a, b) => a.name.localeCompare(b.name));
	}
}

/**
 * @description Workspace proxy token 管理
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
	 * @description Proxy token を作成する
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
	 * @description Proxy token 一覧を返す
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
	 * @description Proxy token に Environment へのアクセスを許可する
	 */
	async allow(tokenId: string, environmentName: string): Promise<void> {
		const env = await this.#client.environments.fromName(environmentName);
		await this.#client.cpClient.webhookTokenEnvironmentAdd({
			tokenId,
			environmentId: env.environmentId,
		});
	}

	/**
	 * @description Proxy token の Environment へのアクセスを取り消す
	 */
	async revoke(tokenId: string, environmentName: string): Promise<void> {
		const env = await this.#client.environments.fromName(environmentName);
		await this.#client.cpClient.webhookTokenEnvironmentRemove({
			tokenId,
			environmentId: env.environmentId,
		});
	}

	/**
	 * @description Proxy token を削除する
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

import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import {
	type EnvironmentListItem,
	type EnvironmentMetadata,
	EnvironmentRole,
	ObjectCreationType,
	type WorkspaceBillingReportItem,
} from "@/generated/modal_proto/api";

/**
 * @description Environment.fromName() のオプションパラメータ
 * @property createIfMissing - 存在しない場合に作成する @optional
 */
export type EnvironmentFromNameParams = {
	createIfMissing?: boolean;
};

/**
 * @description Environment 作成パラメータ
 * @property restricted - RBAC 制限付き Environment として作成する @optional
 */
export type EnvironmentCreateParams = {
	restricted?: boolean;
};

/**
 * @description Environment 更新パラメータ
 * @property name - 新しい Environment 名 @optional
 * @property webSuffix - 新しい Webhook suffix @optional
 * @property maxConcurrentTasks - 最大同時 task 数 @optional
 * @property maxConcurrentGpus - 最大同時 GPU 数 @optional
 */
export type EnvironmentUpdateParams = {
	name?: string;
	webSuffix?: string;
	maxConcurrentTasks?: number;
	maxConcurrentGpus?: number;
};

/**
 * @description Environment 情報
 */
export type EnvironmentInfo = {
	name: string;
	webhookSuffix?: string;
	imageBuilderVersion?: string;
};

/**
 * @description Environment 一覧の要素
 */
export type EnvironmentListEntry = {
	name: string;
	webhookSuffix: string;
	createdAt: number;
	default: boolean;
	restricted: boolean;
	environmentId: string;
	maxConcurrentTasks?: number;
	maxConcurrentGpus?: number;
	currentConcurrentTasks: number;
	currentConcurrentGpus: number;
	cycleBudgetDollars?: number;
	effectiveCycleSpendLimit: number;
	currentCycleUsage: number;
	spendLimitReached: boolean;
};

/**
 * @description Environment member の role
 */
export type EnvironmentMemberRole = "viewer" | "contributor";

/**
 * @description restricted Environment の members
 */
export type EnvironmentMembers = {
	users: Record<string, EnvironmentMemberRole>;
	serviceUsers: Record<string, EnvironmentMemberRole>;
	service_users: Record<string, EnvironmentMemberRole>;
};

/**
 * @description Billing report の行
 */
export type EnvironmentBillingReportItem = {
	objectId: string;
	description: string;
	environmentName: string;
	intervalStart: Date;
	cost: string;
	costByResource: Record<string, string>;
	tags: Record<string, string>;
};

/**
 * @description Environment を管理するサービス
 */
export class EnvironmentService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 現在の profile/context の Environment を取得する
	 */
	async fromContext(): Promise<Environment> {
		return await this.fromName(this.#client.environmentName());
	}

	async from_context(): Promise<Environment> {
		return await this.fromContext();
	}

	/**
	 * @description 名前で Environment を取得する
	 */
	async fromName(
		name: string,
		params: EnvironmentFromNameParams = {},
	): Promise<Environment> {
		checkEnvironmentName(name);
		const resp = await this.#client.cpClient.environmentGetOrCreate({
			deploymentName: name,
			objectCreationType: params.createIfMissing
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED,
		});
		return new Environment(
			this.#client,
			resp.environmentId,
			environmentInfoFromMetadata(resp.metadata, name),
		);
	}

	async from_name(
		name: string,
		params: EnvironmentFromNameParams = {},
	): Promise<Environment> {
		return await this.fromName(name, params);
	}

	/**
	 * @description Environment を作成する
	 */
	async create(
		name: string,
		params: EnvironmentCreateParams = {},
	): Promise<void> {
		checkEnvironmentName(name);
		await this.#client.cpClient.environmentCreate({
			name,
			isManaged: params.restricted ?? false,
		});
	}

	/**
	 * @description Environment の一覧を返す
	 */
	async list(): Promise<EnvironmentListEntry[]> {
		const resp = await this.#client.cpClient.environmentList({});
		return resp.items.map(environmentListEntryFromProto);
	}

	/**
	 * @description Environment を削除する
	 */
	async delete(name: string): Promise<void> {
		checkEnvironmentName(name);
		await this.#client.cpClient.environmentDelete({ name });
	}
}

/**
 * @description Modal Environment
 */
export class Environment {
	readonly environmentId: string;
	readonly name: string;
	readonly webhookSuffix?: string;
	readonly imageBuilderVersion?: string;
	readonly billing: EnvironmentBillingManager;
	readonly members: EnvironmentMembersManager;
	readonly #client: ModalClient;

	/**
	 * @internal
	 */
	constructor(
		client: ModalClient,
		environmentId: string,
		info: EnvironmentInfo,
	) {
		this.#client = client;
		this.environmentId = environmentId;
		this.name = info.name;
		if (info.webhookSuffix !== undefined)
			this.webhookSuffix = info.webhookSuffix;
		if (info.imageBuilderVersion !== undefined)
			this.imageBuilderVersion = info.imageBuilderVersion;
		this.billing = new EnvironmentBillingManager(
			this.#client,
			this.environmentId,
		);
		this.members = new EnvironmentMembersManager(
			this.#client,
			this.environmentId,
		);
	}

	static get objects(): EnvironmentService {
		return getDefaultClient().environments;
	}

	static async from_context(): Promise<Environment> {
		return await getDefaultClient().environments.fromContext();
	}

	static async fromContext(): Promise<Environment> {
		return await Environment.from_context();
	}

	static async from_name(
		name: string,
		params: EnvironmentFromNameParams = {},
	): Promise<Environment> {
		return await getDefaultClient().environments.fromName(name, params);
	}

	static async fromName(
		name: string,
		params: EnvironmentFromNameParams = {},
	): Promise<Environment> {
		return await Environment.from_name(name, params);
	}

	/**
	 * @description Environment の情報を返す
	 */
	info(): EnvironmentInfo {
		return {
			name: this.name,
			...(this.webhookSuffix !== undefined && {
				webhookSuffix: this.webhookSuffix,
			}),
			...(this.imageBuilderVersion !== undefined && {
				imageBuilderVersion: this.imageBuilderVersion,
			}),
		};
	}

	/**
	 * @description Environment を更新する
	 */
	async update(params: EnvironmentUpdateParams): Promise<EnvironmentListEntry> {
		if (params.name !== undefined) {
			checkEnvironmentName(params.name);
		}
		const updated = await this.#client.cpClient.environmentUpdate({
			currentName: this.name,
			name: params.name,
			webSuffix: params.webSuffix,
			maxConcurrentTasks: params.maxConcurrentTasks,
			maxConcurrentGpus: params.maxConcurrentGpus,
		});
		return environmentListEntryFromProto(updated);
	}
}

/**
 * @description Environment billing 管理
 */
export class EnvironmentBillingManager {
	readonly #client: ModalClient;
	readonly #environmentId: string;

	constructor(client: ModalClient, environmentId: string) {
		this.#client = client;
		this.#environmentId = environmentId;
	}

	/**
	 * @description Environment usage の billing report を返す
	 */
	async report(params: {
		start: Date;
		end?: Date;
		resolution?: string;
		tagNames?: string[];
		tag_names?: string[];
	}): Promise<EnvironmentBillingReportItem[]> {
		const rows: EnvironmentBillingReportItem[] = [];
		const stream = await this.#client.cpClient.workspaceBillingReport({
			startTimestamp: params.start,
			endTimestamp: params.end ?? new Date(),
			resolution: params.resolution ?? "d",
			tagNames: params.tagNames ?? params.tag_names ?? [],
			environmentIds: [this.#environmentId],
		});
		for await (const item of stream) {
			rows.push(environmentBillingReportItemFromProto(item));
		}
		return rows;
	}
}

/**
 * @description restricted Environment の members 管理
 */
export class EnvironmentMembersManager {
	readonly #client: ModalClient;
	readonly #environmentId: string;

	constructor(client: ModalClient, environmentId: string) {
		this.#client = client;
		this.#environmentId = environmentId;
	}

	/**
	 * @description restricted Environment の members を返す
	 */
	async list(): Promise<EnvironmentMembers> {
		const resp = await this.#client.cpClient.environmentGetManaged({
			environmentId: this.#environmentId,
		});
		const users: Record<string, EnvironmentMemberRole> = {};
		const serviceUsers: Record<string, EnvironmentMemberRole> = {};
		for (const principal of resp.principalRoles) {
			const role = environmentRoleFromProto(principal.role);
			if (principal.userId) {
				users[principal.userName] = role;
			} else if (principal.serviceUserId) {
				serviceUsers[principal.serviceUserName] = role;
			}
		}
		return { users, serviceUsers, service_users: serviceUsers };
	}

	/**
	 * @description restricted Environment の members を追加または更新する
	 */
	async update(params: {
		users?: Record<string, EnvironmentMemberRole>;
		serviceUsers?: Record<string, EnvironmentMemberRole>;
		service_users?: Record<string, EnvironmentMemberRole>;
	}): Promise<void> {
		const roles = await this.#client.cpClient.environmentGetManaged({
			environmentId: this.#environmentId,
		});
		const serviceUsers = params.serviceUsers ?? params.service_users ?? {};
		const userIds = new Map<string, string>();
		const serviceUserIds = new Map<string, string>();
		for (const principal of [
			...roles.principalRoles,
			...roles.additionalRoles,
		]) {
			if (principal.userId) userIds.set(principal.userName, principal.userId);
			if (principal.serviceUserId) {
				serviceUserIds.set(principal.serviceUserName, principal.serviceUserId);
			}
		}
		const requests: Array<Promise<unknown>> = [];
		for (const [name, role] of Object.entries(params.users ?? {})) {
			const userId = userIds.get(name);
			if (!userId)
				throw new InvalidError(`User '${name}' not found in workspace`);
			requests.push(
				this.#client.cpClient.environmentRoleSet({
					environmentId: this.#environmentId,
					userId,
					serviceUserId: "",
					role: environmentRoleToProto(role),
				}),
			);
		}
		for (const [name, role] of Object.entries(serviceUsers)) {
			const serviceUserId = serviceUserIds.get(name);
			if (!serviceUserId) {
				throw new InvalidError(`Service user '${name}' not found in workspace`);
			}
			requests.push(
				this.#client.cpClient.environmentRoleSet({
					environmentId: this.#environmentId,
					userId: "",
					serviceUserId,
					role: environmentRoleToProto(role),
				}),
			);
		}
		await Promise.all(requests);
	}

	/**
	 * @description restricted Environment から members を削除する
	 */
	async remove(params: {
		users?: string[];
		serviceUsers?: string[];
		service_users?: string[];
	}): Promise<void> {
		const roles = await this.#client.cpClient.environmentGetManaged({
			environmentId: this.#environmentId,
		});
		const serviceUsers = params.serviceUsers ?? params.service_users ?? [];
		const userIds = new Map<string, string>();
		const serviceUserIds = new Map<string, string>();
		for (const principal of roles.principalRoles) {
			if (principal.userId) userIds.set(principal.userName, principal.userId);
			if (principal.serviceUserId) {
				serviceUserIds.set(principal.serviceUserName, principal.serviceUserId);
			}
		}
		const requests: Array<Promise<unknown>> = [];
		for (const name of params.users ?? []) {
			const userId = userIds.get(name);
			if (!userId) {
				throw new InvalidError(
					`User '${name}' is not a member of this Environment`,
				);
			}
			requests.push(
				this.#client.cpClient.environmentRoleSet({
					environmentId: this.#environmentId,
					userId,
					serviceUserId: "",
					role: EnvironmentRole.ENVIRONMENT_ROLE_UNSPECIFIED,
				}),
			);
		}
		for (const name of serviceUsers) {
			const serviceUserId = serviceUserIds.get(name);
			if (!serviceUserId) {
				throw new InvalidError(
					`Service user '${name}' is not a member of this Environment`,
				);
			}
			requests.push(
				this.#client.cpClient.environmentRoleSet({
					environmentId: this.#environmentId,
					userId: "",
					serviceUserId,
					role: EnvironmentRole.ENVIRONMENT_ROLE_UNSPECIFIED,
				}),
			);
		}
		await Promise.all(requests);
	}
}

function environmentInfoFromMetadata(
	metadata: EnvironmentMetadata | undefined,
	fallbackName: string,
): EnvironmentInfo {
	return {
		name: metadata?.name || fallbackName,
		...(metadata?.settings?.webhookSuffix && {
			webhookSuffix: metadata.settings.webhookSuffix,
		}),
		...(metadata?.settings?.imageBuilderVersion && {
			imageBuilderVersion: metadata.settings.imageBuilderVersion,
		}),
	};
}

function environmentListEntryFromProto(
	item: EnvironmentListItem,
): EnvironmentListEntry {
	return {
		name: item.name,
		webhookSuffix: item.webhookSuffix,
		createdAt: item.createdAt,
		default: item.default,
		restricted: item.isManaged,
		environmentId: item.environmentId,
		...(item.maxConcurrentTasks !== undefined && {
			maxConcurrentTasks: item.maxConcurrentTasks,
		}),
		...(item.maxConcurrentGpus !== undefined && {
			maxConcurrentGpus: item.maxConcurrentGpus,
		}),
		currentConcurrentTasks: item.currentConcurrentTasks,
		currentConcurrentGpus: item.currentConcurrentGpus,
		...(item.cycleBudgetDollars !== undefined && {
			cycleBudgetDollars: item.cycleBudgetDollars,
		}),
		effectiveCycleSpendLimit: item.effectiveCycleSpendLimit,
		currentCycleUsage: item.currentCycleUsage,
		spendLimitReached: item.spendLimitReached,
	};
}

function checkEnvironmentName(name: string): void {
	if (name === "") return;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
		throw new Error(`Invalid Environment name: ${name}`);
	}
}

function environmentRoleFromProto(
	role: EnvironmentRole,
): EnvironmentMemberRole {
	if (role === EnvironmentRole.ENVIRONMENT_ROLE_VIEWER) return "viewer";
	if (role === EnvironmentRole.ENVIRONMENT_ROLE_CONTRIBUTOR) {
		return "contributor";
	}
	throw new InvalidError(`Unknown Environment role: ${role}`);
}

function environmentRoleToProto(role: EnvironmentMemberRole): EnvironmentRole {
	if (role === "viewer") return EnvironmentRole.ENVIRONMENT_ROLE_VIEWER;
	if (role === "contributor") {
		return EnvironmentRole.ENVIRONMENT_ROLE_CONTRIBUTOR;
	}
	throw new InvalidError(`Unknown Environment role: ${role}`);
}

function environmentBillingReportItemFromProto(
	item: WorkspaceBillingReportItem,
): EnvironmentBillingReportItem {
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

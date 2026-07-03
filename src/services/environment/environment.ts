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
 * @description Optional parameters for Environment.fromName()
 * @property createIfMissing - Create when missing @optional
 */
export type EnvironmentFromNameParams = {
	createIfMissing?: boolean;
};

/**
 * @description Environment creation parameters
 * @property restricted - Create as an RBAC-restricted Environment @optional
 */
export type EnvironmentCreateParams = {
	restricted?: boolean;
};

/**
 * @description Environment update parameters
 * @property name - New Environment name @optional
 * @property webSuffix - New webhook suffix @optional
 * @property maxConcurrentTasks - Maximum concurrent task count @optional
 * @property maxConcurrentGpus - Maximum concurrent GPU count @optional
 */
export type EnvironmentUpdateParams = {
	name?: string;
	webSuffix?: string;
	maxConcurrentTasks?: number;
	maxConcurrentGpus?: number;
};

/**
 * @description Environment information
 */
export type EnvironmentInfo = {
	name: string;
	webhookSuffix?: string;
	imageBuilderVersion?: string;
};

/**
 * @description Entry in the Environment list
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
 * @description Environment member role
 */
export type EnvironmentMemberRole = "viewer" | "contributor";

/**
 * @description Members of a restricted Environment
 */
export type EnvironmentMembers = {
	users: Record<string, EnvironmentMemberRole>;
	serviceUsers: Record<string, EnvironmentMemberRole>;
	service_users: Record<string, EnvironmentMemberRole>;
};

/**
 * @description Billing report row
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
 * @description Service for managing Environments
 */
export class EnvironmentService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Gets the Environment for the current profile/context
	 */
	async fromContext(): Promise<Environment> {
		return await this.fromName(this.#client.environmentName());
	}

	async from_context(): Promise<Environment> {
		return await this.fromContext();
	}

	/**
	 * @description Gets an Environment by name
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
	 * @description Creates an Environment
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
	 * @description Returns the list of Environments
	 */
	async list(): Promise<EnvironmentListEntry[]> {
		const resp = await this.#client.cpClient.environmentList({});
		return resp.items.map(environmentListEntryFromProto);
	}

	/**
	 * @description Deletes an Environment
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

	static async create(
		name: string,
		params: EnvironmentCreateParams = {},
	): Promise<void> {
		await getDefaultClient().environments.create(name, params);
	}

	static async list(): Promise<EnvironmentListEntry[]> {
		return await getDefaultClient().environments.list();
	}

	static async delete(name: string): Promise<void> {
		await getDefaultClient().environments.delete(name);
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
	 * @description Returns Environment information
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
	 * @description Updates an Environment
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
 * @description Environment billing manager
 */
export class EnvironmentBillingManager {
	readonly #client: ModalClient;
	readonly #environmentId: string;

	constructor(client: ModalClient, environmentId: string) {
		this.#client = client;
		this.#environmentId = environmentId;
	}

	/**
	 * @description Returns a billing report for Environment usage
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
 * @description Members manager for a restricted Environment
 */
export class EnvironmentMembersManager {
	readonly #client: ModalClient;
	readonly #environmentId: string;

	constructor(client: ModalClient, environmentId: string) {
		this.#client = client;
		this.#environmentId = environmentId;
	}

	/**
	 * @description Returns members of a restricted Environment
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
	 * @description Adds or updates members of a restricted Environment
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
	 * @description Removes members from a restricted Environment
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

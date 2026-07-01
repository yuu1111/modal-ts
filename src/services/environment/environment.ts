import type { ModalClient } from "@/core/client";
import {
	type EnvironmentListItem,
	type EnvironmentMetadata,
	ObjectCreationType,
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

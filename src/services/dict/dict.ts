import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError, NotFoundError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import {
	type DictMetadata,
	ObjectCreationType,
} from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";
import { loads as pickleDecode, dumps as pickleEncode } from "@/utils/pickle";

/**
 * @description {@link DictService#fromName client.dicts.fromName()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property createIfMissing - 存在しない場合に自動作成するかどうか
 */
export type DictFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * @description {@link DictService#create client.dicts.create()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowExisting - 既に存在する場合に成功として扱うか
 */
export type DictCreateParams = {
	environment?: string;
	allowExisting?: boolean;
};

/**
 * @description {@link DictService#list client.dicts.list()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property maxObjects - 最大取得件数
 * @property createdBefore - この Unix 秒より前に作成された Dict だけを返す
 */
export type DictListParams = {
	environment?: string;
	maxObjects?: number;
	createdBefore?: number;
};

/**
 * @description {@link DictService#delete client.dicts.delete()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowMissing - 存在しない場合にエラーを抑制するかどうか
 */
export type DictDeleteParams = {
	environment?: string;
	allowMissing?: boolean;
};

/**
 * @description {@link DictService#ephemeral client.dicts.ephemeral()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type DictEphemeralParams = {
	environment?: string;
};

/**
 * @description Dict オブジェクトのメタデータ
 */
export type DictInfo = {
	name?: string;
	createdAt?: number;
	createdBy?: string;
};

/**
 * @description {@link Dict} を管理するサービス
 */
export class DictService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 名前付き Dict を作成する
	 * @param name - Dict 名
	 * @param params - オプションパラメータ
	 */
	async create(name: string, params: DictCreateParams = {}): Promise<void> {
		await this.#client.cpClient.dictGetOrCreate({
			deploymentName: name,
			environmentName: this.#client.environmentName(params.environment),
			objectCreationType: params.allowExisting
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS,
		});
	}

	/**
	 * @description 名前のない一時的な Dict を作成する
	 * @param params - オプションパラメータ
	 */
	async ephemeral(params: DictEphemeralParams = {}): Promise<Dict> {
		const resp = await this.#client.cpClient.dictGetOrCreate({
			environmentName: this.#client.environmentName(params.environment),
			objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
		});

		const ephemeralHbManager = new EphemeralHeartbeatManager(() =>
			this.#client.cpClient.dictHeartbeat({ dictId: resp.dictId }),
		);
		return new Dict(this.#client, resp.dictId, undefined, ephemeralHbManager);
	}

	/**
	 * @description IDで Dict を参照する
	 * @param dictId - Dict ID
	 */
	async fromId(dictId: string): Promise<Dict> {
		try {
			const resp = await this.#client.cpClient.dictGetById({ dictId });
			return new Dict(
				this.#client,
				dictId,
				resp.metadata?.name || undefined,
				undefined,
				dictInfoFromMetadata(resp.metadata),
			);
		} catch (err) {
			rethrowNotFound(err, `Dict with id: '${dictId}' not found`);
		}
	}

	async from_id(dictId: string): Promise<Dict> {
		return await this.fromId(dictId);
	}

	/**
	 * @description 名前で Dict を参照する
	 * @param name - Dict 名
	 * @param params - オプションパラメータ
	 */
	async fromName(name: string, params: DictFromNameParams = {}): Promise<Dict> {
		try {
			const resp = await this.#client.cpClient.dictGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(params.environment),
				objectCreationType: params.createIfMissing
					? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
					: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED,
			});
			return new Dict(
				this.#client,
				resp.dictId,
				resp.metadata?.name || name,
				undefined,
				dictInfoFromMetadata(resp.metadata, name),
			);
		} catch (err) {
			rethrowNotFound(err);
		}
	}

	async from_name(
		name: string,
		params: DictFromNameParams = {},
	): Promise<Dict> {
		return await this.fromName(name, params);
	}

	/**
	 * @description 名前付き Dict の一覧を取得する
	 * @param params - オプションパラメータ
	 */
	async list(params: DictListParams = {}): Promise<Dict[]> {
		if (params.maxObjects !== undefined && params.maxObjects < 0) {
			throw new InvalidError("maxObjects cannot be negative");
		}

		const dicts: Dict[] = [];
		let createdBefore = params.createdBefore ?? 0;
		while (
			params.maxObjects === undefined ||
			dicts.length < params.maxObjects
		) {
			const maxPageSize =
				params.maxObjects === undefined
					? 100
					: Math.min(100, params.maxObjects - dicts.length);
			const resp = await this.#client.cpClient.dictList({
				environmentName: this.#client.environmentName(params.environment),
				pagination: { maxObjects: maxPageSize, createdBefore },
			});
			if (!resp.dicts || resp.dicts.length === 0) break;
			for (const item of resp.dicts) {
				dicts.push(
					new Dict(
						this.#client,
						item.dictId,
						item.metadata?.name || item.name || undefined,
						undefined,
						dictInfoFromMetadata(item.metadata, item.name, item.createdAt),
					),
				);
			}
			if (resp.dicts.length < maxPageSize) break;
			createdBefore =
				resp.dicts[resp.dicts.length - 1]?.metadata?.creationInfo?.createdAt ??
				resp.dicts[resp.dicts.length - 1]?.createdAt ??
				0;
		}

		return dicts;
	}

	/**
	 * @description 名前付き Dict を削除する
	 * @param name - Dict 名
	 * @param params - オプションパラメータ
	 */
	async delete(name: string, params: DictDeleteParams = {}): Promise<void> {
		try {
			const dict = await this.fromName(name, {
				...(params.environment !== undefined && {
					environment: params.environment,
				}),
			});
			await this.#client.cpClient.dictDelete({ dictId: dict.dictId });
		} catch (err) {
			suppressNotFound(err, params.allowMissing);
		}
	}
}

/**
 * @description 分散 key-value store
 */
export class Dict {
	readonly #client: ModalClient;
	readonly dictId: string;
	readonly name?: string;
	readonly #ephemeralHbManager?: EphemeralHeartbeatManager;
	readonly #info?: DictInfo;

	/** @internal */
	constructor(
		client: ModalClient,
		dictId: string,
		name?: string,
		ephemeralHbManager?: EphemeralHeartbeatManager,
		info?: DictInfo,
	) {
		this.#client = client;
		this.dictId = dictId;
		if (name !== undefined) this.name = name;
		if (ephemeralHbManager !== undefined)
			this.#ephemeralHbManager = ephemeralHbManager;
		if (info !== undefined) this.#info = info;
	}

	static get objects(): DictService {
		return getDefaultClient().dicts;
	}

	static async from_name(
		name: string,
		params: DictFromNameParams = {},
	): Promise<Dict> {
		return await getDefaultClient().dicts.fromName(name, params);
	}

	static async from_id(dictId: string): Promise<Dict> {
		return await getDefaultClient().dicts.fromId(dictId);
	}

	/**
	 * @description Dict のメタデータを返す
	 */
	info(): DictInfo {
		return this.#info ?? dictInfoFromMetadata(undefined, this.name);
	}

	/**
	 * @description 一時的な Dict の heartbeat を停止する
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("Dict is not ephemeral.");
		}
	}

	/**
	 * @description Dict の値をすべて削除する
	 */
	async clear(): Promise<void> {
		await this.#client.cpClient.dictClear({ dictId: this.dictId });
	}

	/**
	 * @description key が存在するか返す
	 * @param key - key
	 */
	async contains(key: unknown): Promise<boolean> {
		const resp = await this.#client.cpClient.dictContains({
			dictId: this.dictId,
			key: pickleEncode(key),
		});
		return resp.found;
	}

	/**
	 * @description key の値を取得する
	 * @param key - key
	 * @param defaultValue - key が存在しない場合に返す値
	 */
	async get(key: unknown, ...defaultValue: [unknown?]): Promise<unknown> {
		const resp = await this.#client.cpClient.dictGet({
			dictId: this.dictId,
			key: pickleEncode(key),
		});
		if (!resp.found) {
			if (defaultValue.length > 0) return defaultValue[0];
			throw new NotFoundError("Key not found");
		}
		if (resp.value === undefined) return undefined;
		return pickleDecode(resp.value);
	}

	/**
	 * @description key/value を保存する
	 * @param key - key
	 * @param value - value
	 */
	async put(key: unknown, value: unknown): Promise<void> {
		await this.update([[key, value]]);
	}

	/**
	 * @description 複数の key/value を保存する
	 * @param entries - entries
	 * @param params - ifNotExists 指定時は既存 key を上書きしない
	 */
	async update(
		entries: Iterable<[unknown, unknown]> | Record<string, unknown>,
		params: { ifNotExists?: boolean } = {},
	): Promise<boolean> {
		const iterable =
			typeof (entries as Iterable<[unknown, unknown]>)[Symbol.iterator] ===
			"function"
				? (entries as Iterable<[unknown, unknown]>)
				: Object.entries(entries as Record<string, unknown>);
		const resp = await this.#client.cpClient.dictUpdate({
			dictId: this.dictId,
			updates: Array.from(iterable, ([key, value]) => ({
				key: pickleEncode(key),
				value: pickleEncode(value),
			})),
			ifNotExists: params.ifNotExists ?? false,
		});
		return resp.created;
	}

	/**
	 * @description key を削除し、存在すれば値を返す
	 * @param key - key
	 * @param defaultValue - key が存在しない場合に返す値
	 */
	async pop(key: unknown, ...defaultValue: [unknown?]): Promise<unknown> {
		const resp = await this.#client.cpClient.dictPop({
			dictId: this.dictId,
			key: pickleEncode(key),
		});
		if (!resp.found) {
			if (defaultValue.length > 0) return defaultValue[0];
			throw new NotFoundError("Key not found");
		}
		if (resp.value === undefined) return undefined;
		return pickleDecode(resp.value);
	}

	/**
	 * @description Dict 内の entry 数を返す
	 */
	async len(): Promise<number> {
		const resp = await this.#client.cpClient.dictLen({ dictId: this.dictId });
		return resp.len;
	}

	/**
	 * @description Dict の key を iterate する
	 */
	async *keys(): AsyncGenerator<unknown, void, unknown> {
		for await (const entry of this.#client.cpClient.dictContents({
			dictId: this.dictId,
			keys: true,
			values: false,
		})) {
			yield pickleDecode(entry.key);
		}
	}

	/**
	 * @description Dict の value を iterate する
	 */
	async *values(): AsyncGenerator<unknown, void, unknown> {
		for await (const entry of this.#client.cpClient.dictContents({
			dictId: this.dictId,
			keys: false,
			values: true,
		})) {
			yield pickleDecode(entry.value);
		}
	}

	/**
	 * @description Dict の key/value を iterate する
	 */
	async *items(): AsyncGenerator<[unknown, unknown], void, unknown> {
		for await (const entry of this.#client.cpClient.dictContents({
			dictId: this.dictId,
			keys: true,
			values: true,
		})) {
			yield [pickleDecode(entry.key), pickleDecode(entry.value)];
		}
	}
}

function dictInfoFromMetadata(
	metadata?: DictMetadata,
	fallbackName?: string,
	fallbackCreatedAt?: number,
): DictInfo {
	const info: DictInfo = {};
	const name = metadata?.name || fallbackName;
	const createdAt = metadata?.creationInfo?.createdAt || fallbackCreatedAt;
	const createdBy = metadata?.creationInfo?.createdBy;
	if (name) info.name = name;
	if (createdAt) info.createdAt = createdAt;
	if (createdBy) info.createdBy = createdBy;
	return info;
}

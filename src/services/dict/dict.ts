import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError, NotFoundError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import {
	type DictMetadata,
	ObjectCreationType,
} from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";
import {
	aliasedBoolean,
	aliasedNumber,
	environmentParam,
} from "@/utils/param_aliases";
import { loads as pickleDecode, dumps as pickleEncode } from "@/utils/pickle";

/**
 * @description Optional parameters for {@link DictService#fromName client.dicts.fromName()}
 * @property environment - Environment name to use
 * @property createIfMissing - Whether to create automatically when missing
 */
export type DictFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	createIfMissing?: boolean;
	create_if_missing?: boolean;
};

/**
 * @description Optional parameters for {@link DictService#create client.dicts.create()}
 * @property environment - Environment name to use
 * @property allowExisting - Whether to treat an existing Dict as success
 */
export type DictCreateParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowExisting?: boolean;
	allow_existing?: boolean;
};

/**
 * @description Optional parameters for {@link DictService#list client.dicts.list()}
 * @property environment - Environment name to use
 * @property maxObjects - Maximum number of objects to fetch
 * @property createdBefore - Return only Dicts created before this Unix timestamp
 */
export type DictListParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	maxObjects?: number;
	max_objects?: number;
	createdBefore?: number;
	created_before?: number;
};

/**
 * @description Optional parameters for {@link DictService#delete client.dicts.delete()}
 * @property environment - Environment name to use
 * @property allowMissing - Whether to suppress errors when the Dict does not exist
 */
export type DictDeleteParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowMissing?: boolean;
	allow_missing?: boolean;
};

/**
 * @description Optional parameters for {@link DictService#ephemeral client.dicts.ephemeral()}
 * @property environment - Environment name to use
 */
export type DictEphemeralParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * @description Metadata for a Dict object
 */
export type DictInfo = {
	name?: string;
	createdAt?: number;
	createdBy?: string;
};

/**
 * @description Service for managing {@link Dict}
 */
export class DictService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Creates a named Dict
	 * @param name - Dict name
	 * @param params - Optional parameters
	 */
	async create(name: string, params: DictCreateParams = {}): Promise<void> {
		await this.#client.cpClient.dictGetOrCreate({
			deploymentName: name,
			environmentName: this.#client.environmentName(environmentParam(params)),
			objectCreationType: aliasedBoolean(
				params,
				"allowExisting",
				"allow_existing",
			)
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS,
		});
	}

	/**
	 * @description Creates an unnamed ephemeral Dict
	 * @param params - Optional parameters
	 */
	async ephemeral(params: DictEphemeralParams = {}): Promise<Dict> {
		const resp = await this.#client.cpClient.dictGetOrCreate({
			environmentName: this.#client.environmentName(environmentParam(params)),
			objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
		});

		const ephemeralHbManager = new EphemeralHeartbeatManager(() =>
			this.#client.cpClient.dictHeartbeat({ dictId: resp.dictId }),
		);
		return new Dict(this.#client, resp.dictId, undefined, ephemeralHbManager);
	}

	/**
	 * @description Looks up a Dict by ID
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
	 * @description Looks up a Dict by name
	 * @param name - Dict name
	 * @param params - Optional parameters
	 */
	async fromName(name: string, params: DictFromNameParams = {}): Promise<Dict> {
		try {
			const resp = await this.#client.cpClient.dictGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(environmentParam(params)),
				objectCreationType: aliasedBoolean(
					params,
					"createIfMissing",
					"create_if_missing",
				)
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
	 * @description Lists named Dicts
	 * @param params - Optional parameters
	 */
	async list(params: DictListParams = {}): Promise<Dict[]> {
		const maxObjects = aliasedNumber(params, "maxObjects", "max_objects");
		if (maxObjects !== undefined && maxObjects < 0) {
			throw new InvalidError("maxObjects cannot be negative");
		}

		const dicts: Dict[] = [];
		let createdBefore =
			aliasedNumber(params, "createdBefore", "created_before") ?? 0;
		while (maxObjects === undefined || dicts.length < maxObjects) {
			const maxPageSize =
				maxObjects === undefined
					? 100
					: Math.min(100, maxObjects - dicts.length);
			const resp = await this.#client.cpClient.dictList({
				environmentName: this.#client.environmentName(environmentParam(params)),
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
	 * @description Deletes a named Dict
	 * @param name - Dict name
	 * @param params - Optional parameters
	 */
	async delete(name: string, params: DictDeleteParams = {}): Promise<void> {
		try {
			const environment = environmentParam(params);
			const dict = await this.fromName(name, {
				...(environment !== undefined && { environment }),
			});
			await this.#client.cpClient.dictDelete({ dictId: dict.dictId });
		} catch (err) {
			suppressNotFound(
				err,
				aliasedBoolean(params, "allowMissing", "allow_missing"),
			);
		}
	}
}

/**
 * @description Distributed key-value store
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

	static async create(
		name: string,
		params: DictCreateParams = {},
	): Promise<void> {
		await getDefaultClient().dicts.create(name, params);
	}

	static async list(params: DictListParams = {}): Promise<Dict[]> {
		return await getDefaultClient().dicts.list(params);
	}

	static async delete(
		name: string,
		params: DictDeleteParams = {},
	): Promise<void> {
		await getDefaultClient().dicts.delete(name, params);
	}

	static async ephemeral(params: DictEphemeralParams = {}): Promise<Dict> {
		return await getDefaultClient().dicts.ephemeral(params);
	}

	static async from_name(
		name: string,
		params: DictFromNameParams = {},
	): Promise<Dict> {
		return await getDefaultClient().dicts.fromName(name, params);
	}

	static async fromName(
		name: string,
		params: DictFromNameParams = {},
	): Promise<Dict> {
		return await Dict.from_name(name, params);
	}

	static async from_id(dictId: string): Promise<Dict> {
		return await getDefaultClient().dicts.fromId(dictId);
	}

	static async fromId(dictId: string): Promise<Dict> {
		return await Dict.from_id(dictId);
	}

	/**
	 * @description Returns Dict metadata
	 */
	info(): DictInfo {
		return this.#info ?? dictInfoFromMetadata(undefined, this.name);
	}

	/**
	 * @description Stops the heartbeat for an ephemeral Dict
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("Dict is not ephemeral.");
		}
	}

	/**
	 * @description Removes all values from the Dict
	 */
	async clear(): Promise<void> {
		await this.#client.cpClient.dictClear({ dictId: this.dictId });
	}

	/**
	 * @description Returns whether a key exists
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
	 * @description Gets the value for a key
	 * @param key - key
	 * @param defaultValue - Value returned when the key does not exist
	 */
	async get(key: unknown, ...defaultValue: [unknown?]): Promise<unknown> {
		const resp = await this.#client.cpClient.dictGet({
			dictId: this.dictId,
			key: pickleEncode(key),
		});
		if (!resp.found) {
			if (defaultValue.length > 0) return defaultValue[0];
			return undefined;
		}
		if (resp.value === undefined) return undefined;
		return pickleDecode(resp.value);
	}

	/**
	 * @description Stores a key/value pair
	 * @param key - key
	 * @param value - value
	 */
	async put(
		key: unknown,
		value: unknown,
		params: { skipIfExists?: boolean; skip_if_exists?: boolean } = {},
	): Promise<void> {
		const ifNotExists = aliasedBoolean(
			params,
			"skipIfExists",
			"skip_if_exists",
		);
		await this.update(
			[[key, value]],
			ifNotExists === undefined ? {} : { ifNotExists },
		);
	}

	/**
	 * @description Stores multiple key/value pairs
	 * @param entries - entries
	 * @param params - When ifNotExists is set, existing keys are not overwritten
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
	 * @description Removes a key and returns its value if present
	 * @param key - key
	 * @param defaultValue - Value returned when the key does not exist
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
	 * @description Returns the number of entries in the Dict
	 */
	async len(): Promise<number> {
		const resp = await this.#client.cpClient.dictLen({ dictId: this.dictId });
		return resp.len;
	}

	/**
	 * @description Iterates Dict keys
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
	 * @description Iterates Dict values
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
	 * @description Iterates Dict key/value pairs
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

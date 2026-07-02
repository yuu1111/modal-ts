import { readFile } from "node:fs/promises";
import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import {
	rethrowInvalid,
	rethrowNotFound,
	suppressNotFound,
} from "@/core/grpc/errors";
import {
	ObjectCreationType,
	type SecretMetadata,
} from "@/generated/modal_proto/api";

/**
 * @description {@link SecretService#fromName client.secrets.fromName()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property requiredKeys - Secret に必須のキー一覧
 */
export type SecretFromNameParams = {
	environment?: string;
	requiredKeys?: string[];
};

/**
 * @description {@link SecretService#fromObject client.secrets.fromObject()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type SecretFromObjectParams = {
	environment?: string;
};

/**
 * @description {@link SecretService#fromDotenv client.secrets.fromDotenv()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type SecretFromDotenvParams = {
	environment?: string;
};

/**
 * @description {@link SecretService#fromLocalEnviron client.secrets.fromLocalEnviron()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type SecretFromLocalEnvironParams = {
	environment?: string;
};

/**
 * @description {@link SecretService#create client.secrets.create()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowExisting - 既に存在する場合に成功として扱うか
 */
export type SecretCreateParams = {
	environment?: string;
	allowExisting?: boolean;
};

/**
 * @description {@link SecretService#list client.secrets.list()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property maxObjects - 最大取得件数
 * @property createdBefore - この Unix 秒より前に作成された Secret だけを返す
 */
export type SecretListParams = {
	environment?: string;
	maxObjects?: number;
	createdBefore?: number;
};

/**
 * @description {@link SecretService#update client.secrets.update()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type SecretUpdateParams = {
	environment?: string;
};

/**
 * @description {@link SecretService#delete client.secrets.delete()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowMissing - 存在しない場合にエラーを抑制するかどうか
 */
export type SecretDeleteParams = {
	environment?: string;
	allowMissing?: boolean;
};

/**
 * @description {@link Secret} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const secret = await modal.secrets.fromName("my-secret");
 * ```
 */
export class SecretService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 名前で {@link Secret} を参照する
	 * @param name - Secret の名前
	 * @param params - オプションパラメータ
	 * @returns Secret インスタンス
	 */
	async fromName(name: string, params?: SecretFromNameParams): Promise<Secret> {
		try {
			const resp = await this.#client.cpClient.secretGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(params?.environment),
				requiredKeys: params?.requiredKeys ?? [],
			});
			this.#client.logger.debug(
				"Retrieved Secret",
				"secret_id",
				resp.secretId,
				"secret_name",
				name,
			);
			return new Secret(resp.secretId, name);
		} catch (err) {
			rethrowNotFound(err, { preconditionPatterns: ["Secret is missing key"] });
		}
	}

	async from_name(
		name: string,
		params?: SecretFromNameParams,
	): Promise<Secret> {
		return await this.fromName(name, params);
	}

	/**
	 * @description キーと値のペアから {@link Secret} を作成する
	 * @param entries - 文字列のキーと値のオブジェクト
	 * @param params - オプションパラメータ
	 * @returns Secret インスタンス
	 */
	async fromObject(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		for (const value of Object.values(entries)) {
			if (value == null || typeof value !== "string") {
				throw new InvalidError(
					"entries must be an object mapping string keys to string values, but got:\n" +
						JSON.stringify(entries),
				);
			}
		}

		try {
			const resp = await this.#client.cpClient.secretGetOrCreate({
				objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
				envDict: entries,
				environmentName: this.#client.environmentName(params?.environment),
			});
			this.#client.logger.debug(
				"Created ephemeral Secret",
				"secret_id",
				resp.secretId,
			);
			return new Secret(resp.secretId);
		} catch (err) {
			rethrowInvalid(err, { preconditionPatterns: [] });
		}
	}

	async from_dict(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await this.fromObject(entries, params);
	}

	/**
	 * @description .env ファイルから一時的な {@link Secret} を作成する
	 * @param path - .env ファイルのパス
	 * @param params - オプションパラメータ
	 */
	async fromDotenv(
		path = ".env",
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		const contents = await readFile(path, "utf8");
		return await this.fromObject(parseDotenv(contents), params);
	}

	async from_dotenv(
		path?: string,
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		return await this.fromDotenv(path, params);
	}

	/**
	 * @description ローカル環境変数から一時的な {@link Secret} を作成する
	 * @param keys - 取り込む環境変数名。省略時は現在の環境変数をすべて取り込む
	 * @param params - オプションパラメータ
	 */
	async fromLocalEnviron(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		const entries: Record<string, string> = {};
		for (const key of keys ?? Object.keys(process.env)) {
			const value = process.env[key];
			if (value === undefined) {
				throw new InvalidError(`Environment variable ${key} is not set`);
			}
			entries[key] = value;
		}
		return await this.fromObject(entries, params);
	}

	async from_local_environ(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		return await this.fromLocalEnviron(keys, params);
	}

	/**
	 * @description 名前付き Secret を作成する
	 * @param name - Secret 名
	 * @param entries - 保存するキーと値
	 * @param params - オプションパラメータ
	 */
	async create(
		name: string,
		entries: Record<string, string>,
		params: SecretCreateParams = {},
	): Promise<void> {
		validateSecretEntries(entries);
		await this.#client.cpClient.secretGetOrCreate({
			deploymentName: name,
			envDict: entries,
			objectCreationType: params.allowExisting
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS,
			environmentName: this.#client.environmentName(params.environment),
		});
	}

	/**
	 * @description 名前付き Secret の一覧を取得する
	 * @param params - オプションパラメータ
	 */
	async list(params: SecretListParams = {}): Promise<Secret[]> {
		if (params.maxObjects !== undefined && params.maxObjects < 0) {
			throw new InvalidError("maxObjects cannot be negative");
		}

		const secrets: Secret[] = [];
		let createdBefore = params.createdBefore ?? 0;
		while (
			params.maxObjects === undefined ||
			secrets.length < params.maxObjects
		) {
			const maxPageSize =
				params.maxObjects === undefined
					? 100
					: Math.min(100, params.maxObjects - secrets.length);
			const resp = await this.#client.cpClient.secretList({
				environmentName: this.#client.environmentName(params.environment),
				pagination: { maxObjects: maxPageSize, createdBefore },
			});

			if (!resp.items || resp.items.length === 0) break;
			for (const item of resp.items) {
				secrets.push(
					new Secret(
						item.secretId,
						item.metadata?.name || item.label || undefined,
						secretInfoFromMetadata(item.metadata, item.label),
					),
				);
			}
			if (resp.items.length < maxPageSize) break;
			createdBefore =
				resp.items[resp.items.length - 1]?.metadata?.creationInfo?.createdAt ??
				0;
		}

		return secrets;
	}

	/**
	 * @description 名前付き Secret のキーを更新する。値が null のキーは削除される
	 * @param name - Secret 名
	 * @param updates - 更新内容
	 * @param params - オプションパラメータ
	 */
	async update(
		name: string,
		updates: Record<string, string | null>,
		params: SecretUpdateParams = {},
	): Promise<void> {
		const secret = await this.fromName(name, {
			...(params.environment !== undefined && {
				environment: params.environment,
			}),
		});
		await this.#client.cpClient.secretUpdate({
			secretId: secret.secretId,
			updates: Object.entries(updates).map(([key, value]) => ({
				key,
				...(value !== null && { value }),
			})),
		});
	}

	/**
	 * @description 名前付き {@link Secret} を削除する。削除は不可逆で、現在使用中の App にも影響する
	 * @param name - 削除する Secret の名前
	 * @param params - オプションパラメータ
	 */
	async delete(name: string, params?: SecretDeleteParams): Promise<void> {
		try {
			const secret = await this.fromName(name, {
				...(params?.environment !== undefined && {
					environment: params.environment,
				}),
			});
			await this.#client.cpClient.secretDelete({
				secretId: secret.secretId,
			});
			this.#client.logger.debug(
				"Deleted Secret",
				"secret_name",
				name,
				"secret_id",
				secret.secretId,
			);
		} catch (err) {
			suppressNotFound(err, params?.allowMissing);
		}
	}
}

/**
 * @description {@link Image} に環境変数の辞書を提供する Secret
 */
export class Secret {
	readonly secretId: string;
	readonly name?: string;
	readonly #info?: SecretInfo;

	/**
	 * @internal
	 */
	constructor(secretId: string, name?: string, info?: SecretInfo) {
		this.secretId = secretId;
		if (name !== undefined) this.name = name;
		if (info !== undefined) this.#info = info;
	}

	static get objects(): SecretService {
		return getDefaultClient().secrets;
	}

	static async create(
		name: string,
		entries: Record<string, string>,
		params: SecretCreateParams = {},
	): Promise<void> {
		await getDefaultClient().secrets.create(name, entries, params);
	}

	static async list(params: SecretListParams = {}): Promise<Secret[]> {
		return await getDefaultClient().secrets.list(params);
	}

	static async delete(
		name: string,
		params?: SecretDeleteParams,
	): Promise<void> {
		await getDefaultClient().secrets.delete(name, params);
	}

	static async from_name(
		name: string,
		params?: SecretFromNameParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromName(name, params);
	}

	static async fromName(
		name: string,
		params?: SecretFromNameParams,
	): Promise<Secret> {
		return await Secret.from_name(name, params);
	}

	static async from_dict(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromObject(entries, params);
	}

	static async fromDict(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await Secret.from_dict(entries, params);
	}

	static async from_object(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await Secret.from_dict(entries, params);
	}

	static async fromObject(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await Secret.from_object(entries, params);
	}

	static async from_dotenv(
		path?: string,
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromDotenv(path, params);
	}

	static async fromDotenv(
		path?: string,
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		return await Secret.from_dotenv(path, params);
	}

	static async from_local_environ(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromLocalEnviron(keys, params);
	}

	static async fromLocalEnviron(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		return await Secret.from_local_environ(keys, params);
	}

	/**
	 * @description Secret のメタデータを返す
	 */
	info(): SecretInfo {
		return this.#info ?? secretInfoFromMetadata(undefined, this.name);
	}

	async update(
		updates: Record<string, string | null>,
		params: SecretUpdateParams = {},
	): Promise<void> {
		if (!this.name) {
			throw new InvalidError("Cannot update a Secret handle without a name.");
		}
		await getDefaultClient().secrets.update(this.name, updates, params);
	}
}

/**
 * @description 環境変数オブジェクトを Secret 配列にマージする。env が指定されている場合、一時的な Secret を作成して追加する
 * @param client - Modal クライアント
 * @param env - マージする環境変数
 * @param secrets - 既存の Secret 配列
 * @returns マージ済みの Secret 配列
 */
export async function mergeEnvIntoSecrets(
	client: ModalClient,
	env?: Record<string, string>,
	secrets?: Secret[],
): Promise<Secret[]> {
	const result = [...(secrets || [])];
	if (env && Object.keys(env).length > 0) {
		result.push(await client.secrets.fromObject(env));
	}
	return result;
}

/**
 * @description Secret オブジェクトのメタデータ
 */
export type SecretInfo = {
	name?: string;
	createdAt?: number;
	createdBy?: string;
};

function validateSecretEntries(entries: Record<string, string>) {
	for (const value of Object.values(entries)) {
		if (value == null || typeof value !== "string") {
			throw new InvalidError(
				"entries must be an object mapping string keys to string values, but got:\n" +
					JSON.stringify(entries),
			);
		}
	}
}

function parseDotenv(contents: string): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
		const eq = normalized.indexOf("=");
		if (eq < 0) continue;
		const key = normalized.slice(0, eq).trim();
		let value = normalized.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) entries[key] = value;
	}
	return entries;
}

function secretInfoFromMetadata(
	metadata?: SecretMetadata,
	fallbackName?: string,
): SecretInfo {
	const info: SecretInfo = {};
	const name = metadata?.name || fallbackName;
	const createdAt = metadata?.creationInfo?.createdAt;
	const createdBy = metadata?.creationInfo?.createdBy;
	if (name) info.name = name;
	if (createdAt) info.createdAt = createdAt;
	if (createdBy) info.createdBy = createdBy;
	return info;
}

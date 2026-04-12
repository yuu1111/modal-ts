import { ClientError, Status } from "nice-grpc";
import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError, NotFoundError } from "@/core/errors";
import { ObjectCreationType } from "@/generated/modal_proto/api";

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
 * @description {@link SecretService#delete client.secrets.delete()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowMissing - 存在しない場合にエラーを抑制するかどうか
 */
export type SecretDeleteParams = {
	environment?: string;
	allowMissing?: boolean;
};

/**
 * Service for managing {@link Secret Secrets}.
 *
 * Normally only ever accessed via the client as:
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
			if (err instanceof ClientError && err.code === Status.NOT_FOUND)
				throw new NotFoundError(err.details);
			if (
				err instanceof ClientError &&
				err.code === Status.FAILED_PRECONDITION &&
				err.details.includes("Secret is missing key")
			)
				throw new NotFoundError(err.details);
			throw err;
		}
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
		for (const [, value] of Object.entries(entries)) {
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
				envDict: entries as Record<string, string>,
				environmentName: this.#client.environmentName(params?.environment),
			});
			this.#client.logger.debug(
				"Created ephemeral Secret",
				"secret_id",
				resp.secretId,
			);
			return new Secret(resp.secretId);
		} catch (err) {
			if (
				err instanceof ClientError &&
				(err.code === Status.INVALID_ARGUMENT ||
					err.code === Status.FAILED_PRECONDITION)
			)
				throw new InvalidError(err.details);
			throw err;
		}
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
			const isNotFound =
				err instanceof NotFoundError ||
				(err instanceof ClientError && err.code === Status.NOT_FOUND);
			if (isNotFound && params?.allowMissing) {
				return;
			}
			throw err;
		}
	}
}

/**
 * @description {@link Image} に環境変数の辞書を提供する Secret
 */
export class Secret {
	readonly secretId: string;
	readonly name?: string;

	/** @internal */
	constructor(secretId: string, name?: string) {
		this.secretId = secretId;
		if (name !== undefined) this.name = name;
	}

	/**
	 * @deprecated Use {@link SecretService#fromName client.secrets.fromName()} instead.
	 */
	static async fromName(
		name: string,
		params?: SecretFromNameParams,
	): Promise<Secret> {
		return getDefaultClient().secrets.fromName(name, params);
	}

	/**
	 * @deprecated Use {@link SecretService#fromObject client.secrets.fromObject()} instead.
	 */
	static async fromObject(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return getDefaultClient().secrets.fromObject(entries, params);
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

import { ClientError, Status } from "nice-grpc";
import type { ModalClient } from "@/core/client";
import { InvalidError, NotFoundError } from "@/core/errors";
import { ObjectCreationType } from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";

/**
 * @description {@link VolumeService#fromName client.volumes.fromName()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property createIfMissing - 存在しない場合に自動作成するかどうか
 */
export type VolumeFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * @description {@link VolumeService#ephemeral client.volumes.ephemeral()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type VolumeEphemeralParams = {
	environment?: string;
};

/**
 * @description {@link VolumeService#delete client.volumes.delete()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowMissing - 存在しない場合にエラーを抑制するかどうか
 */
export type VolumeDeleteParams = {
	environment?: string;
	allowMissing?: boolean;
};

/**
 * Service for managing {@link Volume}s.
 *
 * Normally only ever accessed via the client as:
 * ```typescript
 * const modal = new ModalClient();
 * const volume = await modal.volumes.fromName("my-volume");
 * ```
 */
export class VolumeService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 名前で {@link Volume} を参照する
	 * @param name - Volume の名前
	 * @param params - オプションパラメータ
	 * @returns Volume インスタンス
	 */
	async fromName(name: string, params?: VolumeFromNameParams): Promise<Volume> {
		try {
			const resp = await this.#client.cpClient.volumeGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(params?.environment),
				objectCreationType: params?.createIfMissing
					? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
					: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED,
			});
			this.#client.logger.debug(
				"Retrieved Volume",
				"volume_id",
				resp.volumeId,
				"volume_name",
				name,
			);
			return new Volume(resp.volumeId, name);
		} catch (err) {
			if (err instanceof ClientError && err.code === Status.NOT_FOUND)
				throw new NotFoundError(err.details);
			throw err;
		}
	}

	/**
	 * @description 名前のない一時的な {@link Volume} を作成する。closeEphemeral() が呼ばれるかプロセスが終了するまで存続する
	 * @param params - オプションパラメータ
	 * @returns 一時的な Volume インスタンス
	 */
	async ephemeral(params: VolumeEphemeralParams = {}): Promise<Volume> {
		const resp = await this.#client.cpClient.volumeGetOrCreate({
			objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
			environmentName: this.#client.environmentName(params.environment),
		});

		this.#client.logger.debug(
			"Created ephemeral Volume",
			"volume_id",
			resp.volumeId,
		);

		const ephemeralHbManager = new EphemeralHeartbeatManager(() =>
			this.#client.cpClient.volumeHeartbeat({ volumeId: resp.volumeId }),
		);

		return new Volume(resp.volumeId, undefined, false, ephemeralHbManager);
	}

	/**
	 * @description 名前付き {@link Volume} を削除する。削除は不可逆で、現在使用中の App にも影響する
	 * @param name - 削除する Volume の名前
	 * @param params - オプションパラメータ
	 */
	async delete(name: string, params?: VolumeDeleteParams): Promise<void> {
		try {
			const volume = await this.fromName(name, {
				...(params?.environment !== undefined && {
					environment: params.environment,
				}),
				createIfMissing: false,
			});
			await this.#client.cpClient.volumeDelete({
				volumeId: volume.volumeId,
			});
			this.#client.logger.debug(
				"Deleted Volume",
				"volume_name",
				name,
				"volume_id",
				volume.volumeId,
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
 * @description Modal {@link Function_ Function} にマウント可能な永続ストレージを提供する Volume
 */
export class Volume {
	readonly volumeId: string;
	readonly name?: string;
	private _readOnly: boolean = false;
	readonly #ephemeralHbManager?: EphemeralHeartbeatManager;

	/** @internal */
	constructor(
		volumeId: string,
		name?: string,
		readOnly: boolean = false,
		ephemeralHbManager?: EphemeralHeartbeatManager,
	) {
		this.volumeId = volumeId;
		if (name !== undefined) this.name = name;
		this._readOnly = readOnly;
		if (ephemeralHbManager !== undefined)
			this.#ephemeralHbManager = ephemeralHbManager;
	}

	/**
	 * @description Volume を読み取り専用でマウントするよう設定する
	 * @returns 読み取り専用に設定された新しい Volume インスタンス
	 */
	readOnly(): Volume {
		return new Volume(this.volumeId, this.name, true, this.#ephemeralHbManager);
	}

	get isReadOnly(): boolean {
		return this._readOnly;
	}

	/**
	 * @description 一時的な Volume を削除する。一時的な Volume でのみ使用可能
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("Volume is not ephemeral.");
		}
	}
}

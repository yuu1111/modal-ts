import type { ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import { rethrowNotFound } from "@/core/grpc/errors";
import {
	type GenericResult,
	GenericResult_GenericStatus,
	type GPUConfig,
	Image as ImageProto,
	type ImageRegistryConfig,
	RegistryAuthType,
} from "@/generated/modal_proto/api";
import { type App, parseGpuConfig } from "@/services/deploy/app";
import { mergeEnvIntoSecrets, Secret } from "@/services/secret/secret";

/**
 * @description {@link Image} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const image = await modal.images.fromRegistry("alpine");
 * ```
 */
export class ImageService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Image ID から {@link Image} を作成する
	 * @param imageId - Image ID
	 * @returns Image インスタンス
	 */
	async fromId(imageId: string): Promise<Image> {
		try {
			const resp = await this.#client.cpClient.imageFromId({ imageId });
			return new Image(this.#client, resp.imageId, "");
		} catch (err) {
			rethrowNotFound(err, undefined, "Could not find image with ID");
		}
	}

	/**
	 * @description レジストリタグから {@link Image} を作成する。認証用に {@link Secret} を指定可能
	 * @param tag - Image のレジストリタグ
	 * @param secret - レジストリ認証用の Secret
	 * @returns Image インスタンス
	 */
	fromRegistry(tag: string, secret?: Secret): Image {
		return this.#fromRegistryWith(
			tag,
			secret,
			RegistryAuthType.REGISTRY_AUTH_TYPE_STATIC_CREDS,
		);
	}

	/**
	 * @description AWS ECR のレジストリタグから {@link Image} を作成する
	 * @param tag - Image のレジストリタグ
	 * @param secret - AWS 認証用の Secret
	 * @returns Image インスタンス
	 */
	fromAwsEcr(tag: string, secret: Secret): Image {
		return this.#fromRegistryWith(
			tag,
			secret,
			RegistryAuthType.REGISTRY_AUTH_TYPE_AWS,
		);
	}

	/**
	 * @description GCP Artifact Registry のレジストリタグから {@link Image} を作成する
	 * @param tag - Image のレジストリタグ
	 * @param secret - GCP 認証用の Secret
	 * @returns Image インスタンス
	 */
	fromGcpArtifactRegistry(tag: string, secret: Secret): Image {
		return this.#fromRegistryWith(
			tag,
			secret,
			RegistryAuthType.REGISTRY_AUTH_TYPE_GCP,
		);
	}

	#fromRegistryWith(
		tag: string,
		secret: Secret | undefined,
		authType: RegistryAuthType,
	): Image {
		let imageRegistryConfig: ImageRegistryConfig | undefined;
		if (secret) {
			if (!(secret instanceof Secret)) {
				throw new TypeError(
					"secret must be a reference to an existing Secret, e.g. `await Secret.fromName('my_secret')`",
				);
			}
			imageRegistryConfig = {
				registryAuthType: authType,
				secretId: secret.secretId,
			};
		}
		return new Image(this.#client, "", tag, imageRegistryConfig);
	}

	/**
	 * @description ID で {@link Image} を削除する。削除は不可逆で、Function/Sandbox からの使用を妨げる。中間レイヤーは削除されない
	 * @param imageId - 削除する Image の ID
	 * @param _ - 将来の拡張用パラメータ
	 */
	async delete(imageId: string, _: ImageDeleteParams = {}): Promise<void> {
		try {
			await this.#client.cpClient.imageDelete({ imageId });
		} catch (err) {
			rethrowNotFound(err, undefined, "Could not find image with ID");
		}
	}
}

/**
 * @description {@link ImageService#delete client.images.delete()} のオプションパラメータ
 */
export type ImageDeleteParams = Record<never, never>;

/**
 * @description {@link Image#dockerfileCommands Image.dockerfileCommands()} のオプションパラメータ
 * @property env - ビルド環境に設定する環境変数
 * @property secrets - ビルド環境で環境変数として利用可能にする {@link Secret} の配列
 * @property gpu - ビルド環境の GPU 予約 (例: "A100", "T4:2", "A100-80GB:4")
 * @property forceBuild - キャッシュを無視してビルドするかどうか
 */
export type ImageDockerfileCommandsParams = {
	/**
	 * @description ビルド環境に設定する環境変数
	 */
	env?: Record<string, string>;

	/**
	 * @description ビルド環境で環境変数として利用可能にする {@link Secret} の配列
	 */
	secrets?: Secret[];

	/**
	 * @description ビルド環境の GPU 予約 (例: "A100", "T4:2", "A100-80GB:4")
	 */
	gpu?: string;

	/**
	 * @description キャッシュを無視してビルドする ('docker build --no-cache' に相当)
	 */
	forceBuild?: boolean;
};

/**
 * @description 単一の Image レイヤーとそのビルド設定を表す
 * @property commands - Dockerfile コマンドの配列
 * @property env - 環境変数
 * @property secrets - ビルド環境で利用する Secret の配列
 * @property gpuConfig - GPU 設定
 * @property forceBuild - キャッシュ無視フラグ
 */
type Layer = {
	commands: string[];
	env?: Record<string, string>;
	secrets?: Secret[];
	gpuConfig?: GPUConfig;
	forceBuild?: boolean;
};

/**
 * @description {@link Sandbox} の起動に使用するコンテナイメージ
 */
export class Image {
	#client: ModalClient;
	#imageId: string;
	#tag: string;
	#imageRegistryConfig?: ImageRegistryConfig;
	#layers: Layer[];

	/**
	 * @internal
	 */
	constructor(
		client: ModalClient,
		imageId: string,
		tag: string,
		imageRegistryConfig?: ImageRegistryConfig,
		layers?: Layer[],
	) {
		this.#client = client;
		this.#imageId = imageId;
		this.#tag = tag;
		if (imageRegistryConfig !== undefined)
			this.#imageRegistryConfig = imageRegistryConfig;
		this.#layers = layers || [
			{
				commands: [],
				forceBuild: false,
			},
		];
	}
	get imageId(): string {
		return this.#imageId;
	}

	private static validateDockerfileCommands(commands: string[]): void {
		for (const command of commands) {
			const trimmed = command.trim().toUpperCase();
			if (trimmed.startsWith("COPY ") && !trimmed.startsWith("COPY --FROM=")) {
				throw new InvalidError(
					"COPY commands that copy from local context are not yet supported.",
				);
			}
		}
	}

	/**
	 * @description 任意の Dockerfile コマンドで Image を拡張する。各呼び出しは順次ビルドされる新しいレイヤーを作成する
	 * @param commands - Dockerfile コマンドの文字列配列
	 * @param params - このレイヤーのビルド設定
	 * @returns 新しい Image インスタンス
	 */
	dockerfileCommands(
		commands: string[],
		params?: ImageDockerfileCommandsParams,
	): Image {
		if (commands.length === 0) {
			return this;
		}

		Image.validateDockerfileCommands(commands);

		const newLayer: Layer = {
			commands: [...commands],
			...(params?.env !== undefined && { env: params.env }),
			...(params?.secrets !== undefined && { secrets: params.secrets }),
			...(params?.gpu !== undefined && {
				gpuConfig: parseGpuConfig(params.gpu),
			}),
			...(params?.forceBuild !== undefined && {
				forceBuild: params.forceBuild,
			}),
		};

		return new Image(this.#client, "", this.#tag, this.#imageRegistryConfig, [
			...this.#layers,
			newLayer,
		]);
	}

	/**
	 * @description Modal 上で Image を即座にビルドする
	 * @param app - ビルドに使用する App
	 * @returns ビルドされた Image インスタンス
	 */
	async build(app: App): Promise<Image> {
		if (this.imageId !== "") {
			// Image ID で既にビルド済み
			return this;
		}

		this.#client.logger.debug("Building image", "app_id", app.appId);

		let baseImageId: string | undefined;

		for (let i = 0; i < this.#layers.length; i++) {
			const layer = this.#layers[i];
			if (!layer) throw new Error(`Expected layer at index ${i}`);

			const mergedSecrets = await mergeEnvIntoSecrets(
				this.#client,
				layer.env,
				layer.secrets,
			);

			const secretIds = mergedSecrets.map((secret) => secret.secretId);
			const gpuConfig = layer.gpuConfig;

			let dockerfileCommands: string[];
			let baseImages: Array<{ dockerTag: string; imageId: string }>;

			if (i === 0) {
				dockerfileCommands = [`FROM ${this.#tag}`, ...layer.commands];
				baseImages = [];
			} else {
				dockerfileCommands = ["FROM base", ...layer.commands];
				if (!baseImageId)
					throw new Error("Expected baseImageId from previous layer");
				baseImages = [{ dockerTag: "base", imageId: baseImageId }];
			}

			const resp = await this.#client.cpClient.imageGetOrCreate({
				appId: app.appId,
				image: ImageProto.create({
					dockerfileCommands,
					imageRegistryConfig: this.#imageRegistryConfig,
					secretIds,
					gpuConfig,
					contextFiles: [],
					baseImages,
				}),
				builderVersion: this.#client.imageBuilderVersion(),
				forceBuild: layer.forceBuild || false,
			});

			let result: GenericResult;

			if (resp.result?.status) {
				// ビルド済み
				result = resp.result;
			} else {
				// 未ビルドまたはビルド中 — 完了を待機
				let lastEntryId = "";
				let resultJoined: GenericResult | undefined;
				while (!resultJoined) {
					for await (const item of this.#client.cpClient.imageJoinStreaming({
						imageId: resp.imageId,
						timeout: 55,
						lastEntryId,
					})) {
						if (item.entryId) lastEntryId = item.entryId;
						if (item.result?.status) {
							resultJoined = item.result;
							break;
						}
						// ログ行と進捗更新は無視
					}
				}
				result = resultJoined;
			}

			if (
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_FAILURE
			) {
				throw new Error(
					`Image build for ${resp.imageId} failed with the exception:\n${result.exception}`,
				);
			} else if (
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_TERMINATED
			) {
				throw new Error(
					`Image build for ${resp.imageId} terminated due to external shut-down. Please try again.`,
				);
			} else if (
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_TIMEOUT
			) {
				throw new Error(
					`Image build for ${resp.imageId} timed out. Please try again with a larger timeout parameter.`,
				);
			} else if (
				result.status !== GenericResult_GenericStatus.GENERIC_STATUS_SUCCESS
			) {
				throw new Error(
					`Image build for ${resp.imageId} failed with unknown status: ${result.status}`,
				);
			}

			// 次のレイヤーのベースイメージとして使用
			baseImageId = resp.imageId;
		}
		if (!baseImageId)
			throw new Error("No image ID produced after building layers");
		this.#imageId = baseImageId;
		this.#client.logger.debug("Image build completed", "image_id", baseImageId);
		return this;
	}
}

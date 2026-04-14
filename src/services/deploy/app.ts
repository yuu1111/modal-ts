import type { ModalClient } from "@/core/client";
import { rethrowNotFound } from "@/core/grpc/errors";
import { GPUConfig, ObjectCreationType } from "@/generated/modal_proto/api";

/**
 * @description {@link App} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const app = await modal.apps.fromName("my-app");
 * ```
 */
export class AppService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 名前でデプロイ済み {@link App} を参照する。存在しなければ作成も可能
	 * @param name - App の名前
	 * @param params - オプションパラメータ
	 * @returns App インスタンス
	 * @throws NotFoundError 指定された App が存在しない場合
	 */
	async fromName(name: string, params: AppFromNameParams = {}): Promise<App> {
		try {
			const resp = await this.#client.cpClient.appGetOrCreate({
				appName: name,
				environmentName: this.#client.environmentName(params.environment),
				objectCreationType: params.createIfMissing
					? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
					: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED,
			});
			this.#client.logger.debug(
				"Retrieved App",
				"app_id",
				resp.appId,
				"app_name",
				name,
			);
			return new App(resp.appId, name);
		} catch (err) {
			rethrowNotFound(err, `App '${name}' not found`);
		}
	}
}

/**
 * @description {@link AppService#fromName client.apps.fromName()} のオプションパラメータ
 */
export type AppFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * @description GPU 設定文字列を GPUConfig オブジェクトにパースする
 * @param gpu - "type" または "type:count" 形式の GPU 文字列 (例: "T4", "A100:2")
 * @returns GPUConfig オブジェクト。GPU 未指定なら空の設定
 */
export function parseGpuConfig(gpu: string | undefined): GPUConfig {
	if (!gpu) {
		return GPUConfig.create({});
	}

	let gpuType = gpu;
	let count = 1;

	if (gpu.includes(":")) {
		const [type, countStr] = gpu.split(":", 2) as [string, string];
		gpuType = type;
		count = parseInt(countStr, 10);
		if (Number.isNaN(count) || count < 1) {
			throw new Error(
				`Invalid GPU count: ${countStr}. Value must be a positive integer.`,
			);
		}
	}

	return GPUConfig.create({
		count,
		gpuType: gpuType.toUpperCase(),
	});
}

/**
 * @description デプロイ済み Modal App を表す
 */
export class App {
	readonly appId: string;
	readonly name?: string;

	/**
	 * @internal
	 */
	constructor(appId: string, name?: string) {
		this.appId = appId;
		if (name !== undefined) this.name = name;
	}
}

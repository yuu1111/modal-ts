// Function calls and invocations, to be used with Modal Functions.

import { createHash } from "node:crypto";
import { ClientError, Status } from "nice-grpc";
import {
	getDefaultClient,
	type ModalClient,
	type ModalGrpcClient,
} from "@/core/client";
import { InternalFailure, InvalidError, NotFoundError } from "@/core/errors";
import {
	DataFormat,
	FunctionCallInvocationType,
	type FunctionHandleMetadata,
	type FunctionInput,
} from "@/generated/modal_proto/api";
import { cborEncode } from "@/utils/serialization";
import { checkForRenamedParams } from "@/utils/validation";
import { FunctionCall } from "./function_call";
import {
	ControlPlaneInvocation,
	InputPlaneInvocation,
	type Invocation,
} from "./invocation";

/**
 * @description Blobアップロードの閾値
 */
const maxObjectSizeBytes = 2 * 1024 * 1024; // 2 MiB

/**
 * @description InternalFailure時の最大リトライ回数
 */
const maxSystemRetries = 8;

/**
 * @description `client.functions.fromName()` のオプションパラメータ
 * @property environment - 環境名 @optional
 * @property createIfMissing - 存在しない場合に作成するか @optional
 */
export type FunctionFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * Service for managing {@link Function_ Function}s.
 *
 * Normally only ever accessed via the client as:
 * ```typescript
 * const modal = new ModalClient();
 * const function = await modal.functions.fromName("my-app", "my-function");
 * ```
 */
export class FunctionService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description App内のFunctionを名前で取得する
	 * @param appName - アプリ名
	 * @param name - Function名
	 * @param params - オプションパラメータ
	 * @returns Functionインスタンス
	 * @throws NotFoundError 指定されたFunctionが存在しない場合
	 */
	async fromName(
		appName: string,
		name: string,
		params: FunctionFromNameParams = {},
	): Promise<Function_> {
		if (name.includes(".")) {
			const [clsName, methodName] = name.split(".", 2);
			throw new Error(
				`Cannot retrieve Cls methods using 'functions.fromName()'. Use:\n  const cls = await client.cls.fromName("${appName}", "${clsName}");\n  const instance = await cls.instance();\n  const m = instance.method("${methodName}");`,
			);
		}
		try {
			const resp = await this.#client.cpClient.functionGet({
				appName,
				objectTag: name,
				environmentName: this.#client.environmentName(params.environment),
			});
			this.#client.logger.debug(
				"Retrieved Function",
				"function_id",
				resp.functionId,
				"app_name",
				appName,
				"function_name",
				name,
			);
			return new Function_(
				this.#client,
				resp.functionId,
				undefined,
				resp.handleMetadata,
			);
		} catch (err) {
			if (err instanceof ClientError && err.code === Status.NOT_FOUND)
				throw new NotFoundError(`Function '${appName}/${name}' not found`);
			throw err;
		}
	}
}

/**
 * @description 実行中のFunctionの統計情報
 * @property backlog - 未処理の入力数
 * @property numTotalRunners - 総ランナー数
 */
export interface FunctionStats {
	backlog: number;
	numTotalRunners: number;
}

/**
 * @description オートスケーラーの更新パラメータ
 * @property minContainers - 最小コンテナ数 @optional
 * @property maxContainers - 最大コンテナ数 @optional
 * @property bufferContainers - バッファコンテナ数 @optional
 * @property scaledownWindowMs - スケールダウン猶予期間(ミリ秒) @optional
 */
export interface FunctionUpdateAutoscalerParams {
	minContainers?: number;
	maxContainers?: number;
	bufferContainers?: number;
	scaledownWindowMs?: number;
}

/**
 * @description デプロイ済みModal Functionを表し、リモート実行が可能
 */
export class Function_ {
	readonly functionId: string;
	readonly methodName?: string;
	#client: ModalClient;
	#handleMetadata?: FunctionHandleMetadata;

	/** @internal */
	constructor(
		client: ModalClient,
		functionId: string,
		methodName?: string,
		functionHandleMetadata?: FunctionHandleMetadata,
	) {
		this.functionId = functionId;
		if (methodName !== undefined) this.methodName = methodName;

		this.#client = client;
		if (functionHandleMetadata !== undefined)
			this.#handleMetadata = functionHandleMetadata;
	}

	/**
	 * @deprecated Use `client.functions.fromName()` instead.
	 */
	static async lookup(
		appName: string,
		name: string,
		params: FunctionFromNameParams = {},
	): Promise<Function_> {
		return await getDefaultClient().functions.fromName(appName, name, params);
	}

	#checkNoWebUrl(fnName: string): void {
		if (this.#handleMetadata?.webUrl) {
			throw new InvalidError(
				`A webhook Function cannot be invoked for remote execution with '.${fnName}'. Invoke this Function via its web url '${this.#handleMetadata.webUrl}' instead.`,
			);
		}
	}

	/**
	 * @description Functionを同期的にリモート実行し、結果を返す
	 * @param args - 位置引数の配列
	 * @param kwargs - キーワード引数のマッピング
	 * @returns Function実行結果
	 */
	async remote(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): Promise<unknown> {
		this.#client.logger.debug(
			"Executing function call",
			"function_id",
			this.functionId,
		);
		this.#checkNoWebUrl("remote");
		const input = await this.#createInput(args, kwargs);
		const invocation = await this.#createRemoteInvocation(input);
		// TODO(ryan): Add tests for retries.
		let retryCount = 0;
		while (true) {
			try {
				const result = await invocation.awaitOutput();
				this.#client.logger.debug(
					"Function call completed",
					"function_id",
					this.functionId,
				);
				return result;
			} catch (err) {
				if (err instanceof InternalFailure && retryCount <= maxSystemRetries) {
					this.#client.logger.debug(
						"Retrying function call due to internal failure",
						"function_id",
						this.functionId,
						"retry_count",
						retryCount,
					);
					await invocation.retry(retryCount);
					retryCount++;
				} else {
					throw err;
				}
			}
		}
	}

	async #createRemoteInvocation(input: FunctionInput): Promise<Invocation> {
		if (this.#handleMetadata?.inputPlaneUrl) {
			return await InputPlaneInvocation.create(
				this.#client,
				this.#handleMetadata.inputPlaneUrl,
				this.functionId,
				input,
			);
		}

		return await ControlPlaneInvocation.create(
			this.#client,
			this.functionId,
			input,
			FunctionCallInvocationType.FUNCTION_CALL_INVOCATION_TYPE_SYNC,
		);
	}

	/**
	 * @description Functionを非同期的にスポーンし、FunctionCallを返す
	 * @param args - 位置引数の配列
	 * @param kwargs - キーワード引数のマッピング
	 * @returns 非同期実行を追跡するFunctionCall
	 */
	async spawn(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): Promise<FunctionCall> {
		this.#client.logger.debug(
			"Spawning function call",
			"function_id",
			this.functionId,
		);
		this.#checkNoWebUrl("spawn");
		const input = await this.#createInput(args, kwargs);
		const invocation = await ControlPlaneInvocation.create(
			this.#client,
			this.functionId,
			input,
			FunctionCallInvocationType.FUNCTION_CALL_INVOCATION_TYPE_ASYNC,
		);
		this.#client.logger.debug(
			"Function call spawned",
			"function_id",
			this.functionId,
			"function_call_id",
			invocation.functionCallId,
		);
		return new FunctionCall(this.#client, invocation.functionCallId);
	}

	/**
	 * @description Functionの現在の統計情報を取得する
	 * @returns バックログとランナー数を含む統計情報
	 */
	async getCurrentStats(): Promise<FunctionStats> {
		const resp = await this.#client.cpClient.functionGetCurrentStats(
			{ functionId: this.functionId },
			{ timeoutMs: 10000 },
		);
		return {
			backlog: resp.backlog,
			numTotalRunners: resp.numTotalTasks,
		};
	}

	/**
	 * @description Functionのオートスケーラー設定を更新する
	 * @param params - オートスケーラー設定
	 */
	async updateAutoscaler(
		params: FunctionUpdateAutoscalerParams,
	): Promise<void> {
		checkForRenamedParams(params, { scaledownWindow: "scaledownWindowMs" });

		await this.#client.cpClient.functionUpdateSchedulingParams({
			functionId: this.functionId,
			warmPoolSizeOverride: 0, // Deprecated field, always set to 0
			settings: {
				minContainers: params.minContainers,
				maxContainers: params.maxContainers,
				bufferContainers: params.bufferContainers,
				scaledownWindow:
					params.scaledownWindowMs !== undefined
						? Math.trunc(params.scaledownWindowMs / 1000)
						: undefined,
			},
		});
	}

	/**
	 * URL of a Function running as a web endpoint.
	 * @returns The web URL if this Function is a web endpoint, otherwise undefined
	 */
	async getWebUrl(): Promise<string | undefined> {
		return this.#handleMetadata?.webUrl || undefined;
	}

	async #createInput(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): Promise<FunctionInput> {
		const supported_input_formats = this.#handleMetadata?.supportedInputFormats
			?.length
			? this.#handleMetadata.supportedInputFormats
			: [DataFormat.DATA_FORMAT_PICKLE];
		if (!supported_input_formats.includes(DataFormat.DATA_FORMAT_CBOR)) {
			// the remote function isn't cbor compatible for inputs
			// so we can error early
			throw new InvalidError(
				"cannot call Modal Function from JS SDK since it was deployed with an incompatible Python SDK version. Redeploy with Modal Python SDK >= 1.2",
			);
		}
		const payload = cborEncode([args, kwargs]);

		let argsBlobId: string | undefined;
		if (payload.length > maxObjectSizeBytes) {
			argsBlobId = await blobUpload(this.#client.cpClient, payload);
		}

		// Single input sync invocation
		return {
			args: argsBlobId ? undefined : payload,
			argsBlobId,
			dataFormat: DataFormat.DATA_FORMAT_CBOR,
			methodName: this.methodName,
			finalInput: false, // This field isn't specified in the Python client, so it defaults to false.
		};
	}
}

/**
 * @description 大きなペイロードをBlobストレージにアップロードする
 * @param cpClient - gRPCクライアント
 * @param data - アップロードするバイナリデータ
 * @returns Blob ID
 */
async function blobUpload(
	cpClient: ModalGrpcClient,
	data: Uint8Array,
): Promise<string> {
	const contentMd5 = createHash("md5").update(data).digest("base64");
	const contentSha256 = createHash("sha256").update(data).digest("base64");
	const resp = await cpClient.blobCreate({
		contentMd5,
		contentSha256Base64: contentSha256,
		contentLength: data.length,
	});
	if (resp.multipart) {
		throw new Error(
			"Function input size exceeds multipart upload threshold, unsupported by this SDK version",
		);
	} else if (resp.uploadUrl) {
		const uploadResp = await fetch(resp.uploadUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-MD5": contentMd5,
			},
			body: data,
		});
		if (uploadResp.status < 200 || uploadResp.status >= 300) {
			throw new Error(`Failed blob upload: ${uploadResp.statusText}`);
		}
		// Skip client-side ETag header validation for now (MD5 checksum).
		return resp.blobId;
	} else {
		throw new Error("Missing upload URL in BlobCreate response");
	}
}

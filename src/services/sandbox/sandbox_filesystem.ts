import type { ModalClient, ModalGrpcClient } from "@/core/client";
import { SandboxFilesystemError } from "@/core/errors";
import { isRetryableGrpc } from "@/core/grpc_utils";
import type {
	ContainerFilesystemExecRequest,
	ContainerFilesystemExecResponse,
	DeepPartial,
} from "@/generated/modal_proto/api";

/**
 * @description ファイルシステムAPIがサポートするファイルオープンモード
 */
export type SandboxFileMode = "r" | "w" | "a" | "r+" | "w+" | "a+";

/**
 * @description {@link Sandbox} ファイルシステム内の開かれたファイルを表す
 *
 * Node.js の `fsPromises.FileHandle` に類似した読み書き操作を提供する。
 */
export class SandboxFile {
	readonly #client: ModalClient;
	readonly #fileDescriptor: string;
	readonly #taskId: string;

	/** @internal */
	constructor(client: ModalClient, fileDescriptor: string, taskId: string) {
		this.#client = client;
		this.#fileDescriptor = fileDescriptor;
		this.#taskId = taskId;
	}

	/**
	 * @description ファイルからデータを読み取る
	 * @returns 読み取ったデータのバイト配列
	 */
	async read(): Promise<Uint8Array> {
		const resp = await runFilesystemExec(this.#client.cpClient, {
			fileReadRequest: {
				fileDescriptor: this.#fileDescriptor,
			},
			taskId: this.#taskId,
		});
		const chunks = resp.chunks;
		if (chunks.length === 0) return new Uint8Array(0);

		const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}

	/**
	 * @description ファイルにデータを書き込む
	 * @param data - 書き込むバイト配列
	 */
	async write(data: Uint8Array): Promise<void> {
		await runFilesystemExec(this.#client.cpClient, {
			fileWriteRequest: {
				fileDescriptor: this.#fileDescriptor,
				data,
			},
			taskId: this.#taskId,
		});
	}

	/**
	 * @description バッファされたデータをファイルにフラッシュする
	 */
	async flush(): Promise<void> {
		await runFilesystemExec(this.#client.cpClient, {
			fileFlushRequest: {
				fileDescriptor: this.#fileDescriptor,
			},
			taskId: this.#taskId,
		});
	}

	/**
	 * @description ファイルハンドルを閉じる
	 */
	async close(): Promise<void> {
		await runFilesystemExec(this.#client.cpClient, {
			fileCloseRequest: {
				fileDescriptor: this.#fileDescriptor,
			},
			taskId: this.#taskId,
		});
	}
}

/**
 * @description Sandbox ファイルシステム操作を実行しレスポンスを収集する
 * @param cpClient - gRPC クライアント
 * @param request - 実行リクエスト
 * @returns 出力チャンクとレスポンス
 */
export async function runFilesystemExec(
	cpClient: ModalGrpcClient,
	request: DeepPartial<ContainerFilesystemExecRequest>,
): Promise<{
	chunks: Uint8Array[];
	response: ContainerFilesystemExecResponse;
}> {
	const response = await cpClient.containerFilesystemExec(request);

	const chunks: Uint8Array[] = [];
	let retries = 10;
	let completed = false;
	while (!completed) {
		try {
			const outputIterator = cpClient.containerFilesystemExecGetOutput({
				execId: response.execId,
				timeout: 55,
			});
			for await (const batch of outputIterator) {
				chunks.push(...batch.output);
				if (batch.eof) {
					completed = true;
					break;
				}
				if (batch.error !== undefined) {
					if (retries > 0) {
						retries--;
						break;
					}
					throw new SandboxFilesystemError(batch.error.errorMessage);
				}
			}
			// gRPC ストリームが eof 送信前に切断されることがある(一時的なネットワーク断)
			if (!completed) {
				if (retries > 0) {
					retries--;
				} else {
					throw new SandboxFilesystemError(
						"Timed out waiting for filesystem exec completion",
					);
				}
			}
		} catch (err) {
			if (isRetryableGrpc(err) && retries > 0) {
				retries--;
			} else throw err;
		}
	}
	return { chunks, response };
}

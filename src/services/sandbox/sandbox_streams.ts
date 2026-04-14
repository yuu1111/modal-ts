import { setTimeout } from "node:timers/promises";
import type { ModalGrpcClient } from "@/core/client";
import type { TaskCommandRouterClientImpl } from "@/core/grpc/task_command_router_client";
import { isRetryableGrpc } from "@/core/grpc/utils";
import type { FileDescriptor } from "@/generated/modal_proto/api";
import { encodeIfString } from "@/utils/streams";

// SandboxGetLogs リトライ時のバックオフ設定
const SB_LOGS_INITIAL_DELAY_MS = 10;
const SB_LOGS_DELAY_FACTOR = 2;
const SB_LOGS_MAX_RETRIES = 10;

// Python SDK の _StreamReader (object_type == "sandbox") に相当
/**
 * @description Sandbox の stdout/stderr をストリーミング読み取りする
 * @param cpClient - gRPCクライアント
 * @param sandboxId - Sandbox ID
 * @param fileDescriptor - 読み取り対象のファイルディスクリプタ
 * @param signal - キャンセル用シグナル @optional
 */
export async function* outputStreamSb(
	cpClient: ModalGrpcClient,
	sandboxId: string,
	fileDescriptor: FileDescriptor,
	signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
	let lastIndex = "0-0";
	let completed = false;
	let retriesRemaining = SB_LOGS_MAX_RETRIES;
	let delayMs = SB_LOGS_INITIAL_DELAY_MS;
	while (!completed) {
		try {
			const outputIterator = cpClient.sandboxGetLogs(
				{
					sandboxId,
					fileDescriptor,
					timeout: 55,
					lastEntryId: lastIndex,
				},
				{
					...(signal !== undefined && { signal }),
				},
			);
			for await (const batch of outputIterator) {
				// 読み取り成功 — バックオフカウンタをリセット
				delayMs = SB_LOGS_INITIAL_DELAY_MS;
				retriesRemaining = SB_LOGS_MAX_RETRIES;
				lastIndex = batch.entryId;
				yield* batch.items.map((item) => encodeIfString(item.data));
				if (batch.eof) {
					completed = true;
					break;
				}
				if (signal?.aborted) {
					return;
				}
			}
		} catch (err) {
			// キャンセル済みならエラー種別を問わず正常終了
			if (signal?.aborted) {
				return;
			}
			if (isRetryableGrpc(err) && retriesRemaining > 0) {
				// 連続リトライを避けるため短い指数バックオフ
				try {
					await setTimeout(delayMs, undefined, { signal });
				} catch {
					// スリープ中のキャンセル — 正常終了
					return;
				}
				delayMs *= SB_LOGS_DELAY_FACTOR;
				retriesRemaining--;
			} else {
				throw err;
			}
		}
	}
}

/**
 * @description Sandbox の stdin に書き込むための WritableStream を返す
 * @param cpClient - gRPCクライアント
 * @param sandboxId - Sandbox ID
 */
export function inputStreamSb(
	cpClient: ModalGrpcClient,
	sandboxId: string,
): WritableStream<string> {
	let index = 1;
	return new WritableStream<string>({
		async write(chunk) {
			await cpClient.sandboxStdinWrite({
				sandboxId,
				input: encodeIfString(chunk),
				index,
			});
			index++;
		},
		async close() {
			await cpClient.sandboxStdinWrite({
				sandboxId,
				index,
				eof: true,
			});
		},
	});
}

/**
 * @description ContainerProcess の stdout/stderr をストリーミング読み取りする
 * @param commandRouterClient - TaskCommandRouterクライアント
 * @param taskId - タスクID
 * @param execId - 実行ID
 * @param fileDescriptor - 読み取り対象のファイルディスクリプタ
 * @param deadline - デッドライン(エポックミリ秒) @optional
 */
export async function* outputStreamCp(
	commandRouterClient: TaskCommandRouterClientImpl,
	taskId: string,
	execId: string,
	fileDescriptor: FileDescriptor,
	deadline: number | null,
): AsyncIterable<Uint8Array> {
	for await (const batch of commandRouterClient.execStdioRead(
		taskId,
		execId,
		fileDescriptor,
		deadline,
	)) {
		yield batch.data;
	}
}

/**
 * @description ContainerProcess の stdin に書き込むための WritableStream を返す
 * @param commandRouterClient - TaskCommandRouterクライアント
 * @param taskId - タスクID
 * @param execId - 実行ID
 */
export function inputStreamCp<R extends string | Uint8Array>(
	commandRouterClient: TaskCommandRouterClientImpl,
	taskId: string,
	execId: string,
): WritableStream<R> {
	let offset = 0;
	return new WritableStream<R>({
		async write(chunk) {
			const data = encodeIfString(chunk);
			await commandRouterClient.execStdinWrite(
				taskId,
				execId,
				offset,
				data,
				false, // eof
			);
			offset += data.length;
		},
		async close() {
			await commandRouterClient.execStdinWrite(
				taskId,
				execId,
				offset,
				new Uint8Array(0),
				true, // eof
			);
		},
	});
}

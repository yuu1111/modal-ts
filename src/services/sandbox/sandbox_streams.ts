import type { ModalGrpcClient } from "@/core/client";
import type { TaskCommandRouterClientImpl } from "@/core/grpc/task_command_router_client";
import { isRetryableGrpc, sleep } from "@/core/grpc/utils";
import type { FileDescriptor } from "@/generated/modal_proto/api";
import { encodeIfString } from "@/utils/streams";

// Backoff settings when retrying SandboxGetLogs.
const SB_LOGS_INITIAL_DELAY_MS = 10;
const SB_LOGS_DELAY_FACTOR = 2;
const SB_LOGS_MAX_RETRIES = 10;

// Equivalent to the Python SDK _StreamReader (object_type == "sandbox").
/**
 * @description Streams reads from Sandbox stdout/stderr
 * @param cpClient - gRPC client
 * @param sandboxId - Sandbox ID
 * @param fileDescriptor - File descriptor to read
 * @param signal - Cancellation signal @optional
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
				// Read succeeded. Reset the backoff counter.
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
			// If cancelled, exit cleanly regardless of the error type.
			if (signal?.aborted) {
				return;
			}
			if (isRetryableGrpc(err) && retriesRemaining > 0) {
				// Short exponential backoff to avoid tight retries.
				try {
					await sleep(delayMs, signal);
				} catch {
					// Cancelled while sleeping. Exit cleanly.
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
 * @description Returns a WritableStream for writing to Sandbox stdin
 * @param cpClient - gRPC client
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
 * @description Streams reads from ContainerProcess stdout/stderr
 * @param commandRouterClient - TaskCommandRouter client
 * @param taskId - Task ID
 * @param execId - Exec ID
 * @param fileDescriptor - File descriptor to read
 * @param deadline - Deadline in epoch milliseconds @optional
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
 * @description Returns a WritableStream for writing to ContainerProcess stdin
 * @param commandRouterClient - TaskCommandRouter client
 * @param taskId - Task ID
 * @param execId - Exec ID
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

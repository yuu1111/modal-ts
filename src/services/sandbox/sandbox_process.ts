import { InvalidError } from "@/core/errors";
import type { TaskCommandRouterClientImpl } from "@/core/grpc/task_command_router_client";
import { FileDescriptor } from "@/generated/modal_proto/api";
import {
	type ModalReadStream,
	type ModalWriteStream,
	streamConsumingIter,
	toModalReadStream,
	toModalWriteStream,
} from "@/utils/streams";
import type { SandboxExecParams } from "./sandbox_config";
import { inputStreamCp, outputStreamCp } from "./sandbox_streams";

/**
 * Represents a process running inside a Sandbox and provides stdin/stdout/stderr streams
 */
export class ContainerProcess<
	R extends string | Uint8Array = string | Uint8Array,
> {
	stdin: ModalWriteStream<R>;
	stdout: ModalReadStream<R>;
	stderr: ModalReadStream<R>;

	readonly #taskId: string;
	readonly #execId: string;
	readonly #commandRouterClient: TaskCommandRouterClientImpl;
	readonly #deadline: number | null;
	#returncode: number | undefined;

	/** @internal */
	constructor(
		taskId: string,
		execId: string,
		commandRouterClient: TaskCommandRouterClientImpl,
		params?: SandboxExecParams,
		deadline?: number | null,
	) {
		this.#taskId = taskId;
		this.#execId = execId;
		this.#commandRouterClient = commandRouterClient;
		this.#deadline = deadline ?? null;

		const mode = params?.mode ?? "text";
		const stdout = params?.stdout ?? "pipe";
		const stderr = params?.stderr ?? "pipe";

		this.stdin = toModalWriteStream(
			inputStreamCp<R>(commandRouterClient, taskId, execId),
		);

		const stdoutStream =
			stdout === "ignore"
				? ReadableStream.from([])
				: streamConsumingIter(
						outputStreamCp(
							commandRouterClient,
							taskId,
							execId,
							FileDescriptor.FILE_DESCRIPTOR_STDOUT,
							this.#deadline,
						),
					);

		const stderrStream =
			stderr === "ignore"
				? ReadableStream.from([])
				: streamConsumingIter(
						outputStreamCp(
							commandRouterClient,
							taskId,
							execId,
							FileDescriptor.FILE_DESCRIPTOR_STDERR,
							this.#deadline,
						),
					);

		if (mode === "text") {
			this.stdout = toModalReadStream(
				stdoutStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			) as ModalReadStream<R>;
			this.stderr = toModalReadStream(
				stderrStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			) as ModalReadStream<R>;
		} else {
			this.stdout = toModalReadStream(stdoutStream) as ModalReadStream<R>;
			this.stderr = toModalReadStream(stderrStream) as ModalReadStream<R>;
		}
	}

	/**
	 * Closes the stdin stream
	 */
	async closeStdin(): Promise<void> {
		const writer = this.stdin.getWriter();
		try {
			await writer.close();
		} finally {
			writer.releaseLock();
		}
	}

	/**
	 * Waits for the process to exit and returns its exit code
	 * @returns exit code
	 */
	async wait(): Promise<number> {
		if (this.#returncode !== undefined) return this.#returncode;
		const resp = await this.#commandRouterClient.execWait(
			this.#taskId,
			this.#execId,
			this.#deadline,
		);
		if (resp.code !== undefined) {
			this.#returncode = resp.code;
			return this.#returncode;
		} else if (resp.signal !== undefined) {
			this.#returncode = 128 + resp.signal;
			return this.#returncode;
		} else {
			throw new InvalidError("Unexpected exit status");
		}
	}

	async poll(): Promise<number | null> {
		if (this.#returncode !== undefined) return this.#returncode;
		const resp = await this.#commandRouterClient.execPoll(
			this.#taskId,
			this.#execId,
			this.#deadline,
		);
		if (resp.code !== undefined) {
			this.#returncode = resp.code;
			return this.#returncode;
		}
		if (resp.signal !== undefined) {
			this.#returncode = 128 + resp.signal;
			return this.#returncode;
		}
		return null;
	}

	get returncode(): number {
		if (this.#returncode === undefined) {
			throw new InvalidError(
				"You must call wait() before accessing the returncode. To poll for the status of a running process, use poll() instead.",
			);
		}
		return this.#returncode;
	}
}

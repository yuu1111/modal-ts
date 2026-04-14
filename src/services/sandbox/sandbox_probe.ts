import { InvalidError } from "@/core/errors";

/**
 * @description Probe作成時のパラメータ
 * @property intervalMs - ヘルスチェック間隔(ミリ秒) @defaultValue 100
 */
export type ProbeParams = {
	intervalMs: number;
};

/**
 * @description Sandbox のreadiness判定に使うプローブ
 */
export class Probe {
	readonly #tcpPort?: number;
	readonly #execArgv?: string[];
	readonly #intervalMs: number;

	private constructor(params: {
		tcpPort?: number;
		execArgv?: string[];
		intervalMs: number;
	}) {
		const { tcpPort, execArgv, intervalMs } = params;
		if ((tcpPort === undefined) === (execArgv === undefined)) {
			throw new InvalidError(
				"Probe must be created with Probe.withTcp(...) or Probe.withExec(...)",
			);
		}
		if (tcpPort !== undefined) this.#tcpPort = tcpPort;
		if (execArgv !== undefined) this.#execArgv = execArgv;
		this.#intervalMs = intervalMs;
	}

	/**
	 * @description TCPポートへの接続でreadiness判定するProbeを作成
	 * @param port - チェック対象のポート番号 (1-65535)
	 * @param params - プローブパラメータ
	 */
	static withTcp(
		port: number,
		params: ProbeParams = { intervalMs: 100 },
	): Probe {
		if (!Number.isInteger(port)) {
			throw new InvalidError("Probe.withTcp() expects an integer `port`");
		}
		if (port <= 0 || port > 65535) {
			throw new InvalidError(
				`Probe.withTcp() expects \`port\` in [1, 65535], got ${port}`,
			);
		}
		Probe.#validateIntervalMs("Probe.withTcp", params.intervalMs);
		return new Probe({ tcpPort: port, intervalMs: params.intervalMs });
	}

	/**
	 * @description コマンド実行でreadiness判定するProbeを作成
	 * @param argv - 実行するコマンドと引数
	 * @param params - プローブパラメータ
	 */
	static withExec(
		argv: string[],
		params: ProbeParams = { intervalMs: 100 },
	): Probe {
		if (!Array.isArray(argv) || argv.length === 0) {
			throw new InvalidError("Probe.withExec() requires at least one argument");
		}
		if (!argv.every((arg) => typeof arg === "string")) {
			throw new InvalidError(
				"Probe.withExec() expects all arguments to be strings",
			);
		}
		Probe.#validateIntervalMs("Probe.withExec", params.intervalMs);
		return new Probe({ execArgv: [...argv], intervalMs: params.intervalMs });
	}

	/** @internal */
	toProto() {
		if (this.#tcpPort !== undefined) {
			return {
				tcpPort: this.#tcpPort,
				intervalMs: this.#intervalMs,
			};
		}
		if (this.#execArgv !== undefined) {
			return {
				execCommand: { argv: this.#execArgv },
				intervalMs: this.#intervalMs,
			};
		}
		throw new InvalidError(
			"Probe must be created with Probe.withTcp(...) or Probe.withExec(...)",
		);
	}

	static #validateIntervalMs(methodName: string, intervalMs: number) {
		if (!Number.isInteger(intervalMs)) {
			throw new InvalidError(
				`${methodName}() expects an integer \`intervalMs\``,
			);
		}
		if (intervalMs <= 0) {
			throw new InvalidError(
				`${methodName}() expects \`intervalMs\` > 0, got ${intervalMs}`,
			);
		}
	}
}

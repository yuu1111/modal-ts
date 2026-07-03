import { InvalidError } from "@/core/errors";
import { aliasedNumber } from "@/utils/param_aliases";

/**
 * @description Parameters for creating a Probe
 * @property intervalMs - Health check interval in milliseconds @defaultValue 100
 */
export type ProbeParams = {
	intervalMs?: number;
	interval_ms?: number;
};

/**
 * @description Probe used to determine Sandbox readiness
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
	 * @description Creates a Probe that determines readiness by connecting to a TCP port
	 * @param port - Port number to check (1-65535)
	 * @param params - Probe parameters
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
		const intervalMs =
			aliasedNumber(params, "intervalMs", "interval_ms") ?? 100;
		Probe.#validateIntervalMs("Probe.withTcp", intervalMs);
		return new Probe({ tcpPort: port, intervalMs });
	}

	/**
	 * @description Creates a Probe that determines readiness by running a command
	 * @param argv - Command and arguments to run
	 * @param params - Probe parameters
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
		const intervalMs =
			aliasedNumber(params, "intervalMs", "interval_ms") ?? 100;
		Probe.#validateIntervalMs("Probe.withExec", intervalMs);
		return new Probe({ execArgv: [...argv], intervalMs });
	}

	/** @internal */
	toProto() {
		if (this.#tcpPort !== undefined) {
			return {
				tcpPort: this.#tcpPort,
				intervalMs: this.#intervalMs,
			};
		}
		// The constructor always sets either tcpPort or execArgv.
		const argv = this.#execArgv as string[];
		return {
			execCommand: { argv },
			intervalMs: this.#intervalMs,
		};
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

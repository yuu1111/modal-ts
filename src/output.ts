/**
 * Minimal OutputManager for SDK output display
 */
export class OutputManager {
	static #current: OutputManager | undefined;

	/**
	 * Gets the current OutputManager
	 */
	static get(): OutputManager {
		if (!OutputManager.#current) {
			OutputManager.#current = new OutputManager(false);
		}
		return OutputManager.#current;
	}

	/**
	 * @internal
	 */
	static set(manager: OutputManager | undefined): void {
		OutputManager.#current = manager;
	}

	constructor(readonly enabled = true) {}

	/**
	 * Prints a message to stdout
	 */
	print(message: unknown): void {
		if (this.enabled) console.log(message);
	}

	/**
	 * Prints JSON to stdout
	 */
	printJson(value: unknown): void {
		if (this.enabled) console.log(JSON.stringify(value, undefined, 2));
	}

	/**
	 * Returns a scope for status display
	 */
	status(message: string): { stop: () => void } {
		this.print(message);
		return { stop: () => {} };
	}
}

/**
 * Enables the OutputManager and runs the callback
 */
export async function enableOutput<T>(
	callback?: () => T | Promise<T>,
): Promise<T | undefined> {
	const previous = OutputManager.get();
	OutputManager.set(new OutputManager(true));
	try {
		if (callback) return await callback();
		return undefined;
	} finally {
		OutputManager.set(previous);
	}
}

export const enable_output = enableOutput;

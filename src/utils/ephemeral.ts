import { InvalidError } from "@/core/errors";

/**
 * Heartbeat interval in milliseconds
 */
export const ephemeralObjectHeartbeatSleep = 300000;

/**
 * Type for heartbeat sender functions
 */
export type HeartbeatFunction = () => Promise<unknown>;

/**
 * Manager that periodically sends heartbeats for ephemeral objects
 * @property heartbeatFn - Heartbeat sender function
 * @property abortController - Stop controller for the heartbeat loop
 */
export class EphemeralHeartbeatManager {
	private readonly heartbeatFn: HeartbeatFunction;
	private readonly abortController: AbortController;

	/**
	 * Starts the heartbeat loop when the instance is created
	 * @param heartbeatFn - Heartbeat sender function
	 */
	constructor(heartbeatFn: HeartbeatFunction) {
		this.heartbeatFn = heartbeatFn;
		this.abortController = new AbortController();

		this.start();
	}

	/**
	 * Starts the heartbeat loop asynchronously
	 */
	private start(): void {
		const signal = this.abortController.signal;
		(async () => {
			while (!signal.aborted) {
				try {
					await this.heartbeatFn();
				} catch {
					// Do not stop the loop on transient errors.
				}
				await new Promise<void>((resolve) => {
					// unref: prevent the heartbeat timer from keeping the process alive.
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, ephemeralObjectHeartbeatSleep);
					timer.unref();

					function onAbort(): void {
						clearTimeout(timer);
						resolve();
					}
					signal.addEventListener("abort", onAbort, { once: true });
				});
			}
		})();
	}

	/**
	 * Stops the heartbeat loop
	 */
	stop(): void {
		this.abortController.abort();
	}
}

/**
 * Stops an ephemeral heartbeat manager or throws when the object is not ephemeral.
 *
 * @param heartbeatManager - Optional heartbeat manager
 * @param resourceName - Resource name for error messages
 */
export function closeEphemeralHeartbeat(
	heartbeatManager: EphemeralHeartbeatManager | undefined,
	resourceName: string,
): void {
	if (heartbeatManager) {
		heartbeatManager.stop();
	} else {
		throw new InvalidError(`${resourceName} is not ephemeral.`);
	}
}

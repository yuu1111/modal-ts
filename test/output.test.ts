import { enableOutput, OutputManager } from "modal";
import { expect, test } from "vitest";

test("enableOutput scopes OutputManager", async () => {
	const previous = OutputManager.get();

	await enableOutput(() => {
		expect(OutputManager.get().enabled).toBe(true);
	});

	expect(OutputManager.get()).toBe(previous);
});

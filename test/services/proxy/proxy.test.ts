import { expect, onTestFinished, test } from "vitest";
import { tc } from "../../support/test-client";

const skipProxyTests =
	process.env.MODAL_TS_SKIP_PROXY_TESTS === "1" ||
	process.env.MODAL_TS_SKIP_PROXY_TESTS?.toLowerCase() === "true";
const proxyTest = skipProxyTests ? test.skip : test;

proxyTest("CreateSandboxWithProxy", async () => {
	const app = await tc.apps.fromName("libmodal-test", {
		createIfMissing: true,
	});
	const image = tc.images.fromRegistry("alpine:3.21");

	const proxy = await tc.proxies.fromName("modal-ts-test-proxy", {
		environment: "libmodal",
	});
	expect(proxy.proxyId).toBeTruthy();
	expect(proxy.proxyId).toMatch(/^pr-/);

	const sb = await tc.sandboxes.create(app, image, {
		proxy,
		command: ["echo", "hello, Sandbox with proxy"],
	});
	onTestFinished(async () => await sb.terminate());
	expect(sb.sandboxId).toBeTruthy();
});

test("ProxyNotFound", async () => {
	await expect(tc.proxies.fromName("non-existent-proxy-name")).rejects.toThrow(
		"Proxy 'non-existent-proxy-name' not found",
	);
});

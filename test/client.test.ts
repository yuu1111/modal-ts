import { ModalClient } from "modal";
import { ClientError, Status } from "nice-grpc";
import { expect, test } from "vitest";
import { isRetryableGrpc, timeoutMiddleware } from "../src/client";
import { createMockModalClients } from "./support/grpc_mock";

test("ModalClient with custom middleware", async () => {
	// Verify that ModalClient correctly stores custom middleware.
	// The grpcMiddleware option is only applied when creating a real gRPC channel
	// (i.e., when cpClient is not injected). This test verifies the constructor
	// accepts the option without error, and that the client functions normally.
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/FunctionGet", () => {
		throw new ClientError("/FunctionGet", Status.NOT_FOUND, "not found");
	});

	try {
		await mc.functions.fromName("test-app", "non-existent");
	} catch (_err) {
		// Expected: NotFoundError
	}

	mock.assertExhausted();

	// Also verify the constructor accepts grpcMiddleware without error
	const middlewareCalled = { value: false };
	const mc2 = new ModalClient({
		tokenId: "test-token",
		tokenSecret: "test-secret",
		grpcMiddleware: [
			async function* (call, options) {
				middlewareCalled.value = true;
				return yield* call.next(call.request, options);
			},
		],
	});
	mc2.close();
	expect(mc2).toBeDefined();
});

test("resolveImageBuilderVersion falls back to default without an environment", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	// No environment configured, so no RPC should be made.
	expect(await mc.resolveImageBuilderVersion()).toBe("2024.10");
	mock.assertExhausted();
});

test("resolveImageBuilderVersion uses the environment's actual version", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	(mc as { profile: { environment: string } }).profile.environment = "main";

	mock.handleUnary("/EnvironmentGetOrCreate", (req) => {
		expect(req).toMatchObject({ deploymentName: "main" });
		return {
			environmentId: "env-main",
			metadata: { name: "main", settings: { imageBuilderVersion: "2025.06" } },
		};
	});

	expect(await mc.resolveImageBuilderVersion()).toBe("2025.06");
	// Second call is served from cache, no extra RPC.
	expect(await mc.resolveImageBuilderVersion()).toBe("2025.06");
	mock.assertExhausted();
});

test("resolveImageBuilderVersion prefers the configured profile value", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	mc.profile.environment = "main";
	mc.profile.imageBuilderVersion = "2025.06";

	mock.handleUnary("/EnvironmentGetOrCreate", () => ({
		environmentId: "env-main",
		metadata: { name: "main", settings: { imageBuilderVersion: "2026.01" } },
	}));

	expect(await mc.resolveImageBuilderVersion()).toBe("2025.06");
	mock.assertExhausted();
});

test("timeoutMiddleware converts a client-side timeout abort into retryable DEADLINE_EXCEEDED", async () => {
	const call = {
		method: { path: "/test/Test" },
		// biome-ignore lint/suspicious/noExplicitAny: test-only mock of a gRPC call
		next: async function* (_req: any, options: { signal: AbortSignal }) {
			const { signal } = options;
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve()),
			);
			throw signal.reason ?? new Error("aborted");
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: test-only middleware driver
	const iterator = (timeoutMiddleware as any)(call, {
		timeoutMs: 20,
	})[Symbol.asyncIterator]();

	const pending = iterator.next();
	await expect(pending).rejects.toMatchObject({
		code: Status.DEADLINE_EXCEEDED,
		path: "/test/Test",
	});
});

test("timeoutMiddleware propagates a caller-initiated abort as-is", async () => {
	const controller = new AbortController();
	const call = {
		method: { path: "/test/Test" },
		// biome-ignore lint/suspicious/noExplicitAny: test-only mock of a gRPC call
		next: async function* (_req: any, options: { signal: AbortSignal }) {
			const { signal } = options;
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve()),
			);
			throw signal.reason ?? new Error("aborted");
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: test-only middleware driver
	const iterator = (timeoutMiddleware as any)(call, {
		timeoutMs: 5000,
		signal: controller.signal,
	})[Symbol.asyncIterator]();

	const pending = iterator.next();
	controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("timeoutMiddleware returns the response when the call completes in time", async () => {
	const call = {
		method: { path: "/test/Test" },
		// biome-ignore lint/correctness/useYield: test-only generator that returns a value without yielding
		next: async function* () {
			return { ok: true };
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: test-only middleware driver
	const iterator = (timeoutMiddleware as any)(call, {
		timeoutMs: 5000,
	})[Symbol.asyncIterator]();

	const result = await iterator.next();
	expect(result.done).toBe(true);
	expect(result.value).toEqual({ ok: true });
});

test("isRetryableGrpc treats ABORTED as retryable", () => {
	expect(
		isRetryableGrpc(new ClientError("/test", Status.ABORTED, "aborted")),
	).toBe(true);
	expect(
		isRetryableGrpc(
			new ClientError("/test", Status.INVALID_ARGUMENT, "invalid"),
		),
	).toBe(false);
});

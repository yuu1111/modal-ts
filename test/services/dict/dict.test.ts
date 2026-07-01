import { expect, test } from "vitest";
import { createMockModalClients } from "../../support/grpc_mock";

test("DictService.fromName and Dict put/get", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/DictGetOrCreate", (req) => {
		expect(req.deploymentName).toBe("test-dict");
		expect(req.objectCreationType).toBe(1);
		return {
			dictId: "di-test",
			metadata: { name: "test-dict" },
		};
	});

	mock.handleUnary("/DictUpdate", (req) => {
		expect(req.dictId).toBe("di-test");
		expect(req.updates).toHaveLength(1);
		return { created: true };
	});

	mock.handleUnary("/DictGet", (req) => {
		expect(req.dictId).toBe("di-test");
		return {
			found: true,
			value: new Uint8Array([128, 4, 75, 42, 46]),
		};
	});

	const dict = await mc.dicts.fromName("test-dict", { createIfMissing: true });
	await dict.put("answer", 42);
	expect(await dict.get("answer")).toBe(42);
	mock.assertExhausted();
});

test("Dict.get returns default or undefined for missing keys", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/DictGetById", () => ({
		dictId: "di-test",
		metadata: { name: "test-dict" },
	}));
	const dict = await mc.dicts.fromId("di-test");

	mock.handleUnary("/DictGet", () => ({ found: false }));
	mock.handleUnary("/DictGet", () => ({ found: false }));

	expect(await dict.get("missing", "fallback")).toBe("fallback");
	expect(await dict.get("missing")).toBeUndefined();
	mock.assertExhausted();
});

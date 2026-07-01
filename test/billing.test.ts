import { billing, workspaceBillingReport } from "modal";
import { expect, test } from "vitest";
import { createMockModalClients } from "./support/grpc_mock";

test("workspaceBillingReport maps billing rows", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/WorkspaceBillingReport", (req) => {
		expect(req).toMatchObject({
			resolution: "h",
			tagNames: ["team"],
			environmentIds: [],
			appIds: [],
		});
		return [
			{
				objectId: "ap-123",
				description: "app",
				environmentName: "main",
				interval: new Date("2026-01-01T00:00:00Z"),
				cost: "1.25",
				costByResource: { cpu: "1.00" },
				tags: { team: "sdk" },
			},
		];
	});

	const rows = await workspaceBillingReport({
		start: new Date("2026-01-01T00:00:00Z"),
		end: new Date("2026-01-01T01:00:00Z"),
		resolution: "h",
		tagNames: ["team"],
		client: mc,
	});

	expect(rows).toEqual([
		{
			object_id: "ap-123",
			description: "app",
			environment_name: "main",
			interval_start: new Date("2026-01-01T00:00:00Z"),
			cost: "1.25",
			tags: { team: "sdk" },
		},
	]);
	expect(billing.workspaceBillingReport).toBe(workspaceBillingReport);
	mock.assertExhausted();
});

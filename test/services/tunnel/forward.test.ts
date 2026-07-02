import { expect, test } from "vitest";
import { forward } from "../../../src/services/tunnel/forward";
import { createMockModalClients } from "../../support/grpc_mock";

test("forward starts and stops tunnel", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/TunnelStart", (req) => {
		expect(req).toMatchObject({
			port: 8080,
			unencrypted: true,
		});
		return {
			host: "example.modal.run",
			port: 443,
			unencryptedHost: "tcp.example.modal.run",
			unencryptedPort: 32000,
		};
	});

	mock.handleUnary("/TunnelStop", (req) => {
		expect(req).toMatchObject({ port: 8080 });
		return {};
	});

	const url = await forward(
		8080,
		(tunnel) => {
			expect(tunnel.tcpSocket).toEqual(["tcp.example.modal.run", 32000]);
			expect(tunnel.tcp_socket).toEqual(["tcp.example.modal.run", 32000]);
			expect(tunnel.tls_socket).toEqual(["example.modal.run", 443]);
			expect(tunnel.unencrypted_host).toBe("tcp.example.modal.run");
			expect(tunnel.unencrypted_port).toBe(32000);
			return tunnel.url;
		},
		{ client: mc, unencrypted: true },
	);

	expect(url).toBe("https://example.modal.run");
	mock.assertExhausted();
});

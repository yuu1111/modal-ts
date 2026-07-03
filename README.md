# modal-ts

[日本語](./README.ja.md)

Unofficial Modal SDK for TypeScript/JavaScript.
Use Modal from JS/TS projects without a Python runtime.

Based on the JavaScript/TypeScript SDK from
[modal-labs/modal-client](https://github.com/modal-labs/modal-client) (Apache-2.0).

Docs: [English guides](./docs/en/README.md) / [Japanese guides](./docs/ja/README.md).

## Why modal-ts

`modal-ts` packages Modal for JavaScript and TypeScript projects that do not
want a Python runtime in their app setup.

- **Python-free** - Install and run from Node.js without Python
- **TypeScript-first** - Strong types for Modal resources, params, and responses
- **Resource coverage** - Functions, Sandboxes, Queues, Volumes, Images,
  Secrets, and Deploys from one client

## Install

```bash
npm install modal-ts
```

## Authentication

Set environment variables or configure `~/.modal.toml`:

```bash
export MODAL_TOKEN_ID=ak-...
export MODAL_TOKEN_SECRET=as-...
```

## Quick Start

```typescript
import { ModalClient } from "modal-ts";

const modal = new ModalClient();

// Call a deployed function
const echo = await modal.functions.fromName("my-app", "echo");
const result = await echo.remote(["Hello world!"]);
console.log(result);

// Run a sandbox
const app = await modal.apps.fromName("my-app", { createIfMissing: true });
const image = modal.images.fromRegistry("alpine:3.21");
const sb = await modal.sandboxes.create(app, image, { command: ["echo", "hi"] });
console.log(await sb.stdout.readText());
await sb.terminate();
```

## Features

- **Functions** - Call deployed Modal functions and classes
- **Sandboxes** - Create and manage sandboxes with exec, stdin/stdout, tunnels, filesystem access
- **Queues** - Distributed FIFO queues with partition support
- **Volumes** - Persistent storage
- **Images** - Build container images from registries, Dockerfiles, ECR, GCP Artifact Registry
- **Secrets** - Manage environment secrets
- **Deploy** - Deploy apps, functions, and classes via gRPC API

## Development

```bash
bun install           # Install deps + generate proto
bun run typecheck     # Type check
bun run lint          # Biome lint
bun run format        # Biome format
bun run build         # Build (esbuild + tsc)
bun run test          # Run tests (vitest)
```

Some image integration tests require private AWS/GCP registry secrets. Set
`MODAL_TS_SKIP_CLOUD_REGISTRY_TESTS=1` to opt out of those registry-specific
tests when the secrets are not available. The proxy integration test also
requires a pre-created `modal-ts-test-proxy` fixture; set
`MODAL_TS_SKIP_PROXY_TESTS=1` to opt out when it is not available.

## License

Apache-2.0

Protocol Buffer definitions are based on the Apache-2.0 licensed
`modal_proto/` files from
[modal-labs/modal-client](https://github.com/modal-labs/modal-client).

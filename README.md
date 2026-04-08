# modal-ts

[日本語](./README.ja.md)

Unofficial Modal SDK for TypeScript/JavaScript. Forked from [modal-labs/libmodal](https://github.com/modal-labs/libmodal) (Apache-2.0).

## Install

```bash
# From GitHub
bun add github:yuu1111/modal-ts

# Or clone and link for local development
git clone https://github.com/yuu1111/modal-ts.git
cd modal-ts
bun install && bun run build
bun link
# Then in your project:
bun link modal
```

## Quick Start

```typescript
import { ModalClient } from "modal";

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

## Authentication

Set environment variables or configure `~/.modal.toml`:

```bash
export MODAL_TOKEN_ID=ak-...
export MODAL_TOKEN_SECRET=as-...
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
bun test              # Run tests
```

## Differences from upstream

This fork diverges from `modal-labs/libmodal`:

- **TypeScript-only** - Go SDK removed
- **No Python dependency** - Test infrastructure and release scripts rewritten in TypeScript
- **Bun** - Uses Bun instead of npm
- **Biome** - Uses Biome instead of ESLint + Prettier
- **Strict TypeScript** - `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` enabled. No `any`, no `@ts-` directives
- **esbuild** - Direct esbuild instead of tsup

## License

Apache-2.0. Proto definitions from [modal-labs/modal-client](https://github.com/modal-labs/modal-client) (Apache-2.0).

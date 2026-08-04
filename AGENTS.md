# Modal TypeScript SDK

Unofficial Modal (serverless platform) SDK for JavaScript/TypeScript.

## Overview

- Proto definitions live in `modal_proto/` (copied from modal-labs/modal-client, Apache-2.0).
- Generated code in `src/generated/` must never be edited by hand — regenerate via `bun run proto`.
- The public surface is `src/index.ts` (also `src/internal.ts` for the internal-only API behind the `./internal` export subpath).

## Commands

```bash
bun install                              # Install dependencies
bun run typecheck                        # TypeScript type checking (tsc --noEmit)
bun run lint                             # Biome lint
bun run format                           # Biome format (write + unsafe)
bun run build                            # Build dist/ (esbuild ESM+CJS + tsc)
bun run test                             # Run all tests (vitest)
bun run test -- test/client.test.ts      # Single test file
bun run test -- --grep "pattern"         # Filter by test name
```

`bun install` does not generate proto code; run `bun run proto` to (re)generate `src/generated/`. The proto script also patches `src/generated/modal_proto/api.ts` to avoid the codegen `Object` naming collision.

## Testing

Most tests use gRPC mocks (`test/support/grpc_mock.ts`) and require no authentication. Integration tests (sandbox, volume, queue, etc.) require Modal credentials:

```bash
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

Tests: max 10 concurrent, 20s timeout.

## Architecture

- **Client** (`src/client.ts`) — Central entry point managing auth, gRPC connection, and service access.
- **Services** — Per-resource classes accessed via `client.functions`, `client.sandboxes`, `client.volumes`, `client.queues`, `client.secrets`, `client.images`, `client.proxies`, `client.cls`, `client.functionCalls`, `client.cloudBucketMounts`. Each exposes factory methods (`.fromName()`, `.fromId()`, `.create()`).
- **Auth** (`src/auth_token_manager.ts`) — JWT-based token management with automatic rotation.
- **Config** (`src/config.ts`) — TOML config from `~/.modal.toml`, overridable by `MODAL_*` env vars and explicit params.
- **Errors** (`src/errors.ts`) — Typed hierarchy: `RemoteError`, `NotFoundError`, `InvalidError`, `AlreadyExistsError`, `FunctionTimeoutError`, `SandboxTimeoutError`, `QueueEmptyError`, `QueueFullError`, `ClientClosedError`, etc.
- **Serialization** (`src/serialization.ts`) — CBOR for gRPC payloads.
- **Deploy** (`src/deploy.ts`) — Deploy apps, functions, classes via gRPC API (`deployApp`, `deployApp`, `createMount`, etc.).
- **gRPC** (`src/client.ts`) — nice-grpc + protobufjs (promises-based), with built-in auth/retry/timeout middleware.

## Conventions

- **Duration params** use `Ms` suffix (e.g., `timeoutMs`).
- **Memory params** use `MiB` suffix (e.g., `memoryMiB`).
- Renamed params are validated via `checkForRenamedParams` (`src/validation.ts`).

## Release

- Publish a `vX.Y.Z` GitHub Release matching the `package.json` version.
- Do not run npm publish locally; leave it to the Trusted Publisher in `.github/workflows/release.yml`.
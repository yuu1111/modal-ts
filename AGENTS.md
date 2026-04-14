# Repository Overview

Modal (serverless platform) SDK for JavaScript/TypeScript. Proto definitions live in `modal_proto/` (copied from modal-labs/modal-client, Apache-2.0). Generated code in `src/generated/` must never be edited by hand.

# Commands

```bash
bun install                              # Install deps + generate proto code
bun run typecheck                        # TypeScript type checking
bun run lint                             # Biome lint
bun run format                           # Biome format
bun run build                            # Build distribution (esbuild + tsc)
bun run test                             # Run all tests (vitest)
bun run test -- test/client.test.ts      # Single test file
bun run test -- --grep "pattern"         # Filter by test name
```

# Proto Regeneration

```bash
bun run proto
```

# Testing

Most tests use gRPC mocks (`test/support/grpc_mock.ts`) and require no authentication. Integration tests (sandbox, volume, queue etc.) require Modal credentials:

```bash
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

Tests: max 10 concurrent, 20s timeout.

**Important:** Do not run integration tests for routine change verification. Use `bun run typecheck` + relevant unit tests only. Integration tests are slow, require credentials, and may fail for reasons unrelated to your changes. Only run them when explicitly asked.

# Architecture

- **Client** (`src/client.ts`) — Central entry point managing auth, gRPC connection, and service access
- **Services** (`FunctionService`, `SandboxService`, etc.) — Per-resource classes accessed via `client.functions`, `client.sandboxes`, etc., with factory methods (`.fromName()`, `.fromId()`, `.create()`)
- **Auth** (`src/auth_token_manager.ts`) — JWT-based token management with automatic rotation
- **Config** (`src/config.ts`) — TOML config from `~/.modal.toml`, overridable by `MODAL_*` env vars and explicit params
- **Errors** (`src/errors.ts`) — Typed hierarchy: `RemoteError`, `NotFoundError`, `InvalidError`, `FunctionTimeoutError`, etc.
- **Serialization** (`src/serialization.ts`) — CBOR for gRPC payloads
- **Deploy** (`src/deploy.ts`) — Deploy apps, functions, classes via gRPC API

# Key Conventions

- **Duration params** use `Ms` suffix (e.g., `timeoutMs`)
- **Memory params** use `MiB` suffix (e.g., `memoryMiB`)
- **gRPC**: nice-grpc + protobufjs (promises-based)

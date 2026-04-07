# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Modal (serverless platform) SDK for JavaScript/TypeScript (`modal-js/`). Proto definitions live in `modal-client/` submodule (`modal_proto/`). Generated code must never be edited by hand.

## Commands (modal-js/)

```bash
bun install                              # Install deps + generate proto code
bun run check                            # TypeScript type checking
bun run lint                             # Biome lint
bun run format                           # Biome format
bun run build                            # Build distribution
bun test                                 # Run all tests
bun test test/client.test.ts             # Single test file
bun test --grep "pattern"               # Filter by test name
```

## Proto Regeneration

```bash
cd modal-js && bun run prepare
```

## Testing

Tests run against Modal cloud infrastructure and require authentication:

```bash
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
MODAL_ENVIRONMENT=libmodal
```

Test setup lives in `test-support/`. JS tests: max 10 concurrent, 20s timeout.

## Architecture

- **Client** (`client.ts`) — Central entry point managing auth, gRPC connection, and service access
- **Services** (`FunctionService`, `SandboxService`, etc.) — Per-resource classes accessed via `client.functions`, `client.sandboxes`, etc., with factory methods (`.fromName()`, `.fromId()`, `.create()`)
- **Auth** (`auth_token_manager.ts`) — JWT-based token management with automatic rotation
- **Config** (`config.ts`) — TOML config from `~/.modal.toml`, overridable by `MODAL_*` env vars and explicit params
- **Errors** (`errors.ts`) — Typed hierarchy: `RemoteError`, `NotFoundError`, `InvalidError`, `FunctionTimeoutError`, etc.
- **Serialization** (`serialization.ts`) — CBOR for gRPC payloads

## Key Conventions

- **Duration params** use `Ms` suffix (e.g., `timeoutMs`)
- **Memory params** use `MiB` suffix (e.g., `memoryMiB`)
- **gRPC**: nice-grpc + protobuf-ts (promises-based)

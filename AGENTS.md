# Repository Overview

Monorepo containing Modal (serverless platform) SDKs for JavaScript/TypeScript (`modal-js/`) and Go (`modal-go/`). Deprecated — migrated to `modal-labs/modal-client`. Currently in maintenance mode (bug fixes and patch releases only).

Proto definitions live in `modal-client/` submodule (`modal_proto/`). Generated code must never be edited by hand.

# Commands

## JavaScript (modal-js/)

```bash
npm install                              # Install deps + generate proto code
npm run check                            # TypeScript type checking
npm run lint                             # ESLint
npm run format:check                     # Prettier check
npm run format                           # Auto-fix formatting
npm run build                            # Build distribution
npm test                                 # Run all tests
npm test -- --run test/client.test.ts     # Single test file
npm test -- --run --grep "pattern"        # Filter by test name
npm run test:watch                       # Watch mode
```

## Go (modal-go/)

```bash
golangci-lint run                        # Lint (errcheck, govet, staticcheck, etc.)
go fmt ./...                             # Format
go test -v -count=1 -parallel=10 ./...   # All tests
go test -v -count=1 ./                   # Tests in root directory
go test -v -count=1 ./test               # Tests in test/ directory
go test -run TestName -v ./              # Single test by name
```

## Proto Regeneration

```bash
cd modal-js && npm run prepare
cd modal-go && ./scripts/gen-proto.sh    # Requires protoc-gen-go and protoc-gen-go-grpc
```

# Testing

Tests run against Modal cloud infrastructure and require authentication:

```bash
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
MODAL_ENVIRONMENT=libmodal
```

Test setup lives in `test-support/`. JS tests: max 10 concurrent, 20s timeout. Go tests: parallel=10, uses goleak for goroutine leak detection.

# Architecture

Both SDKs follow the same structure and must maintain feature parity:

- **Client** (`client.ts` / `client.go`) — Central entry point managing auth, gRPC connection, and service access
- **Services** (`FunctionService`, `SandboxService`, etc.) — Per-resource classes accessed via `client.functions`, `client.sandboxes`, etc., with factory methods (`.fromName()`, `.fromId()`, `.create()`)
- **Auth** (`auth_token_manager`) — JWT-based token management with automatic rotation
- **Config** (`config`) — TOML config from `~/.modal.toml`, overridable by `MODAL_*` env vars and explicit params
- **Errors** — Typed hierarchy: `RemoteError`, `NotFoundError`, `InvalidError`, `FunctionTimeoutError`, etc.
- **Serialization** — CBOR for gRPC payloads

# Key Conventions

- **Language parity is mandatory**: when merging a feature, update both JS and Go simultaneously with tests
- **JS duration params** use `Ms` suffix (e.g., `timeoutMs`); **Go** uses `time.Duration`
- **Memory params** use `MiB` suffix in both languages (e.g., `memoryMiB`)
- **JS gRPC**: nice-grpc + protobuf-ts (promises-based)
- **Go gRPC**: google.golang.org/grpc + protobuf; generated proto files are checked into git
- **Go tests**: use gomega assertions, goleak for goroutine leak detection, `t.Parallel()`

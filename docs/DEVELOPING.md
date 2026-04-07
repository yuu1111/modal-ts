# Contributing to the Modal JS SDK

## Tests

Tests are run against Modal cloud infrastructure, and you need to be authenticated with Modal to run them. See the [`test-support/`](./test-support) folder for details.

## modal-js development

Clone the repo, including submodules, and run:

```bash
bun install
```

Run a script:

```bash
cd modal-js
bun run examples/sandbox.ts
```

### JS naming conventions

- Parameters should always include explicit unit suffixes to make the API more self-documenting and prevent confusion about units:
  - durations should be suffixed with `Ms`, e.g. `timeoutMs` instead of `timeout`
  - memory should be suffixed with `MiB`, e.g. `memoryMiB` instead of `memory`

### gRPC support

We're using `nice-grpc` because the `@grpc/grpc-js` library doesn't support promises and is difficult to customize with types.

This gRPC library depends on the `protobuf-ts` package, which is not compatible with tree shaking because `ModalClientDefinition` transitively references every type. However, since `modal-js` is a server-side package, having a larger bundled library is not a huge issue.

## How to publish

1. Ensure all changes are captured in the ["Unreleased" section of the `CHANGELOG.md`](https://github.com/modal-labs/libmodal/blob/main/CHANGELOG.md#unreleased).
2. Manually trigger the [Open PR for release](https://github.com/modal-labs/libmodal/actions/workflows/release.yaml) workflow in GitHub Actions by clicking "Run workflow", selecting the version to bump (patch, minor, or major), and choosing "stable" or "dev" as the release type.
3. Review and merge the release PR. This automatically triggers the [Publish Release](https://github.com/modal-labs/libmodal/actions/workflows/publish.yaml) workflow, which builds and publishes the packages. If it's a dev release, a `-dev.X` suffix is appended to the version, and the packages are published with the `next` tag on npm.

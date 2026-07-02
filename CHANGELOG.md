# Changelog

This changelog tracks `modal-ts` releases from the fork point. Older upstream
`modal-js` and `modal-go` release history is intentionally not copied here.

## Unreleased

## 1.0.0 - 2026-07-02

- Add broad Python SDK parity helpers across client, app, function, class,
  image, sandbox, queue, dict, volume, cloud bucket mount, tunnel, and deploy
  APIs.
- Add Python-style snake_case parameter aliases and compatibility helpers while
  preserving the TypeScript-first camelCase API.
- Add local function and class deployment helpers, generated shim support, and
  TypeScript entrypoint bundling for deploy workflows.
- Add server, billing, scheduler placement, workspace, environment, proxy, and
  V1/V2 sandbox support surfaces.
- Refresh generated protobuf clients and parity audit coverage for upstream JS
  and Python SDK API drift.
- Document the remaining structural Python parity gaps in Japanese under
  `docs/python-parity-notes.md`.
- Stabilize full test runs by allowing opt-out for private AWS/GCP registry and
  proxy fixture integration tests.
- Remove the GitHub Actions npm publish workflow. Publishing is now a local,
  explicit maintainer action.
- Remove the upstream-style release PR workflow and release helper script.
- Clean up release documentation that still pointed at upstream `modal-labs`
  workflows.

## 0.8.1

- Publish the SDK as `modal-ts`.
- Keep the SDK TypeScript-only and remove the upstream Go SDK layout.
- Use Bun for dependency management, scripts, and tests.
- Use Biome for linting and formatting.
- Build ESM and CommonJS outputs with esbuild and TypeScript declarations.
- Provide Modal service clients for functions, classes, sandboxes, images,
  queues, volumes, secrets, and deploy workflows.

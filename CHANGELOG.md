# Changelog

This changelog tracks `modal-ts` releases from the fork point. Older upstream
`modal-js` and `modal-go` release history is intentionally not copied here.

## Unreleased

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

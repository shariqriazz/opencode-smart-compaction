# Development

The toolchain is pinned in `mise.toml`, Bun manages dependencies through `bun.lock`, and tests run under Node's built-in test runner with native TypeScript.

## Commands

- `mise install --locked`: install the pinned Bun and Node.
- `mise exec --locked -- bun install`: install locked dependencies.
- `mise exec --locked -- bun run validate`: typecheck and run the tests.
- `mise exec --locked -- bun run pack:inspect`: list what the npm package would contain.

## Test against a live OpenCode

Test the published package. After a release, pull it into OpenCode, which checks unpinned plugins for updates but never installs them on its own, then confirm the plugin is active at the new version:

```bash
opencode plugin update
opencode api get /api/plugin
```

If `/api/plugin` still reports the old version, run `opencode service restart`.

Compact a session that has at least two exchanges:

```bash
opencode api post /api/session/<session-id>/compact --data '{}'
```

Then read the session's messages (`opencode api get /api/session/<session-id>/message`). The completed `compaction` message should have the six numbered sections, any retained identifiers, and the file-state blocks at the end. Compact the same session again after another exchange: the read and touched file lists should still include files from before the first compaction, and the turns OpenCode kept verbatim the first time should be reflected in the new summary. With a background shell running (for example `sleep 600` started with the shell tool's `background` option), its command should appear in the background-process block. With a background subagent still working (the `subagent` tool with `background: true`), its session ID, agent, and description should appear in the `<running-subagents>` block, and should be gone from the next checkpoint after it reports back.

To check the threshold without filling a large window, set `"thresholdMode": "hard"` and a small `hardLimitTokens` (for example `20000`) in the plugin's options, send a few prompts, and confirm a `compaction` message appears once a step passes that size. Restore the real options afterward.

To check recent-context trimming cheaply, set `maxRecentTokens` to `300` in an isolated test location, read several files during a session with at least two exchanges, then compact it. The stored checkpoint should still contain the full recent text and a `recent-context-summarized` appendix. Ask the model to quote the first line inside the recent-context block: when it was oversized, that line should be the omission note. Inspect the next assistant message's input/cache tokens too. Compact again after another exchange to check coverage carries forward. Repeat with `maxRecentTokens: 0` to confirm no marker or trimming is added; restore the default afterward. For an unreleased branch, test the installed Git package so package entrypoint resolution is exercised too.

## Releases

Pushing to `main` runs CI (`.github/workflows/ci.yml`). The publish workflow (`.github/workflows/publish-npm.yml`) validates and publishes to npm with provenance whenever `package.json` carries a version that isn't on npm yet, so bump `version` with every functional change.

Publishing uses npm trusted publishing (OIDC), so the repository holds no npm token. The package's trusted publisher on npmjs.com names this repository and `publish-npm.yml`; renaming the workflow file breaks publishing until that setting is updated.

## Upgrading OpenCode

1. Raise `@opencode/plugin` in `devDependencies` and the `peerDependencies` floor, then run `bun install`.
2. Check for changes that the plugin depends on:
   - `node_modules/@opencode/plugin/dist/promise/session.d.ts`: the `compaction` and mutable `context` hook events and `generate.text` input.
   - The OpenCode checkpoint wrapper in `packages/core/src/session/runner/to-llm-message.ts` and `messageToText` in `packages/core/src/session/compaction.ts`, which the plugin parses.
   - `calculateCeiling` in `packages/core/src/session/compaction.ts`, which decides when OpenCode's own trigger fires relative to `compaction.buffer`.
   - The events the plugin reads: `session.step.started`, `session.step.ended`, `session.compaction.*`, `session.deleted`, `shell.created`, `shell.exited`, `shell.deleted`, `model.updated`, and `provider.updated`; and the shell tool's `metadata.sessionID`.
   - `ctx.session.context` and the stored message fields `src/subagents.ts` reads: the `subagent` tool part's `metadata.status` and `metadata.sessionID`, and the completion synthetic message's `metadata.source` and `metadata.childID` (written by the subagent background job in `packages/core`).
   - Request message IDs, OpenCode's older/recent split, and the stored user, synthetic, assistant, and tool-state shapes adapted in `src/recent.ts`. No reliable boundary or coverage means no trimming.
   - The built-in tool names and input fields in `packages/core/src/tool/plugin/` (`read`, `edit`, `write`, `patch`, `shell`).
3. Run `validate`, publish, and repeat the live test above.

# AGENTS.md

## Project

An OpenCode 2 plugin, published to npm as `opencode-smart-compaction`, that writes compaction checkpoints in the Smart Compaction format through the session `compaction` hook. Read `docs/ARCHITECTURE.md` before changing hook behavior.

## Commands

- `mise exec --locked -- bun run validate`: typecheck and tests. Run it before every commit.
- `mise exec --locked -- bun run pack:inspect`: check the npm payload after changing `package.json` or `files`.

## Critical patterns

- Target the OpenCode 2 plugin API only (`{ id, setup }`); do not add a V1 `server()` entrypoint.
- Import only types from `@opencode/plugin`. It stays a dev and optional peer dependency, never a runtime dependency.
- The hook fails open: when every model attempt errors or returns a summary without all six sections, leave `event.result` unset so OpenCode compacts with its own prompt.
- The plugin started as a port of the Pi Smart Compaction extension but is maintained on its own. Change the prompts, checkpoint format, and appended state for OpenCode alone; there is no second copy to keep in step.
- `src/subagents.ts` reads the stored session messages from `ctx.session.context`: the `subagent` tool part's `metadata.status`/`metadata.sessionID` and the synthetic completion message's `metadata.source`/`metadata.childID`. Recheck those fields on every OpenCode upgrade.
- `src/session.ts` parses text OpenCode generates (paths in the OpenCode repository): the checkpoint wrapper (`packages/core/src/session/runner/to-llm-message.ts`) and the recent-context lines (`messageToText` in `packages/core/src/session/compaction.ts`). Recheck both on every OpenCode upgrade; the full checklist is in `docs/DEVELOPMENT.md`.
- `src/recent.ts` must only trim a checkpoint whose kept turns were included in its summary. Check request message IDs, stored message shapes, checkpoint rendering, and copy semantics on OpenCode upgrades; never change stored history to bound requests.
- The 95% threshold only works when OpenCode's `compaction.buffer` is below 5% of the window; keep the README's buffer guidance in step with any threshold change.
- Prompt strings contain literal XML-style tags. Verify them with `grep` on the file, since some editing tools hide them in their display.
- Test releases live against the published npm package. For an unreleased branch, use an installed Git package so entrypoint resolution is exercised; a local re-export wrapper alone doesn't check packaging.

## Releases

Bump `version` in `package.json` with every functional change; pushing it to `main` publishes through `.github/workflows/publish-npm.yml`. OpenCode does not install new versions of an unpinned plugin by itself: after the publish workflow succeeds, wait until the version's tarball is served (npm can lag several minutes), then run `opencode plugin update opencode-smart-compaction` and `systemctl restart opencode` so the host's `opencode.service` loads it, confirm the version with `opencode plugin list`, and run the live test in `docs/DEVELOPMENT.md`. The user has given standing approval for this update and restart after every release; do not ask first.

On this host: run the `opencode plugin` commands from a project directory (from `/root` they report no plugins), and the binary is at `~/.opencode/bin/opencode`, which may not be on `PATH`. Restart with `systemctl`, not `opencode service restart`: from an agent shell the latter starts a detached server outside the unit, and `opencode.service` then restart-loops until that process is stopped.

# Architecture

The plugin registers OpenCode 2 session hooks for `compaction` and `context`. It supplies the checkpoint as the compaction hook's result, so OpenCode skips its own summary request. The context hook bounds oversized recent-context blocks on marked checkpoints without changing stored messages. A watcher on the event stream adds the hybrid compaction threshold and tracks running shells, and the compaction hook lists background subagents that haven't reported back.

## Key files

- `src/index.ts`: the plugin definition (`{ id, setup }`), the compaction hook with its model attempts, and the event watcher's start.
- `src/session.ts`: reads the previous checkpoint and its verbatim recent context, user text, accumulated file activity, and a bounded transcript from the request messages.
- `src/checkpoint.ts`: builds the prompt, checks the summary's sections, and completes the summary.
- `src/prompt.ts`: the checkpoint prompts, protected-fact extraction, and file-state formatting.
- `src/git-state.ts`: dirty files and a bounded diff with untracked-file previews.
- `src/events.ts`: the single event-stream loop.
- `src/shells.ts`: running shells per session.
- `src/subagents.ts`: background subagents that haven't reported back.
- `src/recent.ts`: finds and adapts the kept stored turns for summary coverage, and deterministically bounds recent context in requests.
- `src/threshold.ts`: the hybrid threshold options and the step watcher that requests compaction.

## How it works

1. OpenCode splits the session into an older part to summarize and a recent part it keeps verbatim (`compaction.keep.tokens`), then calls the `compaction` hook with the older part as `event.messages`.
2. When a previous checkpoint exists, it is the first message, wrapped in `<conversation-checkpoint>`. `readSessionFacts` takes its summary out and returns the new conversation as a transcript. The previous checkpoint's `<recent-context>` is included unless the summary already marks it as covered; those turns no longer appear individually in the active context. The transcript includes user and assistant text, reasoning excerpts, tool calls with large arguments bounded, and tool results that keep their beginning and end within a per-tool budget (more for errors and the newest 14 messages; shell output loses terminal escape codes and repeated lines). It also collects user text and file activity: `read` for read files; `edit`, `write`, and the `*** Add/Update/Delete File` and `*** Move to` lines of `patch` for changed files, skipping calls whose result is an error. File activity from the recent context's tool-call lines and from the file lists appended to the previous checkpoint is added, so the lists accumulate across compactions; each list keeps only its most recently used paths (40 read, 60 changed), listed from least to most recently used so the order carries into the next compaction.
3. The plugin looks up the session's directory and model (`ctx.session.get`) and reads its git state. It reads the session's active context (`ctx.session.context`: every stored message since the last compaction, including the turns OpenCode will keep verbatim) for background subagents: a `subagent` tool part whose `metadata.status` is `running` starts one, and a synthetic message with `metadata.source` `subagent` and the same `metadata.childID` ends it. A completed foreground report for the same child also clears it. Subagents listed in the previous checkpoint's `<running-subagents>` block are carried in first, since their launch may predate the context. If the context can't be read, those previously recorded children are retained; new launches and completions cannot be discovered until a later read succeeds.
4. `buildCheckpoint` assembles one prompt: the directives, the transcript in `<conversation>`, the previous checkpoint in `<previous-summary>` with its appended state stripped (`semanticSummary`), the protected facts, and the initial or update instructions.
5. `ctx.generate.text` runs the prompt on the compaction model (`event.model`: the session's model, or `agents.compaction.model` when set). The model reference carries the variant, so its reasoning settings apply. `isCompleteSummary` requires all six numbered sections, since the API reports no finish reason and a cut-off reply usually loses the last sections. An incomplete reply or a retryable error moves to the next model from `summaryModels`: the same model without its variant, then the session's model without a variant. `isFatalGenerationError` (cancellation, authentication, permission, quota) stops the attempts.
6. `completeSummary` restores dropped protected facts and appends the file-state blocks, including the session's running shells from `createShellTracker` and its running subagents with a note not to poll, relaunch, or duplicate them. The result goes into `event.result.summary`, which OpenCode stores as the checkpoint and puts in front of the recent conversation.

### Bounding kept context

With `maxRecentTokens > 0` (default 40,000), the compaction hook uses request message IDs to find the last older message in `ctx.session.context`. When a previous checkpoint has no request ID, its summary can instead be matched exactly against a stored completed compaction. Stored turns after the boundary are adapted to the transcript message shape and passed through `readSessionFacts` with the older messages, so their user facts, file activity, errors, and resume state are included in the checkpoint. Synthetic, skill, and system context is labeled separately from user-authored intent; shell results use the same bounded serializer as other tool results. A `recent-context-summarized` appendix marks that coverage. If context cannot be read, the boundary cannot be matched, or transcript-bearing content such as user attachments cannot be adapted, no marker is added and no trimming is allowed.

The `context` hook shortens only a marked checkpoint's recent block. It estimates tokens as characters divided by four, keeps the newest portion at a turn boundary when possible, and adds an omission note. Copies preserve message and part prototypes; stored messages remain unchanged. The cut depends only on the text and budget, so repeated requests have the same prefix. On the next compaction, a marked checkpoint's recent text is still read for protected user facts and file activity but isn't added to the semantic transcript again. Unmarked checkpoints keep the old behavior. `maxRecentTokens: 0` disables both extra kept-turn coverage and trimming.

Manual compaction places an empty running-compaction record in the stored context before the hook runs. That placeholder and idle records have no conversation to cover. Earlier failed compactions contribute a labeled, bounded error; completed checkpoints inside the kept tail remain unsupported rather than silently losing their summaries.

### Events

`subscribe` (`src/events.ts`) runs one loop over `ctx.event.subscribe` and feeds each event to two handlers; the setup's returned cleanup aborts it.

- `createShellTracker` (`src/shells.ts`) keeps running shells from `shell.created`, keyed by shell ID and tagged with `metadata.sessionID`, which OpenCode's shell tool sets, and drops them on `shell.exited` or `shell.deleted`.
- `createThresholdWatcher` (`src/threshold.ts`) implements the threshold below.

### Threshold

OpenCode's own automatic compaction runs only at the model window minus `compaction.buffer`. The watcher remembers each session's model from `session.step.started`, and on `session.step.ended` adds up the step's input, cache, output, and reasoning tokens, the same measure OpenCode uses. When that reaches the threshold (hybrid by default: the lower of 95% of `limit.input || limit.context` and 600,000), it calls `ctx.session.compact`. OpenCode delivers the request at the next step boundary, so an agent loop that was mid-task continues after the checkpoint. One request is outstanding per session; a session whose compaction failed is left to OpenCode's own trigger until a compaction succeeds.

## Decisions and trade-offs

- **The plugin writes the summary.** OpenCode appends its own summary template after hooks run and rejects replies that don't use its headings. Supplying `event.result` is the only way to use the six-section format without fighting that template.
- **Independent of Pi.** `src/prompt.ts` and `src/git-state.ts` began as adaptations of the Pi extension's `prompt.ts` and `engine.ts`, but the plugin is maintained on its own and its checkpoint format follows OpenCode's needs.
- **Size budget.** OpenCode keeps recent turns verbatim beside the checkpoint, so the prompt asks for at most about 1,500 words, keeps an updated summary near the previous one's length, and tells the model not to repeat the appended file lists and diff.
- **Fail open.** When every attempt fails or is incomplete, `event.result` stays unset, so OpenCode compacts with its own prompt and its own size handling. Pi cancels compaction instead; in OpenCode a cancelled automatic compaction would leave the session at its limit.
- **No runtime dependencies.** The plugin imports only OpenCode types. `Plugin.define` is an identity function, so the default export is a plain object checked with `satisfies Plugin.Plugin`.
- **No size retry.** OpenCode shrinks its own compaction request when a provider rejects it as too long. The plugin's request is a single text prompt; if it is rejected, OpenCode's own compaction takes over.
- **Stateless generation.** `ctx.generate.text` takes only a prompt and a model, so the summary request skips session request hooks (`model.request`, `http.request`), agent request overlays, and OpenCode's summary output cap. It also can't be cancelled, can't turn reasoning off, and returns no token usage, so there is no per-attempt timeout and compaction cost isn't recorded. `ctx.session.generate` would keep the hooks but sends the whole session history, which is what compaction is removing.
- **Serialization lives in `session.ts`.** The transcript budgets follow the Pi serializer in substance but are written for OpenCode's message parts and tool names (`shell`, `patch`, `glob`, `oldString`/`newString`, `patchText`), so they live apart from `prompt.ts`.
- **Threshold after the step.** The threshold uses the size a step reported, so it compacts before the next step rather than cancelling the current one. OpenCode's own buffer threshold, which estimates before each request, stays as the backstop; a buffer larger than the plugin's margin makes OpenCode compact first.

## Gotchas

- **Entry point.** OpenCode loads an npm plugin from the package's `./server` or `.` export, and a local directory plugin only from an `index` or `server` file at its root. This package uses the `.` export, so test it from npm or from a file under `.opencode/plugins/` that re-exports `src/index.ts`.
- **OpenCode's serialized formats.** `parseCheckpoint` depends on the checkpoint wrapper in OpenCode's `session/runner/to-llm-message.ts` (summary, then a `recent-context` block), and `recentToolCalls` and `recentUserTexts` depend on the `[User]:` and `[Assistant tool call]: name(json)` lines that `messageToText` in `session/compaction.ts` writes. A change there silently drops recent turns or file activity.
- **Buffer coupling.** The plugin's percentage threshold only takes effect when OpenCode's own `compaction.buffer` leaves a smaller margin; with the default 10% buffer, OpenCode compacts at 90% first.
- **Literal tags.** Prompt and appendix strings contain XML-style tags (`<previous-summary>`, `<touched-files>`, and others). Some editing tools hide those tags in their display; check the file bytes rather than the rendered view when editing them.

## Related docs

- [README](../README.md): what the checkpoint contains, installation, and configuration.
- [Development](DEVELOPMENT.md): commands, tests, and releases.

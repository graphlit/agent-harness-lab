# AGENTS.md

Guidance for coding agents working in the Graphlit Agent Harness Lab repository.

This is a public open-source sample app. Keep changes focused, maintainable,
and aligned with the core demo: many agent harnesses, one shared Graphlit
context layer.

## Product Shape

Agent Harness Lab compares how different agent harnesses answer the same prompt
when they can all use the same Graphlit tools and content context.

The important distinction:

- Graphlit is the shared context layer: setup ingestion, retrieval, web search,
  source inspection, resource reading, and the Graphlit baseline lane.
- Lanes are harness adapters: OpenAI Agents SDK, Vercel AI SDK, LangGraph,
  Mastra, Claude Agent SDK, Google ADK, and future harnesses.
- Do not build a separate custom retrieval layer, ad hoc document parser, or
  vector store. Use Graphlit SDK primitives and `@graphlit/agent-tools`.
- The app should make agent execution inspectable: tool calls, sources, lane
  events, telemetry, judge scores, and session continuity are product features.

## Read First

Before editing, inspect the actual code path. Prefer `rg` and focused reads.

Useful entry points:

- `src/components/AppShell.tsx`: main UI, composer, lane panels, judge panel.
- `src/app/api/lanes/_shared.ts`: shared streaming route behavior for lanes.
- `src/lib/lanes/recorder.ts`: common event, tool, source, duration, and usage
  recording.
- `src/lib/lanes/*.ts`: individual harness implementations.
- `src/lib/tools/createGraphlitTools.ts`: shared Graphlit tool set.
- `src/lib/tools/recordTool.ts`: tool call wrapping and telemetry.
- `src/lib/graphlit/bootstrap.ts`: Graphlit project/specification bootstrap.
- `src/lib/constants.ts`: lane labels, model names, defaults, bootstrap version.
- `src/lib/types.ts`: cross-lane contracts and streamed event types.

## Architecture Rules

- Keep provider API keys and Graphlit credentials server-side only.
- Route all lane execution through `/api/lanes/{lane}` and the shared lane route
  helper unless there is a strong reason not to.
- Keep the lane contract common. A lane should return `LaneRunResult` with
  answer, tool calls, sources, raw events, session state, duration, and usage
  when available.
- Use `LaneRunRecorder` for tool calls, sources, raw events, session state,
  token usage, and timing. Do not reimplement per-lane recorder logic.
- Preserve lane isolation: one lane failing must not block other lanes or the
  judge from using successful lane results.
- Preserve session continuity per lane. If a harness supports sessions or memory,
  store only serializable session state in `LaneSessionState`.
- Raw events should be useful to humans. Prefer compact provider/recorder event
  streams over dumping duplicated UI wrapper state.

## Graphlit Rules

- Use `createGraphlitClient()` from `src/lib/graphlit/client.ts`.
- Use the shared read-only lane tools from `createGraphlitTools()`:
  `retrieve_contents`, `inspect_content`, `count_contents`, `list_resources`,
  `read_resource`, `web_search`, and `web_map`.
- Do not expose ingestion, deletion, enrichment, memory, fact, entity, or
  conversation tools to agent lanes unless the benchmark scope explicitly
  changes. UI-triggered ingestion is setup context, not a lane ability.
- For UI-triggered content ingestion, call Graphlit directly from a server route:
  `client.ingestUri()` for URLs and `client.ingestEncodedFile()` for local files.
- After direct ingestion, poll `client.isContentDone()` before claiming content
  is retrieval-ready.
- If Graphlit configuration is missing, make that state explicit in the UI. Do
  not let client-side code crash because credentials are absent.
- The Graphlit Studio link should point users to `https://www.graphlit.dev/home`
  for managing content, data sources, and deletion.

## Bootstrapping Specs

When changing bootstrapped Graphlit specifications, model defaults, or judge
specs:

- Update `src/lib/graphlit/bootstrap.ts`.
- Bump `AGENT_HARNESS_LAB_BOOTSTRAP_VERSION` in `src/lib/constants.ts`.
- Thinking/reasoning can be enabled for providers that support it.
- It is OK to cap a thinking token limit when the provider requires one.
- Do not cap completion token limits in bootstrapped specs; let Graphlit/provider
  defaults calculate the completion budget.

## Adding Or Editing Lanes

When adding a lane or provider, update the whole surface:

- `LANE_IDS` and related types in `src/lib/types.ts`.
- Labels, default lanes, and model labels in `src/lib/constants.ts`.
- The route under `src/app/api/lanes/{lane}/route.ts`.
- The runner in `src/lib/lanes/{lane}.ts` and export map in
  `src/lib/lanes/index.ts`.
- Brand/icon handling in `src/components/BrandIcon.tsx` and lane button UI.
- README and `CONTRIBUTING.md` if the public contribution story changes.

Lane implementations should:

- Use the selected model provider preference only when the harness supports it.
- Require only the API key needed for that provider/lane.
- Expose the shared Graphlit tools in the harness-native way.
- Record raw provider events or run results with `recorder.recordRaw()`.
- Record token usage with `recorder.recordTokenUsage()` when the SDK exposes it.
- Use `context.abortSignal` where the SDK supports cancellation.

## UI Guidance

- Build the actual workbench, not a landing page.
- Keep the console centered with the existing `max-w-5xl` shell.
- The composer is the payload container: text, file ingest, URI ingest, and send
  controls belong together.
- The bottom routing bar is for harness lanes. Do not move ingestion controls
  into the global settings row or make them look like lane selectors.
- The Graphlit chip in the lane bar represents the context layer/baseline and
  links to Graphlit Studio.
- Keep the UI dense, inspectable, and polished. Avoid marketing copy,
  oversized hero treatments, decorative gradients, and layout shifts.
- Judge output should use friendly lane names, not anonymous lane letters, in
  user-facing prose.

## Judge Rules

- The judge compares completed lane results after at least two lanes succeed.
- Use friendly lane names in judge summaries and rationale.
- Prefer answers that visibly use retrieved Graphlit evidence when the prompt
  needs current or private context.
- Judge UI should explain scoring dimensions enough to be readable:
  retrieval, source inspection, groundedness, helpfulness, and unsupported-claim
  risk.
- Judge failures should not erase lane results.

## Verification

Use Node.js 20.9.0 or newer.

Common commands:

```bash
npm run check-types
npm run lint
npm run build
```

Run `npm run check-types` after changes that touch TypeScript contracts, routes,
lane implementations, Graphlit bootstrap/specs, or shared UI state. For small CSS
or copy-only changes, a careful diff review is usually enough.

## Worktree Safety

- Worktrees may contain in-progress changes from maintainers or other agents.
- Never revert user changes unless explicitly asked.
- Keep diffs scoped to the requested behavior.
- Prefer `apply_patch` for manual edits.
- Keep maintainer-facing implementation guidance in this file rather than in
  user-facing README sections.

# Graphlit Agent Harness Lab

Visual Next.js sample for comparing how agent harnesses answer the same prompt when they share the same Graphlit context layer and [Graphlit agent tools](https://github.com/graphlit/graphlit-agent-tools).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgraphlit%2Fagent-harness-lab&project-name=agent-harness-lab&repository-name=agent-harness-lab&env=GRAPHLIT_ORGANIZATION_ID,GRAPHLIT_ENVIRONMENT_ID,GRAPHLIT_JWT_SECRET,OPENAI_API_KEY,ANTHROPIC_API_KEY,GEMINI_API_KEY&envDescription=Graphlit%20project%20credentials%20and%20model%20provider%20API%20keys.%20Configure%20at%20least%20one%20provider%20key.&envLink=https%3A%2F%2Fwww.graphlit.dev)

The app runs selected lanes in parallel:

- Graphlit
- OpenAI Agents SDK
- Vercel AI SDK
- LangGraph
- Mastra
- Claude Agent SDK
- Google ADK

Graphlit is the always-on baseline lane and shared context layer. The other lanes can be toggled from the composer. Each send creates one turn for every enabled lane, and each lane keeps its own session state so you can compare multi-turn behavior over time.

## What You Can Compare

- How each harness streams answer text and tool events.
- Which tools each lane calls, including search provider labels for `web_search`.
- Sources, tool call arguments/results, raw lane events, timings, and token usage.
- Provider/model choices across OpenAI, Anthropic, and Google where the harness supports them.
- Provider defaults versus the lab's optimized, harness-neutral system prompt.
- LLM-as-judge scoring when at least two lanes finish successfully.

## Graphlit Agent Tools

All lanes receive the same read-only Graphlit-backed tool surface:

- `analyze_prompt` - required first call for per-turn routing and evidence planning.
- `retrieve_contents`
- `inspect_content` - inspect retrieved Graphlit content by `id` or
  `contents://...` `resourceUri`.
- `inspect_page` - inspect a public web page URL as Markdown without ingesting
  it into Graphlit.
- `count_contents`
- `list_resources`
- `read_resource`
- `web_search`
- `web_map`

The composer can ingest files or URLs as shared setup context before a run.
Agent lanes cannot ingest, delete, enrich, or mutate project content during
comparison.

The optimized system prompt is enabled by default. It asks every harness to call `analyze_prompt` first, then follow the returned routing plan for retrieval, web search, inspection, and synthesis. You can turn the optimized prompt off in the UI to compare provider/harness defaults.

## Shared Project Context

The file and URL buttons in the composer are setup controls for the connected
Graphlit project, not abilities granted to a single lane:

- File upload sends the selected file to the app server, then calls Graphlit file
  ingestion for the active project.
- URL ingest sends the URL to the app server, then calls Graphlit URI ingestion
  for the active project.
- The app waits for Graphlit processing before treating the new content as
  retrieval-ready.
- Once ready, the content is shared context for every enabled lane in the next
  comparison run.

That means the comparison stays fair: every lane sees the same project context
and the same read-only Graphlit agent tools. During a benchmark turn, lanes can
retrieve, inspect content, inspect public pages, count, list, read, search, and
map through those tools, but they cannot add, delete, enrich, or mutate project
content.

Uploaded files and ingested URLs are persisted in the configured Graphlit
project until you manage or delete them in Graphlit. Resetting the lab clears the
local comparison transcript and lane sessions; it does not delete project
content from Graphlit. Use [Graphlit Studio](https://www.graphlit.dev/home) to
review or manage project content outside the lab.

## Setup

Use Node.js 20.9.0 or newer.

Create a Graphlit project before running the app:

1. Sign up or sign in at [graphlit.dev](https://www.graphlit.dev).
2. Create or open a Graphlit project.
3. Open the project environment panel from the sidebar.
4. Copy the environment variables for the environment you want to use.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Required Graphlit project credentials:

```bash
GRAPHLIT_ORGANIZATION_ID=
GRAPHLIT_ENVIRONMENT_ID=
GRAPHLIT_JWT_SECRET=
```

Configure at least one model provider key. Provider keys stay server-side.

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

Optional defaults:

```bash
NEXT_PUBLIC_DEFAULT_LANES=graphlit,openai,vercel,langgraph,mastra,claude,google
AGENT_HARNESS_LAB_REASONING_EFFORT=medium
AGENT_HARNESS_LAB_MODEL_PROVIDER=openai
AGENT_HARNESS_LAB_MODEL_SIZE=large
AGENT_HARNESS_LAB_GRAPHLIT_TIMEOUT_MS=900000
```

If `NEXT_PUBLIC_DEFAULT_LANES` is unset, all lanes that have the required credentials are enabled by default. Graphlit remains the baseline lane when Graphlit credentials and at least one provider key are available.

## Deploy To Vercel

Use the deploy button above to clone this repo into your Vercel account. Vercel will prompt for Graphlit variables and model provider API key fields before the first deployment. Configure at least one provider key to run the app.

## How It Works

On first load, the app verifies your Graphlit project and bootstraps the model specifications used by the Graphlit baseline and judge.

The flow:

1. Send the same prompt to every enabled lane.
2. Each lane runs independently with the same Graphlit agent tools.
3. Each lane streams its own events, answer text, tool calls, sources, timings, and token usage.
4. Lane failures stay isolated, so one provider cannot block the others.
5. If at least two lanes finish successfully and judging is enabled, the judge compares the completed results.
6. Lane session state carries forward to the next prompt until you reset.

Use reset to clear the prompt, lane transcripts, session state, and judge output. The next send starts a fresh comparison.

## Runtime Notes

Graphlit, Vercel AI SDK, LangGraph, and Mastra use the selected provider preference when the matching API key is available. OpenAI Agents SDK, Claude Agent SDK, and Google ADK use their native provider keys.

- `OPENAI_API_KEY`: enables OpenAI models and the OpenAI Agents SDK lane.
- `ANTHROPIC_API_KEY`: enables Anthropic models and the Claude Agent SDK lane.
- `GEMINI_API_KEY`: enables Google Gemini models and the Google ADK lane.

The app uses 15-minute lane and judge timeouts for long-running research prompts. `AGENT_HARNESS_LAB_GRAPHLIT_TIMEOUT_MS` can override the timeout used for Graphlit bootstrap/API operations.

The judge only compares successful lane runs. If fewer than two lanes complete successfully, judging is skipped.

## Contributing

Pull requests are welcome for additional model providers and agent harness lanes. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution checklist.

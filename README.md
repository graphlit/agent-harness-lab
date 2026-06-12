# Graphlit Agent Harness Lab

Visual Next.js sample for comparing how agent harnesses use the same Graphlit tools across a continuous agent conversation.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgraphlit%2Fagent-harness-lab&project-name=agent-harness-lab&repository-name=agent-harness-lab&env=GRAPHLIT_ORGANIZATION_ID,GRAPHLIT_ENVIRONMENT_ID,GRAPHLIT_JWT_SECRET,OPENAI_API_KEY,ANTHROPIC_API_KEY,GEMINI_API_KEY&envDescription=Graphlit%20project%20credentials%20and%20model%20provider%20API%20keys.%20Configure%20at%20least%20one%20provider%20key.&envLink=https%3A%2F%2Fwww.graphlit.dev)

The app runs enabled lanes in parallel:

- Graphlit
- OpenAI Agents SDK
- Vercel AI SDK
- LangGraph
- Mastra
- Claude Agent SDK
- Google ADK

Graphlit is always enabled as the baseline. OpenAI, Vercel, LangGraph, Mastra, Claude, Google, and Judge can be toggled in the composer. Every send creates a new turn for the enabled lanes, and each lane keeps its own session state so you can compare how the agent conversations evolve over multiple prompts. Graphlit, Vercel AI SDK, LangGraph, and Mastra can use the selected model provider preference: OpenAI, Anthropic, or Google.

All lanes receive the same Graphlit tools: `retrieve_contents`, `inspect_content`, `web_search`, `ingest_url`, and `wait_content_done`.

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

Model provider API keys:

Configure at least one provider key. These are the normal API keys required to call each model provider directly; the app keeps them server-side and uses them for any harness that runs against that provider.

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

Optional:

```bash
NEXT_PUBLIC_DEFAULT_LANES=graphlit,openai,vercel,langgraph,mastra,claude,google
AGENT_HARNESS_LAB_REASONING_EFFORT=medium
AGENT_HARNESS_LAB_MODEL_PROVIDER=openai
AGENT_HARNESS_LAB_MODEL_SIZE=large
```

## Deploy To Vercel

Use the deploy button above to clone this repo into your Vercel account. Vercel will prompt for Graphlit variables and model provider API key fields before the first deployment. Configure at least one provider key to run the app.

## How It Works

On first load, the app verifies your Graphlit project and prepares the model settings used by the Graphlit and judge lanes.

The flow:

1. Sends the same prompt to every selected lane at the same time.
2. Lets each lane use the same Graphlit retrieval and web tools.
3. Shows answers, tool calls, sources, and raw events inline.
4. Keeps lane failures isolated so one provider cannot block the others.
5. Runs the judge after at least two lanes finish successfully.
6. Carries lane session state forward for the next prompt.

Use reset to clear the prompt, lane transcripts, and session state. The next send starts a fresh comparison.

## Contributing

Pull requests are welcome for additional model providers and agent harness lanes. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution checklist.

## Runtime Notes

Provider API keys are only used on the server. Missing provider keys disable the matching provider choice in the UI. Graphlit, Vercel AI SDK, LangGraph, and Mastra use the selected provider preference, so they require the key for that selected provider. OpenAI Agents SDK, Claude Agent SDK, and Google ADK always use their native provider key.

- `OPENAI_API_KEY`: enables OpenAI models
- `ANTHROPIC_API_KEY`: enables Anthropic Claude models
- `GEMINI_API_KEY`: enables Google Gemini models

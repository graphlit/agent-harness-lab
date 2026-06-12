# Graphlit Agent Harness Lab

Visual Next.js sample for comparing how agent harnesses use the same Graphlit tools against one prompt.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgraphlit%2Fagent-harness-lab&project-name=agent-harness-lab&repository-name=agent-harness-lab&env=GRAPHLIT_ORGANIZATION_ID,GRAPHLIT_ENVIRONMENT_ID,GRAPHLIT_JWT_SECRET,OPENAI_API_KEY,ANTHROPIC_API_KEY,GEMINI_API_KEY&envDescription=Graphlit%20project%20credentials%20and%20provider%20API%20keys%20used%20by%20the%20comparison%20lanes.)

The app runs enabled lanes in parallel:

- Graphlit
- OpenAI Agents
- Mastra
- Claude Agent SDK
- Google ADK

Graphlit is always enabled as the baseline. OpenAI, Mastra, Claude, Google, and Judge can be toggled in the composer. All lanes receive the same Graphlit tools: `retrieve_contents`, `inspect_content`, `web_search`, `ingest_url`, and `wait_content_done`.

## Setup

Use Node.js 20.9.0 or newer.

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

Lane credentials:

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

Optional:

```bash
NEXT_PUBLIC_DEFAULT_LANES=graphlit,openai,mastra,claude,google
AGENT_HARNESS_LAB_REASONING_EFFORT=medium
AGENT_HARNESS_LAB_MODEL_SIZE=large
```

## Deploy To Vercel

Use the deploy button above to clone this repo into your Vercel account. Vercel will prompt for the required Graphlit and provider environment variables before the first deployment.

## Bootstrap

`POST /api/bootstrap` verifies the Graphlit project and upserts the required model specifications when the local bootstrap version changes.

It creates:

- `Graphlit Agent Harness Lab - Graphlit - Large - Low`
- `Graphlit Agent Harness Lab - Graphlit - Large - Medium`
- `Graphlit Agent Harness Lab - Graphlit - Large - High`
- `Graphlit Agent Harness Lab - Graphlit - Small - Low`
- `Graphlit Agent Harness Lab - Graphlit - Small - Medium`
- `Graphlit Agent Harness Lab - Graphlit - Small - High`
- `Graphlit Agent Harness Lab - Judge`

Bootstrap state is stored under the OS temp directory by default to avoid slow WSL reads from the Windows-mounted project tree. Set `AGENT_HARNESS_LAB_STATE_DIR` to override it. The lane routes select the already-bootstrapped Graphlit spec matching the visible reasoning effort and model size controls.

## Run Flow

Each selected swimlane is started with its own NDJSON stream:

- `POST /api/lanes/graphlit`
- `POST /api/lanes/openai`
- `POST /api/lanes/mastra`
- `POST /api/lanes/claude`
- `POST /api/lanes/google`

The browser starts the selected lane streams in parallel, then calls `POST /api/judge` after at least two lanes complete.

The flow:

1. Starts every selected lane independently so one provider cannot block another lane.
2. Records each Graphlit tool call with normalized `tool_call_*` events.
3. Keeps lane failures isolated.
4. Runs the judge after lane completion when at least two lanes finish successfully.
5. Keeps transcripts in browser state only.

The judge uses Graphlit `extractText()` with an Extraction specification and a structured `score_agent_harness_run` tool definition.

## Runtime Notes

Provider API keys are only used on the server. Missing provider keys disable the matching optional lane:

- `OPENAI_API_KEY`: OpenAI Agents SDK and Mastra lanes
- `ANTHROPIC_API_KEY`: Claude lane
- `GEMINI_API_KEY`: Google ADK lane

The Google lane uses Google's TypeScript Agent Development Kit (`@google/adk`) with Gemini model aliases. Google's current ADK TypeScript quickstart recommends Node.js 24.13.0+ and npm 11.8.0+.

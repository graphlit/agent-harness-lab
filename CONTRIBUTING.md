# Contributing

Thanks for helping improve Graphlit Agent Harness Lab. Pull requests are welcome for additional model providers, agent harness providers, UI polish, bug fixes, and documentation improvements.

## Before Opening A Pull Request

- Keep comparisons fair: every lane should receive the same prompt and equivalent Graphlit tool access.
- Keep credentials server-side. Do not expose provider API keys to the browser.
- Keep lanes isolated. A provider failure should not block the rest of the run.
- Update docs when adding environment variables, setup steps, model providers, or lanes.
- Run the relevant local checks before submitting.

```bash
npm run check-types
```

## Adding A Lane

A lane is an agent harness provider that runs beside the existing Graphlit baseline.

Good lane additions should:

- Use the same read-only Graphlit tools as the other lanes: `retrieve_contents`, `inspect_content`, `count_contents`, `list_resources`, `read_resource`, `web_search`, and `web_map`.
- Run the same user prompt without adding provider-specific shortcuts that give the lane extra context.
- Stream or record comparable events so the UI can show answers, tool calls, sources, errors, and raw events consistently.
- Preserve lane-specific session state across turns when the provider supports conversation state.
- Fail independently with a clear error message when credentials, provider SDKs, or runtime calls fail.
- Add any new runtime configuration to `.env.example` and the README.

## Adding A Model Provider

Good model-provider additions should:

- Wire into the shared model provider preference controls when the provider can power provider-neutral lanes.
- Document the required server-side API key and any provider-specific setup.
- Avoid hard-coding provider behavior into Graphlit tool calls.
- Keep model labels and model IDs centralized with the existing provider constants.
- Make default choices conservative and easy to override.

## Pull Request Notes

In the PR description, include:

- What lane, model provider, or behavior changed.
- Which environment variables are required.
- Which checks you ran.
- Any known provider limitations, rate limits, or SDK maturity notes.

const serverExternalPackages = [
  "@ai-sdk/openai",
  "@anthropic-ai/claude-agent-sdk",
  "@google/adk",
  "@graphlit/agent-tools",
  "@libsql/client",
  "@mastra/core",
  "@mastra/libsql",
  "@mastra/memory",
  "@openai/agents",
  "@openai/agents-core",
  "@openai/agents-openai",
  "@openai/agents-realtime",
  "graphlit-client",
  "openai",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages,
};

export default nextConfig;

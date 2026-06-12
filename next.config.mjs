const serverExternalPackages = [
  "ai",
  "@ai-sdk/openai",
  "@anthropic-ai/claude-agent-sdk",
  "@google/adk",
  "@graphlit/agent-tools",
  "@langchain/core",
  "@langchain/langgraph",
  "@langchain/langgraph-checkpoint",
  "@langchain/openai",
  "@libsql/client",
  "@mastra/core",
  "@mastra/libsql",
  "@mastra/memory",
  "@openai/agents",
  "@openai/agents-core",
  "@openai/agents-openai",
  "@openai/agents-realtime",
  "graphlit-client",
  "langchain",
  "openai",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages,
};

export default nextConfig;

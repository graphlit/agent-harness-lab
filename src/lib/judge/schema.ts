import { z } from "zod";

const NullableJudgeLaneIdSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().nullable(),
);

export const JudgeLaneScoreSchema = z.object({
  anonymousId: z.string(),
  overallScore: z.number().int().min(0).max(10),
  retrievalUse: z.number().int().min(0).max(10),
  sourceInspection: z.number().int().min(0).max(10),
  groundedness: z.number().int().min(0).max(10),
  answerHelpfulness: z.number().int().min(0).max(10),
  unsupportedClaimRisk: z.number().int().min(0).max(10),
  traceEvidence: z.array(z.string()).default([]),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
});

export const JudgeResultSchema = z.object({
  winnerAnonymousId: NullableJudgeLaneIdSchema,
  winnerReason: z.string(),
  summary: z.string(),
  lanes: z.array(JudgeLaneScoreSchema),
  pairwiseNotes: z
    .array(
      z.object({
        betterAnonymousId: NullableJudgeLaneIdSchema,
        worseAnonymousId: NullableJudgeLaneIdSchema,
        reason: z.string(),
      }),
    )
    .default([]),
  biasChecks: z.object({
    laneOrderRandomized: z.boolean(),
    verbosityConsidered: z.boolean(),
    unsupportedClaimsConsidered: z.boolean(),
    externalKnowledgeAvoided: z.boolean(),
    individualScoringBeforePairwise: z.boolean(),
    providerSnippetNeutrality: z.boolean(),
    optionalDetailNotOverweighted: z.boolean(),
  }),
});

export type ParsedJudgeResult = z.infer<typeof JudgeResultSchema>;

export const scoreAgentHarnessRunJsonSchema = {
  type: "object",
  properties: {
    winnerAnonymousId: {
      type: "string",
      description:
        "Anonymous lane ID of the best response. Use an empty string when there is no winner.",
    },
    winnerReason: {
      type: "string",
      description:
        "Human-readable reason for the winner. Use friendly lane names from laneNameMap, never anonymous labels like Lane A or Lane B.",
    },
    summary: {
      type: "string",
      description:
        "Human-readable summary. Use friendly lane names from laneNameMap, never anonymous labels like Lane A or Lane B.",
    },
    lanes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          anonymousId: { type: "string" },
          overallScore: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "Holistic response quality score derived from the same dimensions. Higher is better.",
          },
          retrievalUse: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description: "How well the lane retrieved relevant evidence.",
          },
          sourceInspection: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "How well the lane inspected or used source details after retrieval.",
          },
          groundedness: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "How well the answer is supported by the available traces and sources.",
          },
          answerHelpfulness: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "Completeness, directness, clarity, and usefulness of the final answer. Higher is better.",
          },
          unsupportedClaimRisk: {
            type: "integer",
            minimum: 0,
            maximum: 10,
            description:
              "Risk that the answer contains unsupported or overconfident claims. Lower is better.",
          },
          traceEvidence: {
            type: "array",
            items: { type: "string" },
            description:
              "Evidence notes for this lane. Use the friendly lane name, never anonymous labels like Lane A or Lane B.",
          },
          strengths: {
            type: "array",
            items: { type: "string" },
            description:
              "Strength notes for this lane. Use the friendly lane name, never anonymous labels like Lane A or Lane B.",
          },
          weaknesses: {
            type: "array",
            items: { type: "string" },
            description:
              "Weakness notes for this lane. Use the friendly lane name, never anonymous labels like Lane A or Lane B.",
          },
        },
        required: [
          "anonymousId",
          "overallScore",
          "retrievalUse",
          "sourceInspection",
          "groundedness",
          "answerHelpfulness",
          "unsupportedClaimRisk",
          "traceEvidence",
          "strengths",
          "weaknesses",
        ],
      },
    },
    pairwiseNotes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          betterAnonymousId: {
            type: "string",
            description:
              "Anonymous lane ID of the better response. Use an empty string when there is no better lane.",
          },
          worseAnonymousId: {
            type: "string",
            description:
              "Anonymous lane ID of the worse response. Use an empty string when there is no worse lane.",
          },
          reason: {
            type: "string",
            description:
              "Human-readable comparison reason. Use friendly lane names from laneNameMap, never anonymous labels like Lane A or Lane B.",
          },
        },
        required: ["betterAnonymousId", "worseAnonymousId", "reason"],
      },
    },
    biasChecks: {
      type: "object",
      properties: {
        laneOrderRandomized: { type: "boolean" },
        verbosityConsidered: { type: "boolean" },
        unsupportedClaimsConsidered: { type: "boolean" },
        externalKnowledgeAvoided: {
          type: "boolean",
          description:
            "True when the judge avoided using training data, model memory, or outside facts as factual ground truth and relied only on provided traces and sources.",
        },
        individualScoringBeforePairwise: {
          type: "boolean",
          description:
            "True when the judge scored each lane independently against that lane's own evidence before making winner or pairwise comparisons.",
        },
        providerSnippetNeutrality: {
          type: "boolean",
          description:
            "True when the judge did not reward or penalize lanes based on raw search snippet length, provider result verbosity, or whether a search provider returned rich snippets.",
        },
        optionalDetailNotOverweighted: {
          type: "boolean",
          description:
            "True when the judge did not turn optional supported details into hidden mandatory scoring criteria beyond the user's prompt.",
        },
      },
      required: [
        "laneOrderRandomized",
        "verbosityConsidered",
        "unsupportedClaimsConsidered",
        "externalKnowledgeAvoided",
        "individualScoringBeforePairwise",
        "providerSnippetNeutrality",
        "optionalDetailNotOverweighted",
      ],
    },
  },
  required: [
    "winnerAnonymousId",
    "winnerReason",
    "summary",
    "lanes",
    "pairwiseNotes",
    "biasChecks",
  ],
} as const;

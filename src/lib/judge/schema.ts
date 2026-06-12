import { z } from "zod";

const NullableJudgeLaneIdSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().nullable(),
);

export const JudgeLaneScoreSchema = z.object({
  anonymousId: z.string(),
  overallScore: z.number().int().min(0).max(5),
  retrievalUse: z.number().int().min(0).max(5),
  sourceInspection: z.number().int().min(0).max(5),
  groundedness: z.number().int().min(0).max(5),
  answerHelpfulness: z.number().int().min(0).max(5),
  unsupportedClaimRisk: z.number().int().min(0).max(5),
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
    winnerReason: { type: "string" },
    summary: { type: "string" },
    lanes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          anonymousId: { type: "string" },
          overallScore: { type: "integer", minimum: 0, maximum: 5 },
          retrievalUse: { type: "integer", minimum: 0, maximum: 5 },
          sourceInspection: { type: "integer", minimum: 0, maximum: 5 },
          groundedness: { type: "integer", minimum: 0, maximum: 5 },
          answerHelpfulness: { type: "integer", minimum: 0, maximum: 5 },
          unsupportedClaimRisk: { type: "integer", minimum: 0, maximum: 5 },
          traceEvidence: { type: "array", items: { type: "string" } },
          strengths: { type: "array", items: { type: "string" } },
          weaknesses: { type: "array", items: { type: "string" } },
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
          reason: { type: "string" },
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
      },
      required: [
        "laneOrderRandomized",
        "verbosityConsidered",
        "unsupportedClaimsConsidered",
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

import { z } from "zod";

export const AnalysisOutputSchema = z.object({
  outcome: z.enum(["ready", "question", "duplicate"]),
  ticket: z.object({
    title: z.string(), desiredChange: z.string(), openPoints: z.array(z.string()), implementationIdeas: z.array(z.string()),
  }).strict(),
  findings: z.array(z.object({
    repository: z.string(), path: z.string(), lineStart: z.number().nullable(), lineEnd: z.number().nullable(), note: z.string(),
  }).strict()),
  questions: z.array(z.string()),
  duplicates: z.array(z.object({ cardPublicId: z.string(), reason: z.string() }).strict()),
  mergeWith: z.array(z.object({ commentId: z.string(), reason: z.string() }).strict()),
}).strict().superRefine((value, ctx) => {
  if ((value.outcome === "question") !== (value.questions.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["questions"], message: "Rückfragen sind genau beim Ergebnis question erforderlich." });
  }
  if ((value.outcome === "duplicate") !== (value.duplicates.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["duplicates"], message: "Duplikate sind genau beim Ergebnis duplicate erforderlich." });
  }
});

export const analysisOutputJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["outcome", "ticket", "findings", "questions", "duplicates", "mergeWith"],
  properties: {
    outcome: { type: "string", enum: ["ready", "question", "duplicate"] },
    ticket: {
      type: "object", additionalProperties: false,
      required: ["title", "desiredChange", "openPoints", "implementationIdeas"],
      properties: {
        title: { type: "string" }, desiredChange: { type: "string" },
        openPoints: { type: "array", items: { type: "string" } },
        implementationIdeas: { type: "array", items: { type: "string" } },
      },
    },
    findings: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["repository", "path", "lineStart", "lineEnd", "note"],
      properties: { repository: { type: "string" }, path: { type: "string" },
        lineStart: { type: ["number", "null"] }, lineEnd: { type: ["number", "null"] }, note: { type: "string" } },
    } },
    questions: { type: "array", items: { type: "string" } },
    duplicates: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["cardPublicId", "reason"],
      properties: { cardPublicId: { type: "string" }, reason: { type: "string" } },
    } },
    mergeWith: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["commentId", "reason"],
      properties: { commentId: { type: "string" }, reason: { type: "string" } },
    } },
  },
};

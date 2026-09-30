import { z } from "zod";

/** One explicit address rule. Port omitted = default port of the scheme. */
export const UrlRuleSchema = z.object({
  scheme: z.enum(["http", "https"]),
  hostname: z.string().min(1).transform((h) => h.toLowerCase()),
  port: z.number().int().min(1).max(65535).optional(),
  pathPrefix: z.string().startsWith("/").default("/"),
});
export type UrlRule = z.infer<typeof UrlRuleSchema>;

export const KanTargetSchema = z.object({
  provider: z.literal("kan"),
  baseUrl: z.string().url(),
  workspacePublicId: z.string().min(1),
  boardPublicId: z.string().min(1),
  listPublicId: z.string().min(1),
});
export type KanTarget = z.infer<typeof KanTargetSchema>;

const AliasSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "Alias darf nur Buchstaben, Ziffern, . _ - enthalten");

/**
 * Shareable project config (export/import format, schemaVersion 1).
 * Must never contain tokens, local paths, drafts or screenshots.
 * `.strict()` rejects unknown keys so a hand-edited file cannot smuggle local data in.
 */
export const ProjectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "projectId: Kleinbuchstaben, Ziffern, Bindestrich"),
    name: z.string().min(1),
    urlRules: z.array(UrlRuleSchema).min(1),
    target: KanTargetSchema,
    repositoryAliases: z.array(AliasSchema).min(1),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function parseProjectConfig(input: unknown): ProjectConfig {
  return ProjectConfigSchema.parse(input);
}

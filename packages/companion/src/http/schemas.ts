import { z } from "zod";

const coordinate = z.number().finite();
const positive = z.number().finite().positive();
const size = positive.int();
const point = z.object({ x: coordinate, y: coordinate }).strict();
const rect = z.object({ x: coordinate, y: coordinate, width: positive, height: positive }).strict();

export const ContextSchema = z.object({
  url: z.string().url(), pageTitle: z.string(),
  viewport: z.object({ width: positive, height: positive, devicePixelRatio: positive }).strict(),
  scroll: point,
  elementText: z.string().max(500).optional(), elementDescription: z.string().optional(), extraContext: z.string().optional(),
}).strict();

export const ScreenshotSchema = z.object({
  width: size, height: size, originalWidth: size, originalHeight: size,
  crop: rect, marker: point.optional(), elementBox: rect.optional(),
}).strict().superRefine((s, context) => {
  if (s.crop.x < 0 || s.crop.y < 0 || s.crop.x + s.crop.width > s.originalWidth || s.crop.y + s.crop.height > s.originalHeight ||
      s.crop.width !== s.width || s.crop.height !== s.height) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Ungültiger Bildausschnitt" });
  }
  if (s.marker && (s.marker.x < 0 || s.marker.y < 0 || s.marker.x >= s.width || s.marker.y >= s.height)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Markierung liegt außerhalb des Ausschnitts" });
  }
});
const text = z.string().refine((value) => value.trim().length > 0, "Kommentartext fehlt");

export const CreateCommentSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  text, markKind: z.enum(["element", "point", "page"]), context: ContextSchema,
  screenshot: ScreenshotSchema.optional(), imagePngBase64: z.string().min(1).optional(),
}).strict().refine((c) => !!c.screenshot === !!c.imagePngBase64, "Screenshot und PNG müssen gemeinsam angegeben werden");
export const UpdateCommentSchema = z.object({
  baseRevision: z.number().int().positive(), text: text.optional(),
  context: z.object({ extraContext: z.string().optional() }).strict().optional(),
  screenshot: ScreenshotSchema.optional(), imagePngBase64: z.string().min(1).optional(),
}).strict();
export const PairSchema = z.object({ code: z.string().regex(/^[A-Z2-9]{8}$/) }).strict();
export const ImportSchema = z.object({ config: z.unknown(), replaceExisting: z.boolean().optional() }).strict();
export const SetCheckoutsSchema = z.object({ checkouts: z.record(z.string().min(1)) }).strict();
export const MatchSchema = z.object({ url: z.string().url() }).strict();
export const CredentialSchema = z.object({ baseUrl: z.string().url(), apiToken: z.string().min(1) }).strict();
export const ReviewSchema = z.object({ projectId: z.string().min(1), title: z.string().min(1).optional() }).strict();
export const AnswerSchema = z.object({ questionId: z.string().min(1), answer: z.string().min(1) }).strict();
export const DecisionSchema = z.union([
  z.object({ kind: z.literal("duplicate"), action: z.literal("append"), cardPublicId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("duplicate"), action: z.literal("create_new") }).strict(),
  z.object({ kind: z.literal("merge"), proposalId: z.string().min(1), action: z.enum(["accept", "reject"]) }).strict(),
]);
export const ReconcileSchema = z.union([
  z.object({ action: z.literal("recheck") }).strict(),
  z.object({ action: z.literal("confirm_exists"), cardPublicId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("confirm_absent") }).strict(),
]);

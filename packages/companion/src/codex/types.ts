/**
 * Seam between the processing orchestrator and Codex (codex app-server over stdio).
 * Implemented in `codex/` (appServerClient.ts, analysisRunner.ts). See docs/architecture.md "Codex integration".
 */
import type { CaptureContext, CheckoutSnapshot, MarkKind, OpenQuestion } from "@website-review/shared";
import type { z } from "zod";
import type { AnalysisOutputSchema } from "./analysisSchema.ts";

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

export interface AnalysisCommentInput {
  commentId: string;
  revision: number;
  text: string;
  markKind: MarkKind;
  context: CaptureContext;
  /** Absolute path of the approved PNG, passed to Codex as localImage. */
  imagePath?: string;
  /** Previously asked questions with the user's answers (re-analysis after an answer). */
  questions: OpenQuestion[];
}

export interface AnalysisInput {
  review: { id: string; projectName: string; codexThreadId?: string };
  checkouts: (CheckoutSnapshot & { path: string })[];
  /** One comment normally; several for an accepted merge group (produce ONE combined ticket, no mergeWith). */
  comments: AnalysisCommentInput[];
  /** Other comments of the review (id + text) so Codex can propose merges. Empty for merge-group turns. */
  otherComments: { commentId: string; text: string; url: string }[];
  /** Env for the review MCP gateway process launched by Codex. */
  gateway: { command: string; args: string[]; env: Record<string, string> };
  signal?: AbortSignal;
}

export type AnalysisResult =
  | { ok: true; threadId: string; output: AnalysisOutput }
  | { ok: false; threadId?: string; error: string; retryable: boolean };

export interface AnalysisRunner {
  /** Runs one analysis turn. Never throws for Codex/validation problems; returns ok:false instead. */
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
  /** `codex --version` style probe for preflight/status. */
  probe(): Promise<{ available: boolean; version?: string; problem?: string }>;
  close(): Promise<void>;
}

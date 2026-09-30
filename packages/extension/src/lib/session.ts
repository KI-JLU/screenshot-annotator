/**
 * Per-browser-session memory in chrome.storage.session:
 * - chosen project + open review per tab origin (and the open review per project, so a review
 *   follows the user across pages of the same project),
 * - the unsaved comment draft of the capture preview.
 * Everything persistent lives in the companion.
 */
import type { Rect } from "@website-review/shared";
import { SESSION_CAPTURE_KEY, type CaptureResult } from "./messages.ts";

export interface OriginMemory {
  projectId?: string;
  reviewId?: string;
}

const originKey = (origin: string) => `wr:origin:${origin}`;
const projectKey = (projectId: string) => `wr:project-review:${projectId}`;
const DRAFT_KEY = "wr:draft";

async function get<T>(key: string): Promise<T | undefined> {
  return (await chrome.storage.session.get(key))[key] as T | undefined;
}

export function getOriginMemory(origin: string): Promise<OriginMemory | undefined> {
  return get<OriginMemory>(originKey(origin));
}

export async function setOriginMemory(origin: string, memory: OriginMemory): Promise<void> {
  await chrome.storage.session.set({ [originKey(origin)]: memory });
}

export function getProjectReview(projectId: string): Promise<string | undefined> {
  return get<string>(projectKey(projectId));
}

export async function setProjectReview(projectId: string, reviewId: string | undefined): Promise<void> {
  if (reviewId) await chrome.storage.session.set({ [projectKey(projectId)]: reviewId });
  else await chrome.storage.session.remove(projectKey(projectId));
}

/** Removes every memory entry pointing at a deleted review. */
export async function forgetReview(reviewId: string): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const updates: Record<string, unknown> = {};
  const removals: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("wr:project-review:") && value === reviewId) removals.push(key);
    if (key.startsWith("wr:origin:") && (value as OriginMemory | undefined)?.reviewId === reviewId) {
      updates[key] = { projectId: (value as OriginMemory).projectId };
    }
  }
  if (removals.length) await chrome.storage.session.remove(removals);
  if (Object.keys(updates).length) await chrome.storage.session.set(updates);
}

// ---------- Draft of the comment being captured ----------

export interface CommentDraft {
  /** Review the comment will be added to (the one open when capturing started). */
  reviewId: string;
  projectId: string;
  text: string;
  extraContext: string;
  /** Crop in original image px; undefined = full image. */
  crop?: Rect;
  /** Page comments may be saved without screenshot. */
  attachScreenshot: boolean;
  /** Capture id the crop belongs to. */
  captureId?: string;
}

export function loadDraft(): Promise<CommentDraft | undefined> {
  return get<CommentDraft>(DRAFT_KEY);
}

export async function saveDraft(draft: CommentDraft): Promise<void> {
  await chrome.storage.session.set({ [DRAFT_KEY]: draft });
}

export async function clearDraft(): Promise<void> {
  await chrome.storage.session.remove([DRAFT_KEY, SESSION_CAPTURE_KEY]);
}

export function loadCapture(): Promise<CaptureResult | undefined> {
  return get<CaptureResult>(SESSION_CAPTURE_KEY);
}

export async function clearCapture(): Promise<void> {
  await chrome.storage.session.remove(SESSION_CAPTURE_KEY);
}

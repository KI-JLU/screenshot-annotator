import type { PublicationOp } from "@website-review/shared";
import type { KanClient } from "../kan/types.ts";

export const attachmentFilename = (commentId: string, revision: number): string => `review-${commentId}-r${revision}.png`;
export interface ReconciledWrite { cardPublicId: string; externalId?: string }

/** Absence from a read is never proof that a write did not happen. */
export async function findWrite(client: KanClient, boardId: string, op: PublicationOp, filename?: string): Promise<ReconciledWrite | undefined> {
  const contains = (text: string | null) => text?.split(/\r?\n/).some((line) => line.trim() === `Review-Referenz: ${op.reference}`);
  if (op.kind === "create_card") {
    const board = await client.getBoard(boardId);
    const matches = board.lists.flatMap((list) => list.cards).filter((card) => contains(card.description));
    return matches.length === 1 ? { cardPublicId: matches[0]!.publicId } : undefined;
  }
  if (!op.cardPublicId) return undefined;
  const card = await client.getCard(op.cardPublicId);
  const match = op.kind === "add_comment"
    ? card.comments.find((comment) => contains(comment.comment))
    : card.attachments.find((attachment) => attachment.filename === filename || attachment.originalFilename === filename);
  return match ? { cardPublicId: card.publicId, externalId: match.publicId } : undefined;
}

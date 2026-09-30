import type { ComponentChildren } from "preact";
import type { CommentState } from "@website-review/shared";
import { COMMENT_STATE_LABELS } from "@website-review/shared";
import { stateTone } from "../../lib/format.ts";

export function StateBadge({ state }: { state: CommentState }) {
  return <span class={`badge tone-${stateTone(state)}`}>{COMMENT_STATE_LABELS[state]}</span>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p class="alert" role="alert">
      {error}
    </p>
  );
}

export function Notice({ children, tone = "info" }: { children: ComponentChildren; tone?: "info" | "warn" }) {
  return <div class={`notice ${tone}`}>{children}</div>;
}

export function Field({
  label,
  id,
  hint,
  children,
}: {
  label: string;
  id: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children}
      {hint && (
        <p class="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

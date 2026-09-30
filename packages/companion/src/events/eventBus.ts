import type { CompanionEvent } from "@website-review/shared";

export class EventBus {
  private readonly listeners = new Set<(event: CompanionEvent) => void>();
  emit(event: CompanionEvent): void {
    for (const listener of this.listeners) {
      // A disconnected subscriber must never turn a committed write into an error.
      try { listener(event); } catch { /* subscriber owns its connection */ }
    }
  }
  subscribe(listener: (event: CompanionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

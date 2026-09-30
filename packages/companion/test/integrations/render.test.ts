import { describe, expect, it } from "vitest";
import { renderAppendComment, renderCardDescription, renderCardTitle, type RenderCardInput } from "../../src/ticket/render.ts";

function input(): RenderCardInput {
  return {
    comments: [{ text: "Hier mehr Luft.", markKind: "element", context: {
      url: "https://staging.test/seite", pageTitle: "Seite", viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
      scroll: { x: 0, y: 10 }, elementText: "Filter", extraContext: "Ergebnisliste",
    } }],
    analysis: {
      ticket: { title: "Filterbereich mit mehr Abstand", desiredChange: "Abstand zwischen Filterbereich und Ergebnisliste vergrößern.", openPoints: ["Ein genauer Zielabstand wurde nicht festgelegt."], implementationIdeas: ["Abstände der Komponente prüfen."] },
      findings: [{ repository: "frontend", path: "src/Filter.tsx", lineStart: 10, lineEnd: 20, note: "Filterbereich" }],
      checkouts: [{ alias: "frontend", headCommit: "abcdef123456789", branch: "main", hasUncommittedChanges: true }],
    },
    reference: "wr-123",
  };
}
describe("German ticket rendering", () => {
  it("renders the architecture template, original comment, evidence, context and staging caveat", () => {
    const body = renderCardDescription(input());
    for (const line of [
      "Abstand zwischen Filterbereich und Ergebnisliste vergrößern.", "**Originalkommentar:** „Hier mehr Luft.“",
      "### Kontext", "- Seite: https://staging.test/seite", "- Fenstergröße: 1200×800 (DPR 2)", "- Markierung: Element „Filter“", "- Zusätzlicher Kontext: Ergebnisliste",
      "### Code-Fundstellen (lokal untersucht)", "- `frontend`: `src/Filter.tsx:10-20` – Filterbereich",
      "_Lokal untersuchter Stand: frontend @ abcdef1 (main), mit uncommitteten Änderungen. Übereinstimmung mit dem deployten Stand ist nicht geprüft._",
      "### Umsetzungsideen (Vermutung)\n- Abstände der Komponente prüfen.", "### Offene Angaben\n- Ein genauer Zielabstand wurde nicht festgelegt.",
    ]) expect(body).toContain(line);
    expect(body.endsWith("Review-Referenz: wr-123")).toBe(true);
    expect(renderAppendComment(input())).toBe(`Ergänzendes Feedback aus Website-Review:\n\n${body}`);
  });
  it("omits empty sections, renders points/pages, and retains every merged original", () => {
    const data = input();
    const context = data.comments[0]!.context;
    data.comments = [{ text: "Erster Wunsch", markKind: "point", context: { ...context, extraContext: "" } }, { text: "Zweiter Wunsch", markKind: "page", context }];
    data.analysis.findings = []; data.analysis.ticket.openPoints = []; data.analysis.ticket.implementationIdeas = [""];
    data.analysis.checkouts = [];
    const body = renderCardDescription(data);
    expect(body).toContain("**Originalkommentar:** „Erster Wunsch“");
    expect(body).toContain("**Originalkommentar:** „Zweiter Wunsch“");
    expect(body).toContain("- Markierung: freie Position");
    expect(body).toContain("- Markierung: allgemeiner Seitenkommentar");
    expect(body).not.toContain("### Code-Fundstellen"); expect(body).not.toContain("### Umsetzungsideen"); expect(body).not.toContain("### Offene Angaben");
    expect(body).toContain("Lokaler Code wurde untersucht.");
    expect(body).toContain("Übereinstimmung mit dem deployten Stand ist nicht geprüft.");
  });
  it("renders a single line without a redundant range", () => {
    const data = input();
    data.analysis.findings = [{ repository: "frontend", path: "page.ts", lineStart: 5, lineEnd: 5, note: "Fundstelle" }];
    expect(renderCardDescription(data)).toContain("`page.ts:5` – Fundstelle");
    expect(renderAppendComment(data)).toContain("`page.ts:5` – Fundstelle");
  });
  it("does not invent missing line numbers or branch names", () => {
    const data = input();
    data.analysis.findings = [{ repository: "frontend", path: "page.ts", note: "Fundstelle" }];
    data.analysis.checkouts = [{ alias: "frontend", headCommit: "123456789", hasUncommittedChanges: false }];
    const body = renderCardDescription(data);
    expect(body).toContain("`page.ts` – Fundstelle"); expect(body).toContain("frontend @ 1234567.");
    expect(body).not.toContain("undefined"); expect(body).not.toContain("uncommitteten");
  });
  it.each([renderCardDescription, renderAppendComment])("caps text at 10,000 chars, preserving the staging caveat and final reference", (render) => {
    const data = input(); data.analysis.ticket.desiredChange = "Wunsch 😀 ".repeat(3000);
    const body = render(data);
    expect(body.length).toBeLessThanOrEqual(10000);
    expect(body).toContain("Hinweis: Inhalt wegen der Zeichenbegrenzung gekürzt.");
    expect(body).toContain("Lokal untersuchter Stand:");
    expect(body).toContain("Übereinstimmung mit dem deployten Stand ist nicht geprüft.");
    expect(body.endsWith("Review-Referenz: wr-123")).toBe(true);
    expect(body).not.toMatch(/[\uD800-\uDBFF]\n/);
  });
  it("caps titles and removes line breaks without splitting emoji", () => {
    const ticket = input().analysis.ticket;
    expect(renderCardTitle({ ...ticket, title: "  Mehr\n Abstand  " })).toBe("Mehr Abstand");
    const title = renderCardTitle({ ...ticket, title: "a".repeat(199) + "😀" });
    expect(title).toHaveLength(199);
  });
});

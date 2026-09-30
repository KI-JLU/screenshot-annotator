import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { PROCESSABLE_STATES, type AnswerRequest, type Comment, type DecisionInput, type DuplicateCandidate,
  type CodeFinding, type PendingDecision, type PreflightProblem, type ProjectView, type ReconcileRequest } from "@website-review/shared";
import type { ProcessingService } from "../app.ts";
import type { AnalysisInput, AnalysisOutput, AnalysisRunner } from "../codex/types.ts";
import { AnalysisOutputSchema } from "../codex/analysisSchema.ts";
import { conflict, HttpError, notFound } from "../http/errors.ts";
import { newId } from "../ids.ts";
import { KanError } from "../kan/types.ts";
import type { ProjectsService } from "../projects/projects.ts";
import { Publisher } from "../publishing/publisher.ts";
import type { Store } from "../store/store.ts";

interface JobRecord {
  revision: number;
  checkouts: AnalysisInput["checkouts"];
  output?: AnalysisOutput;
  candidates?: DuplicateCandidate[];
  decision?: PendingDecision;
}
export interface ProcessingOptions {
  store: Store;
  projects: ProjectsService;
  runner: AnalysisRunner;
  internalToken: string;
  socketPath: () => string;
  cliPath?: string;
}

export class ReviewProcessingService implements ProcessingService {
  readonly publisher: Publisher;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly publishQueues = new Map<string, Promise<void>>();
  private readonly scheduled = new Set<string>();
  private readonly abort = new AbortController();
  private stopped = false;
  constructor(private readonly options: ProcessingOptions) { this.publisher = new Publisher(options.store, options.projects); }
  private get store() { return this.options.store; }
  private comment(id: string): Comment { return this.store.getComment(id) ?? notFound("Kommentar"); }
  private record(id: string): JobRecord | undefined { return this.store.getProcessingRecord(id, "analysis"); }
  private save(id: string, record: JobRecord): void { this.store.setProcessingRecord(id, "analysis", record); }
  private members(comment: Comment): Comment[] {
    if (!comment.mergeGroupId) return [comment];
    const proposal = this.store.getMergeProposal(comment.mergeGroupId);
    return proposal?.commentIds.map((id) => this.comment(id)) ?? [comment];
  }
  private async check(reviewId: string): Promise<{ problems: PreflightProblem[]; view: ProjectView }> {
    const review = this.store.getReview(reviewId) ?? notFound("Review");
    const [view, probe] = await Promise.all([this.options.projects.view(review.projectId, true),
      this.options.runner.probe().catch(() => ({ available: false, problem: "Codex ist nicht erreichbar" }))]);
    const problems: PreflightProblem[] = view.checkouts.filter((c) => !c.ok).map((c) => ({ kind: "checkout", message: `${c.alias}: ${c.problem ?? "Checkout fehlt"}` }));
    if (!probe.available) problems.push({ kind: "codex", message: probe.problem ?? "Codex ist nicht erreichbar" });
    if (!view.kan.tokenConfigured || !view.kan.tokenValid) problems.push({ kind: "kan_token", message: view.kan.problem ?? "Kan-Zugang ungültig – Verbindung prüfen" });
    else if (!view.kan.targetValid) problems.push({ kind: "kan_target", message: view.kan.problem ?? "Zielboard oder Zielspalte fehlt – Ziel korrigieren" });
    return { problems, view };
  }
  async preflight(reviewId: string): Promise<PreflightProblem[]> { return (await this.check(reviewId)).problems; }
  private requireCheck(result: { problems: PreflightProblem[] }): void {
    if (result.problems.length) throw new HttpError(409, "preflight_failed", "Verarbeitung nicht möglich: Voraussetzungen fehlen", result.problems);
  }
  private stage(comments: Comment[], view: ProjectView): void {
    this.store.transaction(() => {
      for (const comment of comments) {
        const checkouts = view.checkouts.map((c) => ({ alias: c.alias, path: c.path!, headCommit: c.headCommit!, branch: c.branch, hasUncommittedChanges: c.hasUncommittedChanges ?? false }));
        this.save(comment.id, { revision: comment.revision, checkouts });
        this.store.updateComment(comment.id, { state: "processing", stateDetail: undefined, pendingDecision: undefined, analysis: undefined }, comment.revision);
      }
    });
    this.enqueue(comments[0]!, () => this.analyze(comments), `analysis:${comments.map((c) => c.id).join(",")}`);
  }
  private enqueue(comment: Comment, action: () => Promise<void>, phase = "continue"): void {
    if (this.stopped) return;
    const key = `${comment.id}:${comment.revision}:${phase}`;
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    const queues = phase === "publish" ? this.publishQueues : this.queues;
    const previous = queues.get(comment.reviewId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.stopped) return;
      try { await action(); }
      catch {
        const current = this.store.getComment(comment.id);
        if (current?.revision === comment.revision && !["published", "outcome_unclear"].includes(current.state)) {
          for (const member of this.members(current)) this.store.updateCommentState(member.id, "failed", "Verarbeitung fehlgeschlagen – erneut versuchen");
        }
      }
    }).finally(() => {
      this.scheduled.delete(key);
      if (queues.get(comment.reviewId) === next) queues.delete(comment.reviewId);
    });
    queues.set(comment.reviewId, next);
  }
  async processReview(reviewId: string): Promise<{ started: string[] }> {
    const checked = await this.check(reviewId); this.requireCheck(checked);
    const picked = this.store.listComments(reviewId).filter((c) => PROCESSABLE_STATES.includes(c.state));
    const handled = new Set<string>();
    for (const comment of picked) {
      if (handled.has(comment.id)) continue;
      const group = this.members(comment); group.forEach((c) => handled.add(c.id));
      if (comment.ticket || comment.analysis?.revision === comment.revision) this.continue(group);
      else this.stage(group, checked.view);
    }
    return { started: [...handled] };
  }
  private continue(comments: Comment[]): void {
    const primary = comments[0]!;
    this.store.transaction(() => { for (const c of comments) this.store.updateCommentState(c.id, c.ticket ? "ticket_created" : "ready"); });
    this.enqueue(primary, async () => {
      const project = this.options.projects.config(this.store.getReview(primary.reviewId)!.projectId);
      this.publisher.prepare(comments.map((c) => this.comment(c.id)), project.target);
      await this.publisher.publish(primary.id);
    }, "publish");
  }
  private unchanged(comments: Comment[]): boolean {
    if (comments.every((c) => this.store.getComment(c.id)?.revision === c.revision)) return true;
    this.store.transaction(() => {
      for (const c of comments) {
        const current = this.store.getComment(c.id);
        if (current && (current.revision === c.revision || current.state === "processing")) {
          this.store.updateComment(c.id, { state: "draft", mergeGroupId: undefined, pendingDecision: undefined, analysis: undefined });
        }
      }
    });
    return false;
  }
  private async analyze(snapshots: Comment[]): Promise<void> {
    if (!this.unchanged(snapshots)) return;
    const primary = this.comment(snapshots[0]!.id);
    // A queued individual turn is superseded by acceptance of a merge.
    if (snapshots.length === 1 && primary.mergeGroupId && !snapshots[0]!.mergeGroupId) return;
    if (!["processing", "decision_open"].includes(primary.state)) return;
    const record = this.record(primary.id);
    if (!record || record.revision !== primary.revision) return;
    const review = this.store.getReview(primary.reviewId)!;
    const project = this.options.projects.config(review.projectId);
    const input: AnalysisInput = {
      review: { id: review.id, projectName: project.name, codexThreadId: review.codexThreadId }, checkouts: record.checkouts,
      comments: snapshots.map((c) => ({ commentId: c.id, revision: c.revision, text: c.text, markKind: c.markKind,
        context: c.context, questions: this.comment(c.id).questions, imagePath: this.store.getImagePath(c.id) })),
      otherComments: snapshots.length > 1 ? [] : this.store.listComments(review.id)
        .filter((c) => c.id !== primary.id && c.state !== "published" && !c.ticket)
        .map((c) => ({ commentId: c.id, text: c.text, url: c.context.url })),
      gateway: { command: process.execPath, args: [this.options.cliPath ?? process.argv[1] ?? fileURLToPath(new URL("../cli.ts", import.meta.url)), "mcp"],
        env: { WEBSITE_REVIEW_COMPANION_SOCKET: this.options.socketPath(), WEBSITE_REVIEW_INTERNAL_TOKEN: this.options.internalToken,
          WEBSITE_REVIEW_REVIEW_ID: review.id, WEBSITE_REVIEW_PROJECT_ID: project.projectId } }, signal: this.abort.signal,
    };
    const result = await this.options.runner.analyze(input);
    if (this.stopped || !this.store.getReview(review.id)) return;
    if (result.threadId) this.store.setCodexThreadId(review.id, result.threadId);
    if (!this.unchanged(snapshots)) return;
    if (snapshots.length === 1 && this.comment(primary.id).mergeGroupId !== snapshots[0]!.mergeGroupId) return;
    if (!result.ok) {
      for (const c of snapshots) this.store.updateCommentState(c.id, "failed", result.error);
      return;
    }
    const output = AnalysisOutputSchema.parse(result.output);
    if (output.duplicateCheck === "failed") {
      for (const c of snapshots) this.store.updateComment(c.id, { state: "failed", analysis: undefined,
        stateDetail: "Duplikatprüfung in Kan fehlgeschlagen – bitte erneut versuchen" });
      return;
    }
    const findings: CodeFinding[] = [];
    for (const finding of output.findings) {
      const checkout = record.checkouts.find((c) => c.alias === finding.repository);
      if (!checkout || !finding.path || isAbsolute(finding.path) || win32.isAbsolute(finding.path) || finding.path.split(/[\\/]/).includes("..")) continue;
      try {
        const root = await realpath(checkout.path);
        const path = await realpath(resolve(root, finding.path));
        const rel = relative(root, path);
        if (!rel || rel.startsWith("..") || isAbsolute(rel) || !(await stat(path)).isFile()) continue;
        findings.push({ repository: finding.repository, path: finding.path, note: finding.note,
          ...(finding.lineStart == null ? {} : { lineStart: finding.lineStart }), ...(finding.lineEnd == null ? {} : { lineEnd: finding.lineEnd }) });
      } catch { /* A finding must name a real file within its checkout, including symlinks. */ }
    }
    const candidates: DuplicateCandidate[] = [];
    const client = this.options.projects.client(project.target.baseUrl);
    for (const duplicate of output.duplicates) {
      try {
        const card = await client.getCard(duplicate.cardPublicId);
        candidates.push({ cardPublicId: card.publicId, title: card.title, url: client.cardUrl(card.publicId), reason: duplicate.reason });
      } catch (error) { if (!(error instanceof KanError && error.kind === "not_found")) throw error; }
    }
    if (!this.unchanged(snapshots)) return;
    if (snapshots.length === 1 && this.comment(primary.id).mergeGroupId !== snapshots[0]!.mergeGroupId) return;
    this.store.transaction(() => {
      for (const c of snapshots) {
        this.store.setAnalysis(c.id, { revision: c.revision, ticket: output.ticket, findings,
          checkouts: record.checkouts.map(({ path: _path, ...snapshot }) => snapshot), analyzedAt: new Date().toISOString() });
        this.save(c.id, { ...this.record(c.id)!, output, candidates });
      }
    });
    if (this.comment(primary.id).pendingDecision?.kind === "merge") return;
    if (snapshots.length === 1 && !primary.mergeGroupId && output.mergeWith.length) {
      const others = output.mergeWith.map((m) => this.store.getComment(m.commentId)).filter((c): c is Comment =>
        !!c && c.id !== primary.id && c.reviewId === primary.reviewId && !c.ticket && !c.mergeGroupId && !this.publisher.plan(c.id) &&
        ["draft", "processing", "question_open", "decision_open", "ready", "failed"].includes(c.state) && c.pendingDecision?.kind !== "merge" &&
        !this.store.listMergeProposals(primary.reviewId).some((p) => p.status === "rejected" && p.commentIds.includes(primary.id) && p.commentIds.includes(c.id)) &&
        !this.store.listOpsForComment(c.id).some((o) => o.state !== "failed"));
      if (others.length) {
        const ids = [...new Set([primary.id, ...others.map((c) => c.id)])];
        const proposal = { id: newId(), reviewId: primary.reviewId, commentIds: ids,
          reason: output.mergeWith.filter((m) => ids.includes(m.commentId)).map((m) => m.reason).join("; "), status: "open" as const };
        this.store.transaction(() => {
          this.store.insertMergeProposal(proposal);
          for (const id of ids) {
            const c = this.comment(id);
            const own = this.record(id) ?? { revision: c.revision, checkouts: record.checkouts };
            this.save(id, { ...own, decision: c.pendingDecision });
            this.store.updateComment(id, { state: "decision_open", pendingDecision: { kind: "merge", proposalId: proposal.id } });
          }
        });
        return;
      }
    }
    await this.settle(snapshots.map((c) => this.comment(c.id)));
  }
  private async settle(comments: Comment[]): Promise<void> {
    const primary = comments[0]!;
    const record = this.record(primary.id);
    if (!primary.analysis || primary.analysis.revision !== primary.revision) {
      const checked = await this.check(primary.reviewId); this.requireCheck(checked); this.stage(comments, checked.view); return;
    }
    if (record?.output?.outcome === "question") {
      for (const c of comments) this.store.updateComment(c.id, { state: "question_open", pendingDecision: undefined,
        questions: [...c.questions.filter((q) => q.answer !== undefined), ...record.output.questions.map((text) => ({ id: newId(), text }))] });
    } else if (record?.output?.outcome === "duplicate" && record.candidates?.length) {
      for (const c of comments) this.store.updateComment(c.id, { state: "decision_open", pendingDecision: { kind: "duplicate", candidates: record.candidates } });
    } else {
      const project = this.options.projects.config(this.store.getReview(primary.reviewId)!.projectId);
      const current = comments.map((c) => this.store.updateComment(c.id, { state: "ready", pendingDecision: undefined, stateDetail: undefined }));
      this.publisher.prepare(current, project.target);
      this.enqueue(primary, () => this.publisher.publish(primary.id), "publish");
    }
  }
  async answer(id: string, request: AnswerRequest): Promise<Comment> {
    const c = this.comment(id);
    if (c.state !== "question_open" || !c.questions.some((q) => q.id === request.questionId && q.answer === undefined)) conflict("Rückfrage ist nicht offen");
    this.store.setQuestions(id, c.questions.map((q) => q.id === request.questionId ? { ...q, answer: request.answer, answeredAt: new Date().toISOString() } : q));
    const group = this.members(this.comment(id));
    // Combined questions are shared across the accepted group.
    if (group.length > 1) for (const other of group.filter((m) => m.id !== id)) {
      const text = c.questions.find((q) => q.id === request.questionId)!.text;
      this.store.setQuestions(other.id, other.questions.map((q) => q.text === text ? { ...q, answer: request.answer, answeredAt: new Date().toISOString() } : q));
    }
    if (group.every((m) => this.comment(m.id).questions.every((q) => q.answer !== undefined))) {
      const checked = await this.check(c.reviewId);
      this.store.transaction(() => {
        const proposal = c.mergeGroupId ? this.store.getMergeProposal(c.mergeGroupId) : undefined;
        if (c.mergeGroupId && (!proposal || proposal.status !== "accepted" ||
          proposal.commentIds.length !== group.length || proposal.commentIds.some((memberId, index) => memberId !== group[index]?.id))) return;
        if (group.some((member) => {
          const current = this.store.getComment(member.id);
          return !current || current.revision !== member.revision || current.mergeGroupId !== member.mergeGroupId || current.state !== "question_open";
        })) return;
        if (checked.problems.length) {
          for (const member of group) this.store.updateComment(member.id, { state: "failed", analysis: undefined,
            stateDetail: checked.problems.map((p) => p.message).join("; ") });
        } else this.stage(group.map((m) => this.comment(m.id)), checked.view);
      });
      this.requireCheck(checked);
    }
    return this.comment(id);
  }
  async decide(id: string, input: DecisionInput): Promise<Comment> {
    const c = this.comment(id);
    if (c.state !== "decision_open" || c.pendingDecision?.kind !== input.kind) conflict("Entscheidung ist nicht offen");
    if (input.kind === "duplicate") {
      if (c.pendingDecision.kind !== "duplicate") conflict("Duplikatentscheidung fehlt");
      const candidate = input.action === "append" ? c.pendingDecision.candidates.find((d) => d.cardPublicId === input.cardPublicId) : undefined;
      if (input.action === "append" && !candidate) conflict("Karte wurde nicht als Duplikat angeboten");
      const group = this.members(c);
      const project = this.options.projects.config(this.store.getReview(c.reviewId)!.projectId);
      this.store.transaction(() => {
        this.publisher.prepare(group, project.target, candidate ? "appended" : "created", candidate?.cardPublicId, candidate?.title);
        for (const member of group) this.store.updateComment(member.id, { state: "ready", pendingDecision: undefined });
      });
      this.enqueue(group[0]!, () => this.publisher.publish(group[0]!.id), "publish");
    } else {
      if (c.pendingDecision.kind !== "merge" || c.pendingDecision.proposalId !== input.proposalId) conflict("Zusammenfassungsvorschlag passt nicht");
      const proposal = this.store.getMergeProposal(input.proposalId);
      if (!proposal || proposal.status !== "open" || !proposal.commentIds.includes(id)) conflict("Zusammenfassungsvorschlag ist nicht offen");
      const group = proposal.commentIds.map((memberId) => this.comment(memberId));
      if (group.some((m) => m.ticket || m.pendingDecision?.kind !== "merge" || m.pendingDecision.proposalId !== proposal.id || this.record(m.id)?.revision !== m.revision)) conflict("Kommentar im Vorschlag wurde inzwischen geändert");
      const checked = input.action === "accept" ? await this.check(c.reviewId) : undefined;
      if (checked) this.requireCheck(checked);
      // Recheck after asynchronous preflight; another decision may have settled it.
      if (this.store.getMergeProposal(proposal.id)?.status !== "open") conflict("Zusammenfassungsvorschlag wurde bereits entschieden");
      if (group.some((m) => this.comment(m.id).revision !== m.revision || this.comment(m.id).pendingDecision?.kind !== "merge")) conflict("Kommentar im Vorschlag wurde inzwischen geändert");
      this.store.transaction(() => {
        this.store.updateMergeProposal(proposal.id, input.action === "accept" ? "accepted" : "rejected");
        for (const member of group) this.store.updateComment(member.id, { pendingDecision: undefined,
          mergeGroupId: input.action === "accept" ? proposal.id : undefined, state: "processing" });
      });
      if (checked) this.stage(group.map((m) => this.comment(m.id)), checked.view);
      else for (const member of group) this.enqueue(member, () => this.settle([this.comment(member.id)]));
    }
    return this.comment(id);
  }
  async retry(id: string): Promise<Comment> {
    const c = this.comment(id);
    if (c.state !== "failed") conflict("Nur fehlgeschlagene Kommentare können erneut versucht werden");
    const group = this.members(c);
    if (c.ticket || c.analysis?.revision === c.revision) this.continue(group);
    else { const checked = await this.check(c.reviewId); this.requireCheck(checked); this.stage(group, checked.view); }
    return this.comment(id);
  }
  async reconcile(id: string, request: ReconcileRequest): Promise<Comment> {
    const group = this.members(this.comment(id));
    await this.publisher.reconcile(group[0]!.id, request);
    return this.comment(id);
  }
  async resume(): Promise<void> {
    for (const review of this.store.listReviews()) {
      const handled = new Set<string>();
      for (const c of this.store.listComments(review.id)) {
        if (handled.has(c.id)) continue;
        const group = this.members(c); group.forEach((m) => handled.add(m.id));
        const primary = group[0]!;
        const ops = this.store.listOpsForComment(primary.id, primary.revision);
        if (ops.some((op) => op.state === "sent")) {
          for (const op of ops.filter((o) => o.state === "sent")) this.store.markOp(op.id, "unclear", { error: "Dienst während Veröffentlichung beendet" });
          for (const member of group) this.store.updateCommentState(member.id, "outcome_unclear", "Dienst während Veröffentlichung beendet – Abgleich erforderlich");
          this.enqueue(primary, async () => { await this.ensurePlan(group); await this.publisher.reconcile(primary.id, { action: "recheck" }); }, "publish");
        } else if (["ready", "publishing", "ticket_created"].includes(primary.state)) {
          this.enqueue(primary, async () => { await this.ensurePlan(group); await this.publisher.publish(primary.id); }, "publish");
        } else if (primary.state === "processing") {
          const checked = await this.check(review.id);
          if (checked.problems.length) { for (const member of group) this.store.updateCommentState(member.id, "failed", checked.problems.map((p) => p.message).join("; ")); }
          else this.stage(group, checked.view);
        }
      }
    }
  }
  private async ensurePlan(group: Comment[]): Promise<void> {
    const primary = group[0]!;
    if (this.publisher.plan(primary.id)) return;
    const project = this.options.projects.config(this.store.getReview(primary.reviewId)!.projectId);
    const op = this.store.listOpsForComment(primary.id, primary.revision).find((o) => o.kind === "add_comment" && o.state !== "failed");
    this.publisher.prepare(group, project.target, primary.ticket?.mode ?? (op ? "appended" : "created"), primary.ticket?.cardPublicId ?? op?.cardPublicId, primary.ticket?.title);
  }
  async idle(): Promise<void> {
    while (this.queues.size || this.publishQueues.size) await Promise.all([...this.queues.values(), ...this.publishQueues.values()]);
  }
  async close(): Promise<void> {
    this.stopped = true; this.abort.abort(); await this.options.runner.close(); await this.idle();
  }
}

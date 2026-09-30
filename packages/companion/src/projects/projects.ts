import { isAbsolute } from "node:path";
import { ProjectConfigSchema, matchProjects } from "@website-review/shared";
import type { KanConnectionStatus, ProjectConfig, ProjectView } from "@website-review/shared";
import type { KanClient, KanClientOptions } from "../kan/types.ts";
import { KanError } from "../kan/types.ts";
import { validateCheckout } from "../checkouts/validate.ts";
import { conflict, HttpError, notFound } from "../http/errors.ts";
import { normalizeBaseUrl, Secrets } from "../secrets/secrets.ts";
import { Store } from "../store/store.ts";

export type KanClientFactory = (opts: KanClientOptions) => KanClient;

export function kanProblem(error: unknown): string {
  if (error instanceof KanError && error.kind === "auth") return "Kan-Zugang ungültig";
  if (error instanceof KanError && error.kind === "not_found") return "Zielboard oder Zielspalte fehlt";
  return "Kan nicht erreichbar";
}

export class ProjectsService {
  private readonly cache = new Map<string, ProjectView>();
  private readonly pending = new Map<string, Promise<ProjectView>>();
  private readonly generations = new Map<string, number>();
  constructor(readonly store: Store, readonly secrets: Secrets, readonly kanClientFactory: KanClientFactory) {}

  config(id: string): ProjectConfig {
    const config = this.store.getProject(id);
    if (!config) notFound("Projekt");
    return config;
  }
  private parse(input: unknown): ProjectConfig {
    const result = ProjectConfigSchema.safeParse(input);
    if (!result.success) throw new HttpError(400, "validation", "Ungültige Projektconfig");
    // Also reject unsupported URL schemes or credentials in the shared target.
    normalizeBaseUrl(result.data.target.baseUrl);
    return result.data;
  }
  invalidate(id?: string): void {
    for (const key of id === undefined ? this.store.listProjects().map((c) => c.projectId) : [id]) {
      this.cache.delete(key); this.pending.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
  }
  async create(input: unknown): Promise<ProjectView> {
    const config = this.parse(input);
    if (this.store.getProject(config.projectId)) conflict("Projekt existiert bereits");
    this.store.saveProject(config);
    this.invalidate(config.projectId);
    return this.view(config.projectId);
  }
  async import(input: unknown, replaceExisting = false): Promise<ProjectView> {
    const config = this.parse(input);
    if (this.store.getProject(config.projectId) && !replaceExisting) conflict("Projekt existiert bereits");
    this.store.saveProject(config);
    this.invalidate(config.projectId);
    return this.view(config.projectId);
  }
  async update(id: string, input: unknown): Promise<ProjectView> {
    this.config(id);
    const config = this.parse(input);
    if (config.projectId !== id) throw new HttpError(400, "validation", "Projekt-ID darf nicht geändert werden");
    this.store.saveProject(config); this.invalidate(id);
    return this.view(id);
  }
  delete(id: string): void { this.store.deleteProject(id); this.invalidate(id); }
  export(id: string): ProjectConfig { return this.parse(this.config(id)); }
  match(url: string): string[] { return matchProjects(this.store.listProjects(), url); }

  async setCheckouts(id: string, checkouts: Record<string, string>): Promise<ProjectView> {
    const config = this.config(id);
    for (const [alias, path] of Object.entries(checkouts)) {
      if (!config.repositoryAliases.includes(alias)) throw new HttpError(400, "validation", "Unbekannter Repository-Alias");
      if (!isAbsolute(path)) throw new HttpError(400, "validation", "Absoluter Ordnerpfad erforderlich");
    }
    this.store.setCheckouts(id, checkouts); this.invalidate(id);
    return this.view(id);
  }

  client(baseUrl: string): KanClient {
    const apiToken = this.secrets.get(baseUrl);
    if (!apiToken) throw new HttpError(400, "kan_error", "Kan-Zugang fehlt");
    return this.kanClientFactory({ baseUrl: normalizeBaseUrl(baseUrl), apiToken });
  }
  private async checkKan(config: ProjectConfig): Promise<KanConnectionStatus> {
    const { baseUrl, workspacePublicId, boardPublicId, listPublicId } = config.target;
    const status: KanConnectionStatus = { baseUrl, tokenConfigured: !!this.secrets.get(baseUrl) };
    if (!status.tokenConfigured) return { ...status, problem: "Kan-Zugang fehlt" };
    let client: KanClient;
    try {
      client = this.client(baseUrl);
      const workspaces = await client.listWorkspaces();
      status.tokenValid = true;
      if (!workspaces.some((w) => w.publicId === workspacePublicId)) {
        return { ...status, targetValid: false, problem: "Zielworkspace fehlt" };
      }
    } catch (error) { return { ...status, tokenValid: false, targetValid: false, problem: kanProblem(error) }; }
    try {
      const board = await client.getBoard(boardPublicId);
      if (board.publicId !== boardPublicId) return { ...status, targetValid: false, problem: "Zielboard fehlt" };
      if (!board.lists.some((l) => l.publicId === listPublicId)) return { ...status, targetValid: false, problem: "Zielspalte fehlt" };
      return { ...status, targetValid: true };
    } catch (error) { return { ...status, targetValid: false, problem: kanProblem(error) }; }
  }
  async view(id: string, force = false): Promise<ProjectView> {
    const config = this.config(id);
    if (force) this.invalidate(id);
    const cached = this.cache.get(id);
    if (cached) return structuredClone(cached);
    const pending = this.pending.get(id);
    if (pending) return structuredClone(await pending);
    const generation = this.generations.get(id) ?? 0;
    const mappings = this.store.getCheckouts(id);
    const check = (async () => {
      const [checkouts, kan] = await Promise.all([
        Promise.all(config.repositoryAliases.map((alias) => validateCheckout(alias, mappings[alias]))),
        this.checkKan(config),
      ]);
      const view: ProjectView = { config, checkouts, kan,
        readyForProcessing: checkouts.every((c) => c.ok) && kan.tokenValid === true && kan.targetValid === true };
      if ((this.generations.get(id) ?? 0) === generation) this.cache.set(id, view);
      return view;
    })();
    this.pending.set(id, check);
    try { return structuredClone(await check); }
    finally { if (this.pending.get(id) === check) this.pending.delete(id); }
  }
  async list(): Promise<ProjectView[]> { return Promise.all(this.store.listProjects().map((c) => this.view(c.projectId))); }
}

/**
 * Create / edit the shareable project config: name, id, URL rules, repository aliases and the Kan
 * target (workspace → board → list, the list is always chosen explicitly).
 */
import { useEffect, useId, useState } from "preact/hooks";
import type { KanBoard, KanCredentialStatus, KanList, KanWorkspace, ProjectConfig, ProjectView } from "@website-review/shared";
import { ProjectConfigSchema } from "@website-review/shared";
import { isCompanionError } from "../../lib/api.ts";
import { useAction, useApp } from "../context.ts";
import { ErrorText, Field, Notice } from "./ui.tsx";

interface RuleDraft {
  scheme: "http" | "https";
  hostname: string;
  port: string;
  pathPrefix: string;
}

const DEFAULT_KAN = "https://kan.bn";

function ruleFromUrl(url: string | undefined): RuleDraft | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { scheme: u.protocol === "https:" ? "https" : "http", hostname: u.hostname, port: u.port, pathPrefix: "/" };
  } catch {
    return null;
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeKanUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}

export function ProjectForm(props: {
  existing?: ProjectView;
  fromUrl?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client, announce, handleError } = useApp();
  const id = useId();
  const ex = props.existing?.config;
  const editing = !!ex;

  const [name, setName] = useState(ex?.name ?? "");
  const [projectId, setProjectId] = useState(ex?.projectId ?? "");
  const [idTouched, setIdTouched] = useState(editing);
  const [rules, setRules] = useState<RuleDraft[]>(() =>
    ex
      ? ex.urlRules.map((r) => ({ scheme: r.scheme, hostname: r.hostname, port: r.port ? String(r.port) : "", pathPrefix: r.pathPrefix ?? "/" }))
      : [ruleFromUrl(props.fromUrl) ?? { scheme: "http", hostname: "localhost", port: "3000", pathPrefix: "/" }],
  );
  const [aliases, setAliases] = useState(ex?.repositoryAliases.join(", ") ?? "");

  // Kan target
  const [kanUrl, setKanUrl] = useState(ex?.target.baseUrl ?? DEFAULT_KAN);
  const [token, setToken] = useState("");
  const [cred, setCred] = useState<KanCredentialStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<KanWorkspace[] | null>(null);
  const [boards, setBoards] = useState<KanBoard[] | null>(null);
  const [lists, setLists] = useState<KanList[] | null>(null);
  const [ws, setWs] = useState(ex?.target.workspacePublicId ?? "");
  const [board, setBoard] = useState(ex?.target.boardPublicId ?? "");
  const [list, setList] = useState(ex?.target.listPublicId ?? "");
  const kanAction = useAction();
  const save = useAction();
  const [issues, setIssues] = useState<string[]>([]);

  const onName = (v: string) => {
    setName(v);
    if (!idTouched) setProjectId(slugify(v));
  };

  // ----- Kan loading chain -----
  const loadWorkspaces = (baseUrl: string, keep: { ws?: string; board?: string; list?: string } = {}) =>
    kanAction.run(async () => {
      const w = await client.listKanWorkspaces(baseUrl);
      setWorkspaces(w);
      if (keep.ws && w.some((x) => x.publicId === keep.ws)) {
        const b = await client.listKanBoards(baseUrl, keep.ws);
        setBoards(b);
        if (keep.board && b.some((x) => x.publicId === keep.board)) {
          const l = await client.listKanLists(baseUrl, keep.board);
          setLists(l);
          if (keep.list && !l.some((x) => x.publicId === keep.list)) setList("");
        } else setBoard("");
      } else if (keep.ws) {
        setWs("");
        setBoard("");
        setList("");
      }
    });

  const loadCredentialStatus = async (baseUrl: string, keep?: { ws?: string; board?: string; list?: string }) => {
    try {
      const all = await client.listKanCredentials();
      const s = all.find((c) => normalizeKanUrl(c.baseUrl) === baseUrl) ?? { baseUrl, configured: false };
      setCred(s);
      if (s.configured && s.valid !== false) await loadWorkspaces(baseUrl, keep);
    } catch (e) {
      handleError(e);
    }
  };

  useEffect(() => {
    void loadCredentialStatus(normalizeKanUrl(kanUrl), ex ? { ws: ex.target.workspacePublicId, board: ex.target.boardPublicId, list: ex.target.listPublicId } : undefined);
  }, []);

  const resetKan = () => {
    setCred(null);
    setWorkspaces(null);
    setBoards(null);
    setLists(null);
    setWs("");
    setBoard("");
    setList("");
  };

  const saveCredential = () =>
    kanAction.run(async () => {
      const baseUrl = normalizeKanUrl(kanUrl);
      const s = await client.setKanCredential({ baseUrl, apiToken: token.trim() });
      setCred(s);
      setToken("");
      if (s.valid === false) {
        announce("Kan-Zugang ungültig.");
        return;
      }
      announce("Kan-Zugang gespeichert.");
      const w = await client.listKanWorkspaces(baseUrl);
      setWorkspaces(w);
    });

  const chooseWs = (v: string) => {
    setWs(v);
    setBoard("");
    setList("");
    setBoards(null);
    setLists(null);
    if (v) void kanAction.run(async () => setBoards(await client.listKanBoards(normalizeKanUrl(kanUrl), v)));
  };

  const chooseBoard = (v: string) => {
    setBoard(v);
    setList("");
    setLists(null);
    if (v) void kanAction.run(async () => setLists(await client.listKanLists(normalizeKanUrl(kanUrl), v)));
  };

  // ----- rules -----
  const setRule = (i: number, patch: Partial<RuleDraft>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addCurrentPage = async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = ruleFromUrl(t?.url);
    if (r) setRules([...rules, r]);
    else announce("Die aktuelle Seite hat keine http- oder https-Adresse.");
  };

  // ----- submit -----
  const submit = (e: Event) => {
    e.preventDefault();
    const candidate = {
      schemaVersion: 1,
      projectId: projectId.trim(),
      name: name.trim(),
      urlRules: rules.map((r) => {
        const rule: Record<string, unknown> = {
          scheme: r.scheme,
          hostname: r.hostname.trim(),
          pathPrefix: r.pathPrefix.trim() || "/",
        };
        if (r.port.trim()) rule.port = Number(r.port.trim());
        return rule;
      }),
      target: {
        provider: "kan",
        baseUrl: normalizeKanUrl(kanUrl),
        workspacePublicId: ws,
        boardPublicId: board,
        listPublicId: list,
      },
      repositoryAliases: aliases
        .split(/[,\s]+/)
        .map((a) => a.trim())
        .filter(Boolean),
    };
    const problems: string[] = [];
    if (!ws || !board || !list) problems.push("Kan-Ziel: Workspace, Board und Zielspalte müssen ausgewählt werden.");
    const parsed = ProjectConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        if (i.path[0] === "target" && problems.length) continue;
        problems.push(`${issuePath(i.path)}: ${i.message}`);
      }
    }
    setIssues(problems);
    if (problems.length || !parsed.success) return;
    const config: ProjectConfig = parsed.data;
    void save.run(async () => {
      try {
        if (editing) await client.updateProject(config.projectId, config);
        else await client.createProject(config);
      } catch (err) {
        if (isCompanionError(err) && err.code === "conflict" && !editing) {
          throw new Error(`Ein Projekt mit der ID „${config.projectId}“ existiert bereits.`);
        }
        throw err;
      }
      announce(editing ? `Projekt „${config.name}“ gespeichert.` : `Projekt „${config.name}“ angelegt. Bitte jetzt Checkouts zuordnen.`);
      props.onDone();
    });
  };

  const credText = !cred
    ? "Zugang wird geprüft …"
    : !cred.configured
      ? "Für diese Kan-Adresse ist noch kein API-Token hinterlegt."
      : cred.valid === false
        ? `Hinterlegter Zugang ungültig${cred.problem ? `: ${cred.problem}` : ""}.`
        : "API-Token hinterlegt.";

  return (
    <form class="stack" onSubmit={submit} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{editing ? `Projekt „${ex?.name}“ bearbeiten` : "Neues Projekt"}</h2>

      <Field label="Name" id={`${id}-name`}>
        <input id={`${id}-name`} class="input" required value={name} onInput={(e) => onName(e.currentTarget.value)} />
      </Field>
      <Field label="Projekt-ID" id={`${id}-pid`} hint="Kleinbuchstaben, Ziffern und Bindestriche. Identifiziert das Projekt beim Import.">
        <input
          id={`${id}-pid`}
          class="input mono"
          required
          readOnly={editing}
          aria-describedby={`${id}-pid-hint`}
          value={projectId}
          onInput={(e) => {
            setIdTouched(true);
            setProjectId(e.currentTarget.value);
          }}
        />
      </Field>

      <fieldset class="stack-sm">
        <legend>Adressregeln</legend>
        <p class="hint">Eine Seite gehört zum Projekt, wenn Schema, Host, Port (leer = Standardport) und Pfadpräfix passen.</p>
        {rules.map((r, i) => (
          <div class="rule" key={i} role="group" aria-label={`Regel ${i + 1}`}>
            <div class="rule-grid">
              <div class="field">
                <label for={`${id}-r${i}-s`}>Schema</label>
                <select
                  id={`${id}-r${i}-s`}
                  class="input"
                  value={r.scheme}
                  onChange={(e) => setRule(i, { scheme: e.currentTarget.value === "https" ? "https" : "http" })}
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </div>
              <div class="field">
                <label for={`${id}-r${i}-h`}>Host</label>
                <input
                  id={`${id}-r${i}-h`}
                  class="input mono"
                  required
                  value={r.hostname}
                  onInput={(e) => setRule(i, { hostname: e.currentTarget.value })}
                />
              </div>
              <div class="field">
                <label for={`${id}-r${i}-p`}>Port</label>
                <input
                  id={`${id}-r${i}-p`}
                  class="input mono"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={r.port}
                  onInput={(e) => setRule(i, { port: e.currentTarget.value })}
                />
              </div>
              <div class="field">
                <label for={`${id}-r${i}-x`}>Pfadpräfix</label>
                <input
                  id={`${id}-r${i}-x`}
                  class="input mono"
                  value={r.pathPrefix}
                  onInput={(e) => setRule(i, { pathPrefix: e.currentTarget.value })}
                />
              </div>
            </div>
            <button
              type="button"
              class="btn small"
              disabled={rules.length === 1}
              onClick={() => setRules(rules.filter((_, j) => j !== i))}
              aria-label={`Regel ${i + 1} entfernen`}
            >
              Entfernen
            </button>
          </div>
        ))}
        <div class="row wrap">
          <button
            type="button"
            class="btn small"
            onClick={() => setRules([...rules, { scheme: "https", hostname: "", port: "", pathPrefix: "/" }])}
          >
            Regel hinzufügen
          </button>
          <button type="button" class="btn small" onClick={() => void addCurrentPage()}>
            Aktuelle Seite übernehmen
          </button>
        </div>
      </fieldset>

      <Field
        label="Repository-Aliasse"
        id={`${id}-al`}
        hint="Durch Komma getrennt, z. B. „frontend, backend“. Jedes Teammitglied ordnet die Aliasse eigenen Checkouts zu."
      >
        <input
          id={`${id}-al`}
          class="input mono"
          required
          aria-describedby={`${id}-al-hint`}
          value={aliases}
          onInput={(e) => setAliases(e.currentTarget.value)}
        />
      </Field>

      <fieldset class="stack-sm">
        <legend>Kan-Ziel</legend>
        <Field label="Kan-Adresse" id={`${id}-kan`}>
          <div class="row">
            <input
              id={`${id}-kan`}
              class="input mono grow"
              type="url"
              required
              value={kanUrl}
              onInput={(e) => setKanUrl(e.currentTarget.value)}
              onChange={() => {
                resetKan();
                void loadCredentialStatus(normalizeKanUrl(kanUrl));
              }}
            />
          </div>
        </Field>
        <p class="small" aria-live="polite">
          {credText}
        </p>
        <div class="field">
          <label for={`${id}-tok`}>
            API-Token{cred?.configured && cred.valid !== false ? " (optional ersetzen)" : ""}
          </label>
          <div class="row">
            <input
              id={`${id}-tok`}
              class="input mono grow"
              type="password"
              autoComplete="off"
              value={token}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
            <button type="button" class="btn small" disabled={!token.trim() || kanAction.busy} onClick={() => void saveCredential()}>
              Zugang speichern und prüfen
            </button>
          </div>
          <p class="hint">Der Token wird nur im Begleitdienst gespeichert und nie exportiert.</p>
        </div>
        {cred?.configured && cred.valid !== false && !workspaces && (
          <div class="row">
            <button type="button" class="btn small" onClick={() => void loadWorkspaces(normalizeKanUrl(kanUrl))}>
              Workspaces laden
            </button>
          </div>
        )}
        {workspaces && (
          <Select
            id={`${id}-ws`}
            label="Workspace"
            placeholder="Workspace wählen"
            options={workspaces}
            value={ws}
            onChange={chooseWs}
          />
        )}
        {boards && (
          <Select id={`${id}-b`} label="Board" placeholder="Board wählen" options={boards} value={board} onChange={chooseBoard} />
        )}
        {lists && (
          <Select
            id={`${id}-l`}
            label="Zielspalte (neue Tickets landen hier)"
            placeholder="Zielspalte ausdrücklich wählen"
            options={lists}
            value={list}
            onChange={setList}
          />
        )}
        {lists && lists.length === 0 && <Notice tone="warn">Dieses Board hat keine Spalten.</Notice>}
        {kanAction.busy && <p class="muted small">Lade aus Kan …</p>}
        <ErrorText error={kanAction.error} />
      </fieldset>

      {issues.length > 0 && (
        <div class="alert" role="alert">
          <p>Bitte korrigieren:</p>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorText error={save.error} />
      <div class="row">
        <button type="submit" class="btn primary" disabled={save.busy}>
          {editing ? "Speichern" : "Projekt anlegen"}
        </button>
        <button type="button" class="btn" onClick={props.onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

function Select(props: {
  id: string;
  label: string;
  placeholder: string;
  options: { publicId: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      <select id={props.id} class="input" required value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
        <option value="">– {props.placeholder} –</option>
        {props.options.map((o) => (
          <option key={o.publicId} value={o.publicId}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

const FIELD_NAMES: Record<string, string> = {
  projectId: "Projekt-ID",
  name: "Name",
  urlRules: "Adressregeln",
  target: "Kan-Ziel",
  repositoryAliases: "Repository-Aliasse",
  hostname: "Host",
  port: "Port",
  pathPrefix: "Pfadpräfix",
  scheme: "Schema",
  baseUrl: "Kan-Adresse",
};

export function issuePath(path: (string | number)[]): string {
  if (path.length === 0) return "Config";
  return path.map((p) => (typeof p === "number" ? `#${p + 1}` : (FIELD_NAMES[p] ?? p))).join(" ");
}

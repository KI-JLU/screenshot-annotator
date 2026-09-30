import type { DatabaseSync } from "node:sqlite";

export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  // Read the version under the migration write lock.
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 4) throw new Error("Datenbankversion wird nicht unterstützt");
    if (version === 0) db.exec(`
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE checkouts (
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      alias TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, alias)
    );
    CREATE TABLE pairing (id INTEGER PRIMARY KEY CHECK (id = 1), extension_origin TEXT NOT NULL, token_hash TEXT NOT NULL);
    CREATE TABLE pairing_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE reviews (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, codex_thread_id TEXT
    );
    CREATE INDEX reviews_project ON reviews(project_id);
    CREATE TABLE comments (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1), text TEXT NOT NULL, mark_kind TEXT NOT NULL,
      context_json TEXT NOT NULL, screenshot_json TEXT, image_path TEXT,
      state TEXT NOT NULL, state_detail TEXT, questions_json TEXT NOT NULL,
      pending_decision_json TEXT, merge_group_id TEXT, analysis_json TEXT, ticket_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX comments_review ON comments(review_id);
    CREATE TABLE merge_proposals (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      comment_ids_json TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE publication_ops (
      id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, kind TEXT NOT NULL, reference TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
      card_public_id TEXT, external_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX ops_comment ON publication_ops(comment_id);
    CREATE UNIQUE INDEX ops_one_active ON publication_ops(comment_id, revision, kind)
      WHERE state IN ('intended', 'sent', 'unclear');
    PRAGMA user_version = 1;`);
    if (version < 2) db.exec(`
      ALTER TABLE comments ADD COLUMN client_request_id TEXT;
      CREATE UNIQUE INDEX comments_client_request ON comments(review_id, client_request_id)
        WHERE client_request_id IS NOT NULL;
      PRAGMA user_version = 2;`);
    if (version < 3) db.exec(`
      CREATE TABLE processing_records (
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY (comment_id, namespace)
      );
      PRAGMA user_version = 3;`);
    if (version < 4) db.exec(`
      DROP TABLE IF EXISTS pairing;
      DROP TABLE IF EXISTS pairing_codes;
      PRAGMA user_version = 4;`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

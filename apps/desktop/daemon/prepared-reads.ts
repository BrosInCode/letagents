import type { DatabaseSync, StatementSync } from "node:sqlite";

/** A finite set of synchronous reads owned by one store connection, never row results. */
export class PreparedReadStatements<const Queries extends Record<string, string>> {
  private database: DatabaseSync | null = null;
  private readonly statements = new Map<keyof Queries, StatementSync>();

  constructor(private readonly queries: Queries) {}

  /** Callers finish get/all synchronously; do not retain an iterator across reuse. */
  get(database: DatabaseSync, key: keyof Queries): StatementSync {
    if (this.database !== database) {
      this.clear();
      this.database = database;
    }
    let statement = this.statements.get(key);
    if (!statement) {
      statement = database.prepare(this.queries[key]);
      this.statements.set(key, statement);
    }
    return statement;
  }

  /** Release references before closing or replacing the connection/schema. */
  clear(): void {
    this.statements.clear();
    this.database = null;
  }
}

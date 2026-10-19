// A tiny reimplementation of the slice of the supabase-js query builder that
// the routes actually call (see server/test/fakeSupabase.ts for the in-memory
// equivalent used by tests) — .select/.insert/.update/.upsert with
// .eq/.neq/.gt/.lt/.in filters and an optional .single(), backed by a real
// better-sqlite3 database instead of an in-memory array. Values are always
// bound as parameters; table and column names are interpolated, which is only
// safe because every one of them is a literal in our own route code. Never
// pass a caller-supplied string as a table or column name.
import type Database from "better-sqlite3";

type Op = "eq" | "neq" | "gt" | "lt" | "in";
interface Filter {
  col: string;
  op: Op;
  val: unknown;
}

// SQLite has no boolean type; better-sqlite3 stores/returns 0 and 1. Columns
// listed here are converted to/from JS booleans so callers doing `=== false`
// or JSON-serializing the row see real booleans, matching what Supabase's
// Postgres driver returns.
const BOOL_COLUMNS = new Set(["local"]);

function toSqlValue(col: string, val: unknown): unknown {
  if (BOOL_COLUMNS.has(col)) return val ? 1 : 0;
  return val;
}

function fromSqlRow<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row };
  for (const col of BOOL_COLUMNS) {
    if (col in out) out[col as keyof T] = Boolean(out[col]) as T[keyof T];
  }
  return out;
}

// Postgres unique-violation SQLSTATE. The session-code insert helpers retry on
// this specific code (routes/sessions/, lib/presentHandoff.ts), so a SQLite
// constraint failure has to surface as the same code or a code collision turns
// into a 500 instead of a retry with a fresh code.
const UNIQUE_VIOLATION = "23505";

function toPostgrestError(err: unknown): { message: string; code?: string } {
  const message = (err as Error).message;
  const sqliteCode = (err as { code?: string }).code ?? "";
  if (sqliteCode.startsWith("SQLITE_CONSTRAINT_UNIQUE") || sqliteCode.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")) {
    return { message, code: UNIQUE_VIOLATION };
  }
  return { message };
}

export interface UpsertOptions {
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

type Kind = "select" | "insert" | "update" | "upsert" | "delete";

export class LocalQuery<T = Record<string, unknown>> implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private filters: Filter[] = [];
  private wantSingle = false;
  private wantCount = false;
  private selectCols = "*";

  constructor(
    private db: Database.Database,
    private table: string,
    private kind: Kind,
    private payload?: Record<string, unknown> | Record<string, unknown>[],
    private upsertOpts?: UpsertOptions
  ) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (cols) this.selectCols = cols;
    if (opts?.count === "exact") this.wantCount = true;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push({ col, op: "neq", val });
    return this;
  }
  gt(col: string, val: unknown): this {
    this.filters.push({ col, op: "gt", val });
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push({ col, op: "lt", val });
    return this;
  }
  in(col: string, val: unknown[]): this {
    this.filters.push({ col, op: "in", val });
    return this;
  }
  single(): this {
    this.wantSingle = true;
    return this;
  }

  private whereClause(): { sql: string; params: unknown[] } {
    if (!this.filters.length) return { sql: "", params: [] };
    const parts: string[] = [];
    const params: unknown[] = [];
    const sqlOp: Record<Exclude<Op, "in">, string> = { eq: "=", neq: "!=", gt: ">", lt: "<" };
    for (const f of this.filters) {
      if (f.op === "in") {
        const vals = f.val as unknown[];
        if (!vals.length) {
          parts.push("0"); // IN () matches nothing
          continue;
        }
        parts.push(`${f.col} IN (${vals.map(() => "?").join(",")})`);
        params.push(...vals.map((v) => toSqlValue(f.col, v)));
      } else {
        parts.push(`${f.col} ${sqlOp[f.op]} ?`);
        params.push(toSqlValue(f.col, f.val));
      }
    }
    return { sql: `WHERE ${parts.join(" AND ")}`, params };
  }

  private run(): { data: unknown; error: unknown; count?: number } {
    try {
      if (this.kind === "insert") {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Record<string, unknown>];
        for (const row of rows) {
          const cols = Object.keys(row);
          this.db
            .prepare(`INSERT INTO ${this.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
            .run(...cols.map((c) => toSqlValue(c, row[c])));
        }
        return { data: null, error: null };
      }

      if (this.kind === "upsert") {
        const row = this.payload as Record<string, unknown>;
        const cols = Object.keys(row);
        const conflictCol = this.upsertOpts?.onConflict ?? cols[0];
        const updateCols = cols.filter((c) => c !== conflictCol);
        const action =
          this.upsertOpts?.ignoreDuplicates || !updateCols.length
            ? "DO NOTHING"
            : `DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(", ")}`;
        this.db
          .prepare(
            `INSERT INTO ${this.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) ` +
              `ON CONFLICT (${conflictCol}) ${action}`
          )
          .run(...cols.map((c) => toSqlValue(c, row[c])));
        return { data: null, error: null };
      }

      const { sql: where, params } = this.whereClause();

      if (this.kind === "update") {
        const row = this.payload as Record<string, unknown>;
        const cols = Object.keys(row);
        const set = cols.map((c) => `${c} = ?`).join(", ");
        this.db
          .prepare(`UPDATE ${this.table} SET ${set} ${where}`)
          .run(...cols.map((c) => toSqlValue(c, row[c])), ...params);
        return { data: null, error: null };
      }

      if (this.kind === "delete") {
        this.db.prepare(`DELETE FROM ${this.table} ${where}`).run(...params);
        return { data: null, error: null };
      }

      // select
      if (this.wantCount) {
        const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${this.table} ${where}`).get(...params) as { c: number };
        return { data: null, error: null, count: row.c };
      }
      const colSql = this.selectCols === "*" ? "*" : this.selectCols;
      const rows = (this.db.prepare(`SELECT ${colSql} FROM ${this.table} ${where}`).all(...params) as Record<string, unknown>[]).map(
        fromSqlRow
      );
      if (this.wantSingle) {
        return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "No rows found" } };
      }
      return { data: rows, error: null };
    } catch (err) {
      return { data: null, error: toPostgrestError(err) };
    }
  }

  then<R1 = { data: unknown; error: unknown; count?: number }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown; count?: number }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

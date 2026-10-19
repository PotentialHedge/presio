// A minimal in-memory stand-in for the Supabase client, implementing only the
// query-builder surface that app.ts / socket/ actually use. Cast to
// SupabaseClient at the call site (createApp/registerSocketHandlers) — it is
// structurally compatible for the methods exercised, not the full type.

export interface SessionRow {
  id: string;
  pdf_path?: string;
  pdf_url?: string;
  filename?: string;
  total_slides?: number;
  current_slide?: number;
  note_prefix?: string;
  controller_token?: string;
  passphrase?: string;
  local?: boolean;
  user_id?: string | null;
  expires_at?: string;
  [k: string]: unknown;
}

type Op = "eq" | "neq" | "gt" | "lt" | "in";
type Filter = { col: string; op: Op; val: unknown };

function matches(row: SessionRow, f: Filter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case "eq":
      return v === f.val;
    case "neq":
      return v !== f.val;
    case "gt":
      return (v as never) > (f.val as never);
    case "lt":
      return (v as never) < (f.val as never);
    case "in":
      return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
  }
}

class Query<T = unknown> implements PromiseLike<T> {
  private filters: Filter[] = [];
  private wantSingle = false;
  private wantCount = false;
  private orderSpec?: { col: string; ascending: boolean };

  constructor(
    private rows: SessionRow[],
    private kind: "select" | "insert" | "update" | "delete",
    private payload?: SessionRow | SessionRow[] | Partial<SessionRow>
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count === "exact") this.wantCount = true;
    return this;
  }
  eq(col: string, val: unknown) { this.filters.push({ col, op: "eq", val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ col, op: "neq", val }); return this; }
  gt(col: string, val: unknown) { this.filters.push({ col, op: "gt", val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ col, op: "lt", val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ col, op: "in", val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderSpec = { col, ascending: opts?.ascending ?? true };
    return this;
  }
  single() { this.wantSingle = true; return this; }

  private matched(): SessionRow[] {
    const matched = this.rows.filter((r) => this.filters.every((f) => matches(r, f)));
    if (this.orderSpec) {
      const { col, ascending } = this.orderSpec;
      matched.sort((a, b) => {
        const cmp = a[col] === b[col] ? 0 : (a[col] as never) > (b[col] as never) ? 1 : -1;
        return ascending ? cmp : -cmp;
      });
    }
    return matched;
  }

  private run(): unknown {
    if (this.kind === "insert") {
      const recs = Array.isArray(this.payload) ? this.payload : [this.payload as SessionRow];
      this.rows.push(...recs.map((r) => ({ ...r })));
      return { data: null, error: null };
    }
    const matched = this.matched();
    if (this.kind === "update") {
      for (const r of matched) Object.assign(r, this.payload);
      return { data: null, error: null };
    }
    if (this.kind === "delete") {
      for (const r of matched) {
        const i = this.rows.indexOf(r);
        if (i >= 0) this.rows.splice(i, 1);
      }
      return { data: null, error: null };
    }
    // select
    if (this.wantCount) return { count: matched.length, data: null, error: null };
    if (this.wantSingle) {
      return matched.length
        ? { data: { ...matched[0] }, error: null }
        : { data: null, error: { message: "no rows" } };
    }
    return { data: matched.map((r) => ({ ...r })), error: null };
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run() as T).then(onfulfilled, onrejected);
  }
}

export class FakeSupabase {
  rows: SessionRow[];
  // token -> user id, for auth.getUser
  private tokens = new Map<string, string>();
  uploaded = new Map<string, Buffer>();

  constructor(seed: SessionRow[] = []) {
    this.rows = seed.map((r) => ({ ...r }));
  }

  /** Register a valid access token mapping to a user id. */
  addToken(token: string, userId: string) {
    this.tokens.set(token, userId);
    return this;
  }

  seed(row: SessionRow) {
    this.rows.push({ ...row });
    return this;
  }

  from(_table: string) {
    return {
      select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
        new Query(this.rows, "select").select(cols, opts),
      insert: (payload: SessionRow | SessionRow[]) => new Query(this.rows, "insert", payload),
      update: (payload: Partial<SessionRow>) => new Query(this.rows, "update", payload),
      delete: () => new Query(this.rows, "delete"),
    };
  }

  storage = {
    from: (_bucket: string) => ({
      upload: async (path: string, buffer: Buffer) => {
        this.uploaded.set(path, buffer);
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        for (const p of paths) this.uploaded.delete(p);
        return { data: null, error: null };
      },
      download: async (path: string) => {
        const buf = this.uploaded.get(path);
        if (!buf) return { data: null, error: { message: "not found" } };
        return { data: new Blob([Uint8Array.from(buf)]), error: null };
      },
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `https://storage.test/${path}` },
      }),
    }),
  };

  auth = {
    getUser: async (token: string) => {
      const userId = this.tokens.get(token);
      return userId
        ? { data: { user: { id: userId } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
}

// The one place a frame's call is checked and answered: the method must be in
// the table, the manifest must grant its permission, and whatever the handler
// throws becomes a typed error the frame can branch on.

import { errorOf, resultOf, type CallEnvelope, type ErrorEnvelope, type ResultEnvelope } from "@shared/plugin/protocol";
import { HostError, type Conn, type MethodTable, type Params } from "./types";

export async function dispatch(table: MethodTable, conn: Conn, call: CallEnvelope): Promise<ResultEnvelope | ErrorEnvelope> {
  const spec = Object.hasOwn(table, call.method) ? table[call.method] : undefined;
  if (!spec) {
    return errorOf(call, "MethodNotFound", `Unknown method "${call.method}" (this Presio's plugin API may be older than the plugin's)`);
  }
  if (spec.permission && !conn.plugin.manifest.permissions.includes(spec.permission)) {
    return errorOf(call, "PermissionDenied", `${call.method} needs the "${spec.permission}" permission: add it to "permissions" in presio-plugin.json`);
  }
  const params = (typeof call.params === "object" && call.params !== null ? call.params : {}) as Params;
  try {
    return resultOf(call, (await spec.handler(conn, params)) ?? null);
  } catch (e) {
    if (e instanceof HostError) return errorOf(call, e.code, e.message);
    console.warn(`Plugin "${conn.plugin.id}": ${call.method} failed:`, e);
    return errorOf(call, "Internal", e instanceof Error ? e.message : String(e));
  }
}

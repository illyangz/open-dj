import type { Doc } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";

/** Bearer-secret-hash auth, not Convex Auth: there's no signup, so there's
 * no session/JWT plumbing — a device just proves it knows the secret that
 * hashes to a registered identity's `secretHash`. The raw secret travels
 * over HTTPS on every call (fine, TLS protects it — standard bearer-token
 * shape) but is never persisted anywhere; only its hash is. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function findIdentity(
  ctx: QueryCtx | MutationCtx,
  rawSecret: string,
): Promise<Doc<"identities"> | null> {
  const secretHash = await sha256Hex(rawSecret);
  return await ctx.db
    .query("identities")
    .withIndex("by_secretHash", (q) => q.eq("secretHash", secretHash))
    .unique();
}

export async function requireIdentity(
  ctx: QueryCtx | MutationCtx,
  rawSecret: string,
): Promise<Doc<"identities">> {
  const identity = await findIdentity(ctx, rawSecret);
  if (!identity) throw new Error("unknown identity");
  return identity;
}

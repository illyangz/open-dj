import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { findIdentity, requireIdentity, sha256Hex } from "./lib/auth";

const preferencesValidator = v.object({
  waveformColorMode: v.optional(v.string()),
  waveformCustomColors: v.optional(
    v.object({ low: v.string(), mid: v.string(), high: v.string() }),
  ),
});

/** Idempotent register-or-touch: also how "paste recovery key on a new
 * device" works — the new device just calls this with the imported secret
 * and gets back the same identity rather than going through a separate
 * claim flow. */
export const register = mutation({
  args: { rawSecret: v.string() },
  handler: async (ctx, { rawSecret }) => {
    const existing = await findIdentity(ctx, rawSecret);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
      return { identityId: existing._id, username: existing.username ?? null };
    }
    const secretHash = await sha256Hex(rawSecret);
    const identityId = await ctx.db.insert("identities", {
      secretHash,
      preferences: {},
      createdAt: now,
      lastSeenAt: now,
    });
    return { identityId, username: null };
  },
});

export const touch = mutation({
  args: { rawSecret: v.string() },
  handler: async (ctx, { rawSecret }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    await ctx.db.patch(identity._id, { lastSeenAt: Date.now() });
  },
});

export const setUsername = mutation({
  args: { rawSecret: v.string(), username: v.string() },
  handler: async (ctx, { rawSecret, username }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    await ctx.db.patch(identity._id, { username });
  },
});

export const setPreferences = mutation({
  args: { rawSecret: v.string(), preferences: preferencesValidator },
  handler: async (ctx, { rawSecret, preferences }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    await ctx.db.patch(identity._id, { preferences });
  },
});

export const getPreferences = query({
  args: { rawSecret: v.string() },
  handler: async (ctx, { rawSecret }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    return { username: identity.username ?? null, preferences: identity.preferences };
  },
});

/** Fully public — powers @mention autocomplete, which has to work while
 * composing, before the caller has necessarily done anything identity-
 * requiring yet. Case-sensitive prefix match on `by_username`, matching
 * how `lib/mentions.ts`'s resolution is also case-sensitive. */
export const searchUsernames = query({
  args: { prefix: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { prefix, limit }) => {
    if (!prefix) return [];
    const rows = await ctx.db
      .query("identities")
      .withIndex("by_username", (q) => q.gte("username", prefix).lt("username", `${prefix}￿`))
      .take(limit ?? 8);
    return rows.map((r) => r.username).filter((u): u is string => !!u);
  },
});

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/auth";

const cueValidator = v.object({
  slot: v.number(),
  positionMs: v.number(),
  label: v.optional(v.string()),
  color: v.optional(v.string()),
});

export const push = mutation({
  args: {
    rawSecret: v.string(),
    checksum: v.string(),
    bpm: v.optional(v.number()),
    musicalKey: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    cues: v.array(cueValidator),
  },
  handler: async (ctx, { rawSecret, checksum, bpm, musicalKey, durationMs, cues }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    const existing = await ctx.db
      .query("trackStates")
      .withIndex("by_identity_checksum", (q) =>
        q.eq("identityId", identity._id).eq("checksum", checksum),
      )
      .unique();

    const patch = { bpm, musicalKey, durationMs, cues, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("trackStates", { identityId: identity._id, checksum, ...patch });
    }
  },
});

export const pull = query({
  args: { rawSecret: v.string(), checksum: v.string() },
  handler: async (ctx, { rawSecret, checksum }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    const row = await ctx.db
      .query("trackStates")
      .withIndex("by_identity_checksum", (q) =>
        q.eq("identityId", identity._id).eq("checksum", checksum),
      )
      .unique();
    if (!row) return null;
    return {
      bpm: row.bpm ?? null,
      musicalKey: row.musicalKey ?? null,
      durationMs: row.durationMs ?? null,
      cues: row.cues,
      updatedAt: row.updatedAt,
    };
  },
});

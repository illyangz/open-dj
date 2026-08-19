import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/auth";
import { toFeedShape } from "./lib/feed";

export const listMentioningMe = query({
  args: { rawSecret: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { rawSecret, limit }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    const rows = await ctx.db
      .query("mentions")
      .withIndex("by_mentioned", (q) => q.eq("mentionedIdentityId", identity._id))
      .order("desc")
      .take(limit ?? 50);

    const items = await Promise.all(
      rows.map(async (row) => {
        const item = await ctx.db.get(row.itemId);
        return item ? toFeedShape(ctx, item) : null;
      }),
    );
    return items.filter((x): x is NonNullable<typeof x> => x !== null);
  },
});

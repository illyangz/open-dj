import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/auth";

export const toggle = mutation({
  args: { rawSecret: v.string(), itemId: v.id("sharedItems") },
  handler: async (ctx, { rawSecret, itemId }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    const item = await ctx.db.get(itemId);
    if (!item) throw new Error("item not found");

    const existing = await ctx.db
      .query("upvotes")
      .withIndex("by_item_identity", (q) =>
        q.eq("itemId", itemId).eq("identityId", identity._id),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      const upvoteCount = Math.max(0, item.upvoteCount - 1);
      await ctx.db.patch(itemId, { upvoteCount });
      return { upvoted: false, upvoteCount };
    }

    await ctx.db.insert("upvotes", { itemId, identityId: identity._id, createdAt: Date.now() });
    const upvoteCount = item.upvoteCount + 1;
    await ctx.db.patch(itemId, { upvoteCount });
    return { upvoted: true, upvoteCount };
  },
});

export const myUpvotedItemIds = query({
  args: { rawSecret: v.string() },
  handler: async (ctx, { rawSecret }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    const rows = await ctx.db
      .query("upvotes")
      .withIndex("by_identity", (q) => q.eq("identityId", identity._id))
      .collect();
    return rows.map((r) => r.itemId);
  },
});

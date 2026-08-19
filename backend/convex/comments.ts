import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/auth";

export const add = mutation({
  args: { rawSecret: v.string(), itemId: v.id("sharedItems"), text: v.string() },
  handler: async (ctx, { rawSecret, itemId, text }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("comment text required");
    if (!(await ctx.db.get(itemId))) throw new Error("item not found");
    return await ctx.db.insert("comments", {
      itemId,
      authorId: identity._id,
      text: trimmed,
      createdAt: Date.now(),
    });
  },
});

/** Fully public — same as `sharedItems.listFeed`, reading comments needs
 * no identity. */
export const list = query({
  args: { itemId: v.id("sharedItems"), limit: v.optional(v.number()) },
  handler: async (ctx, { itemId, limit }) => {
    const rows = await ctx.db
      .query("comments")
      .withIndex("by_item", (q) => q.eq("itemId", itemId))
      .order("asc")
      .take(limit ?? 100);
    return Promise.all(
      rows.map(async (row) => {
        const author = await ctx.db.get(row.authorId);
        return {
          id: row._id,
          text: row.text,
          createdAt: row.createdAt,
          authorUsername: author?.username ?? null,
        };
      }),
    );
  },
});

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/auth";
import { parseMentions } from "./lib/mentions";
import { toFeedShape } from "./lib/feed";

const trackValidator = v.object({
  title: v.string(),
  artist: v.optional(v.string()),
  bpm: v.optional(v.number()),
  musicalKey: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
});

export const share = mutation({
  args: {
    rawSecret: v.string(),
    kind: v.union(v.literal("crate"), v.literal("song"), v.literal("post")),
    title: v.optional(v.string()),
    caption: v.optional(v.string()),
    tracks: v.array(trackValidator),
  },
  handler: async (ctx, { rawSecret, kind, title, caption, tracks }) => {
    const identity = await requireIdentity(ctx, rawSecret);
    // A plain post has no tracks — its caption is the entire content.
    // Crate/song shares are pointless without at least one track.
    if (kind !== "post" && tracks.length === 0) throw new Error("at least one track required");
    if (kind === "post" && !caption) throw new Error("a post needs a caption");
    const now = Date.now();
    const itemId = await ctx.db.insert("sharedItems", {
      authorId: identity._id,
      kind,
      title,
      caption,
      tracks,
      upvoteCount: 0,
      createdAt: now,
    });

    if (caption) {
      for (const username of parseMentions(caption)) {
        // `.first()` not `.unique()` — usernames aren't enforced unique by
        // `setUsername`, so a collision resolves to whichever identity
        // claimed it first rather than throwing.
        const mentioned = await ctx.db
          .query("identities")
          .withIndex("by_username", (q) => q.eq("username", username))
          .first();
        if (mentioned && mentioned._id !== identity._id) {
          await ctx.db.insert("mentions", {
            itemId,
            mentionedIdentityId: mentioned._id,
            mentioningIdentityId: identity._id,
            createdAt: now,
          });
        }
      }
    }
    return itemId;
  },
});

/** Fully public — no `rawSecret`. Browsing the community feed requires no
 * identity at all, only sharing/upvoting does. */
export const listFeed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const items = await ctx.db
      .query("sharedItems")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit ?? 50);
    return Promise.all(items.map((item) => toFeedShape(ctx, item)));
  },
});

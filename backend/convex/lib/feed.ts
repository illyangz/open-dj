import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Shared item→feed-shape join (author username lookup), used by both
 * `sharedItems.listFeed` and `mentions.listMentioningMe` so the two feeds
 * render identically on the frontend. */
export async function toFeedShape(ctx: QueryCtx, item: Doc<"sharedItems">) {
  const author = await ctx.db.get(item.authorId);
  return {
    id: item._id,
    kind: item.kind,
    title: item.title ?? null,
    caption: item.caption ?? null,
    tracks: item.tracks,
    upvoteCount: item.upvoteCount,
    createdAt: item.createdAt,
    authorUsername: author?.username ?? null,
  };
}

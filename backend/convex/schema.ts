import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Anonymous, no-signup identity: a device registers itself with the hash
  // of a locally-generated secret. The raw secret is never stored — only
  // its hash, looked up on every call to authorize it. `identityId` (this
  // table's own Convex `Id`) is the natural "author" reference a future
  // community-sharing table (crates/playlists/upvotes/mentions) would
  // point at; nothing here needs to change to support that later.
  identities: defineTable({
    secretHash: v.string(),
    username: v.optional(v.string()),
    preferences: v.object({
      waveformColorMode: v.optional(v.string()),
      waveformCustomColors: v.optional(
        v.object({ low: v.string(), mid: v.string(), high: v.string() }),
      ),
    }),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_secretHash", ["secretHash"])
    .index("by_username", ["username"]),

  // Per-track cloud cache, private to one identity. Keyed by content
  // checksum (not file path) so it's portable across renames and across a
  // user's different devices, where the same track may live at a
  // different absolute path.
  trackStates: defineTable({
    identityId: v.id("identities"),
    checksum: v.string(),
    bpm: v.optional(v.number()),
    musicalKey: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    cues: v.array(
      v.object({
        slot: v.number(),
        positionMs: v.number(),
        label: v.optional(v.string()),
        color: v.optional(v.string()),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_identity_checksum", ["identityId", "checksum"]),

  // A crate-share, a song-share, or a plain text post, discriminated by
  // `kind`. Crate/song both carry the same `tracks` shape — a song-share
  // always has exactly one entry with `sourceUrl` set (a manually pasted
  // link); a crate-share has one entry per crate track, with `sourceUrl`
  // set whenever the desktop app can resolve it (the track was downloaded
  // through this app — joined from its own local jobs/inputs tables — not
  // just scanned/dropped into the library, in which case it's omitted). A
  // "post" has an empty `tracks` array and no `title` — its `caption` is
  // the entire content. No separate "Playlist" table: this app's `Crate`
  // already is a named ordered track list.
  sharedItems: defineTable({
    authorId: v.id("identities"),
    kind: v.union(v.literal("crate"), v.literal("song"), v.literal("post")),
    title: v.optional(v.string()),
    caption: v.optional(v.string()), // may contain @username mentions
    tracks: v.array(
      v.object({
        title: v.string(),
        artist: v.optional(v.string()),
        bpm: v.optional(v.number()),
        musicalKey: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
      }),
    ),
    upvoteCount: v.number(), // denormalized, kept in sync in upvotes.toggle
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_author", ["authorId", "createdAt"]),

  // One row per (item, identity) upvote — toggleable, so existence = upvoted.
  upvotes: defineTable({
    itemId: v.id("sharedItems"),
    identityId: v.id("identities"),
    createdAt: v.number(),
  })
    .index("by_item_identity", ["itemId", "identityId"])
    .index("by_identity", ["identityId"]),

  // One row per @username match found in a share's caption at share-time —
  // mentions only ever come from a share's own caption, not from comments
  // (kept simple: comments aren't scanned for mentions in this pass).
  mentions: defineTable({
    itemId: v.id("sharedItems"),
    mentionedIdentityId: v.id("identities"),
    mentioningIdentityId: v.id("identities"),
    createdAt: v.number(),
  }).index("by_mentioned", ["mentionedIdentityId", "createdAt"]),

  // Flat (non-nested) comments on a shared item — Reddit-lite, not a full
  // threaded reply system. One level only: comments reply to the item,
  // never to each other.
  comments: defineTable({
    itemId: v.id("sharedItems"),
    authorId: v.id("identities"),
    text: v.string(),
    createdAt: v.number(),
  }).index("by_item", ["itemId", "createdAt"]),
});

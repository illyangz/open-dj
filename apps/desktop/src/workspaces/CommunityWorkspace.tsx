import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import { MentionTextarea } from "../components/MentionTextarea";
import { UsernameWidget } from "../components/UsernameWidget";
import type { Crate, CommunityComment, CommunityItem, SharedItemKind } from "../types";

const MENTION_RE = /(@[a-zA-Z0-9_]{2,32})/g; // mirrors backend/convex/lib/mentions.ts

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Loose title match for "add a shared crate to my library" — crate
 * shares carry no source URLs (see `community_commands.rs`), so the best
 * this can do is find tracks the user already has locally that look like
 * the same song, not fetch anything new. */
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Splits a caption on @mention tokens for rendering — purely visual, the
 * actual mention resolution (matching against real usernames) already
 * happened server-side at share time (`backend/convex/lib/mentions.ts`),
 * so this doesn't need to know which @tokens are "real". */
function Caption({ text }: { text: string }) {
  const parts = text.split(MENTION_RE);
  return (
    <p className="text-sm text-parchment-dim whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        MENTION_RE.test(part) ? (
          <span key={i} className="text-teal font-medium">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

/** FR-not-numbered: an anonymous, no-signup community feed layered on the
 * same device identity the cloud sync feature uses (Settings → Sync) —
 * share a local crate's track list (metadata only, never audio), a
 * manually pasted song link, or a plain text post; upvote; comment; and
 * see who @mentioned you. A username is required to post/comment/upvote
 * (not to read) — set once via the gate below or the sidebar's identity
 * chip, changeable anytime. */
export function CommunityWorkspace() {
  const settings = useAppStore((s) => s.settings);

  if (!settings?.username) {
    return (
      <div className="flex-1 min-w-0 overflow-y-auto p-6">
        <h1 className="font-display font-semibold text-xl">Community</h1>
        <div className="mt-6">
          <UsernameWidget />
        </div>
      </div>
    );
  }

  return <CommunityFeed />;
}

function CommunityFeed() {
  const [tab, setTab] = useState<"feed" | "mentions">("feed");
  const [feed, setFeed] = useState<CommunityItem[]>([]);
  const [mentions, setMentions] = useState<CommunityItem[]>([]);
  const [mentionsLoaded, setMentionsLoaded] = useState(false);
  const [myUpvotedIds, setMyUpvotedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [crates, setCrates] = useState<Crate[]>([]);
  const [shareMode, setShareMode] = useState<SharedItemKind>("crate");
  const [selectedCrateId, setSelectedCrateId] = useState<string | null>(null);
  const [songUrl, setSongUrl] = useState("");
  const [songTitle, setSongTitle] = useState("");
  const [songArtist, setSongArtist] = useState("");
  const [caption, setCaption] = useState("");
  const [posting, setPosting] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [feedResult, upvoted] = await Promise.all([api.listCommunityFeed(), api.listMyUpvotes()]);
      setFeed(feedResult);
      setMyUpvotedIds(new Set(upvoted));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadMentions() {
    try {
      setMentions(await api.listCommunityMentions());
      setMentionsLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    api.listCrates().then((result) => {
      setCrates(result);
      if (result.length > 0) setSelectedCrateId(result[0].id);
    });
    void refresh();
  }, []);

  function selectTab(next: "feed" | "mentions") {
    setTab(next);
    if (next === "mentions" && !mentionsLoaded) void loadMentions();
  }

  async function submitShare() {
    setPosting(true);
    setError(null);
    try {
      if (shareMode === "crate") {
        if (!selectedCrateId) return;
        await api.shareCrateToCommunity(selectedCrateId, caption.trim() || undefined);
      } else if (shareMode === "song") {
        if (!songUrl.trim() || !songTitle.trim()) return;
        await api.shareSongToCommunity(
          songUrl.trim(),
          songTitle.trim(),
          songArtist.trim() || undefined,
          caption.trim() || undefined,
        );
      } else {
        if (!caption.trim()) return;
        await api.sharePostToCommunity(caption.trim());
      }
      setCaption("");
      setSongUrl("");
      setSongTitle("");
      setSongArtist("");
      await refresh();
      if (mentionsLoaded) await loadMentions();
    } catch (e) {
      setError(String(e));
    } finally {
      setPosting(false);
    }
  }

  function patchItem(itemId: string, upvoteCount: number) {
    setFeed((prev) => prev.map((i) => (i.id === itemId ? { ...i, upvote_count: upvoteCount } : i)));
    setMentions((prev) => prev.map((i) => (i.id === itemId ? { ...i, upvote_count: upvoteCount } : i)));
  }

  async function toggleUpvote(item: CommunityItem) {
    try {
      const result = await api.toggleCommunityUpvote(item.id);
      patchItem(item.id, result.upvote_count);
      setMyUpvotedIds((prev) => {
        const next = new Set(prev);
        if (result.upvoted) next.add(item.id);
        else next.delete(item.id);
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function addSongToLibrary(item: CommunityItem) {
    const track = item.tracks[0];
    if (!track?.source_url) return;
    await useAppStore.getState().ingest(track.source_url);
    setStatusMsg(`Queued "${track.title}" for download — check the Queue tab.`);
  }

  async function addCrateToLibrary(item: CommunityItem) {
    const jobs = useAppStore.getState().jobs.filter((j) => j.state === "complete" && j.destination);
    const created = await api.createCrate(item.title ?? "Shared crate");
    let matched = 0;
    for (const t of item.tracks) {
      const want = normalizeTitle(t.title);
      const job = jobs.find((j) => j.title && normalizeTitle(j.title) === want);
      if (job?.destination) {
        await api.addTrackToCrate(created.id, job.destination);
        matched++;
      }
    }
    setStatusMsg(
      matched === 0
        ? `Created crate "${created.name}" — none of its ${item.tracks.length} tracks were found in your library yet.`
        : `Created crate "${created.name}" — matched ${matched} of ${item.tracks.length} tracks already in your library.`,
    );
  }

  const items = tab === "feed" ? feed : mentions;
  const canSubmit =
    shareMode === "crate"
      ? !!selectedCrateId
      : shareMode === "song"
        ? songUrl.trim() !== "" && songTitle.trim() !== ""
        : caption.trim() !== "";

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6">
      <h1 className="font-display font-semibold text-xl">Community</h1>
      <p className="text-sm text-parchment-dim mt-1 max-w-lg">
        Share a crate, a song link, or just a post — upvote what's good, comment, and see who
        @mentioned you.
      </p>

      <div className="mt-6 w-full max-w-[1600px] rounded-lg border border-charcoal-700 bg-charcoal-800/40 p-4">
        <div className="flex items-center gap-1.5">
          {(["crate", "song", "post"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setShareMode(mode)}
              className={[
                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors capitalize",
                shareMode === mode
                  ? "bg-signal text-charcoal-950"
                  : "border border-charcoal-700 text-parchment-dim hover:text-parchment",
              ].join(" ")}
            >
              {mode === "crate" ? "Share a Crate" : mode === "song" ? "Share a Song" : "Post"}
            </button>
          ))}
        </div>

        {shareMode === "crate" && (
          <div className="mt-3">
            {crates.length === 0 ? (
              <p className="text-xs text-parchment-dim">No crates yet — create one in Crates first.</p>
            ) : (
              <select
                value={selectedCrateId ?? ""}
                onChange={(e) => setSelectedCrateId(e.target.value)}
                className="rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm w-full max-w-xs"
              >
                {crates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {shareMode === "song" && (
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={songUrl}
              onChange={(e) => setSongUrl(e.target.value)}
              placeholder="https://…"
              className="flex-1 min-w-[220px] rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm font-mono"
            />
            <input
              value={songTitle}
              onChange={(e) => setSongTitle(e.target.value)}
              placeholder="Title"
              className="w-48 rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm"
            />
            <input
              value={songArtist}
              onChange={(e) => setSongArtist(e.target.value)}
              placeholder="Artist (optional)"
              className="w-48 rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-1.5 text-sm"
            />
          </div>
        )}

        <div className="mt-3">
          <MentionTextarea
            value={caption}
            onChange={setCaption}
            placeholder={
              shareMode === "post"
                ? "What's on your mind? @mention a username to notify them"
                : "Say something… @mention a username to notify them"
            }
            rows={shareMode === "post" ? 3 : 2}
            className="w-full rounded-lg bg-charcoal-800/60 border border-charcoal-700 px-3 py-2 text-sm resize-none"
          />
        </div>

        <div className="mt-3 flex justify-end">
          <button
            onClick={() => void submitShare()}
            disabled={posting || !canSubmit}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim disabled:opacity-30 transition-colors"
          >
            {posting ? "Posting…" : "Post"}
          </button>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between max-w-[1600px]">
        <div className="flex items-center gap-1 rounded-full border border-charcoal-700 p-0.5">
          <button
            onClick={() => selectTab("feed")}
            className={[
              "px-3 py-1 rounded-full text-xs font-medium transition-colors",
              tab === "feed" ? "bg-charcoal-700 text-signal" : "text-parchment-dim hover:text-parchment",
            ].join(" ")}
          >
            Feed
          </button>
          <button
            onClick={() => selectTab("mentions")}
            className={[
              "px-3 py-1 rounded-full text-xs font-medium transition-colors",
              tab === "mentions" ? "bg-charcoal-700 text-signal" : "text-parchment-dim hover:text-parchment",
            ].join(" ")}
          >
            Mentioning me
          </button>
        </div>
        <button onClick={() => void refresh()} className="text-xs text-parchment-dim hover:text-parchment">
          Refresh
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-red-400 max-w-[1600px]">{error}</p>}
      {statusMsg && <p className="mt-3 text-xs text-teal max-w-[1600px]">{statusMsg}</p>}

      <ul className="mt-4 w-full max-w-[1600px] space-y-2">
        {loading && items.length === 0 ? (
          <li className="text-sm text-parchment-dim">Loading…</li>
        ) : items.length === 0 ? (
          <li className="text-sm text-parchment-dim">
            {tab === "feed" ? "Nothing shared yet — be the first." : "No one has @mentioned you yet."}
          </li>
        ) : (
          items.map((item) => (
            <CommunityItemCard
              key={item.id}
              item={item}
              upvoted={myUpvotedIds.has(item.id)}
              onToggleUpvote={() => void toggleUpvote(item)}
              onAddSong={() => void addSongToLibrary(item)}
              onAddCrate={() => void addCrateToLibrary(item)}
            />
          ))
        )}
      </ul>
    </div>
  );
}

function CommunityItemCard({
  item,
  upvoted,
  onToggleUpvote,
  onAddSong,
  onAddCrate,
}: {
  item: CommunityItem;
  upvoted: boolean;
  onToggleUpvote: () => void;
  onAddSong: () => void;
  onAddCrate: () => void;
}) {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [commentsLoaded, setCommentsLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  async function loadComments() {
    try {
      setComments(await api.listCommunityComments(item.id));
      setCommentsLoaded(true);
    } catch {
      // best-effort — comments are supplementary, not worth surfacing an error banner for
    }
  }

  function toggleComments() {
    setCommentsOpen((v) => !v);
    if (!commentsLoaded) void loadComments();
  }

  async function submitComment() {
    if (!draft.trim()) return;
    setPosting(true);
    try {
      await api.addCommunityComment(item.id, draft.trim());
      setDraft("");
      await loadComments();
    } catch {
      // surfaced implicitly by the comment just not appearing; keeping this
      // lightweight rather than adding a second error-banner state per card
    } finally {
      setPosting(false);
    }
  }

  return (
    <li className="rounded-lg border border-charcoal-700 bg-charcoal-800/40 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={[
                "px-1.5 py-0.5 rounded text-[10px] font-mono uppercase",
                item.kind === "crate"
                  ? "bg-teal/10 text-teal"
                  : item.kind === "song"
                    ? "bg-amber/10 text-amber"
                    : "bg-parchment-dim/10 text-parchment-dim",
              ].join(" ")}
            >
              {item.kind}
            </span>
            {item.title && <p className="text-sm font-semibold truncate">{item.title}</p>}
          </div>
          <p className="text-[11px] text-parchment-dim/70 mt-0.5">
            {item.author_username ? `@${item.author_username}` : "Anonymous"} · {relativeTime(item.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {item.kind === "song" && (
            <button
              onClick={onAddSong}
              title="Download this track"
              className="w-7 h-7 rounded-full border border-charcoal-700 text-parchment-dim hover:text-signal hover:border-signal/60 flex items-center justify-center transition-colors"
            >
              +
            </button>
          )}
          {item.kind === "crate" && (
            <button
              onClick={onAddCrate}
              title="Add to your crates (matches tracks you already have)"
              className="w-7 h-7 rounded-full border border-charcoal-700 text-parchment-dim hover:text-signal hover:border-signal/60 flex items-center justify-center transition-colors"
            >
              +
            </button>
          )}
          <button
            onClick={onToggleUpvote}
            className={[
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
              upvoted ? "border-signal bg-signal/10 text-signal" : "border-charcoal-700 text-parchment-dim hover:text-parchment",
            ].join(" ")}
          >
            <span>▲</span>
            {item.upvote_count}
          </button>
        </div>
      </div>

      {item.caption && (
        <div className="mt-2">
          <Caption text={item.caption} />
        </div>
      )}

      {item.tracks.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {item.tracks.slice(0, 5).map((t, i) => (
            <li key={i} className="text-xs font-mono text-parchment-dim truncate">
              {t.title}
              {t.artist && <span className="opacity-70"> — {t.artist}</span>}
              {t.source_url && (
                <a href={t.source_url} target="_blank" rel="noreferrer" className="ml-2 text-teal hover:underline">
                  link
                </a>
              )}
            </li>
          ))}
          {item.tracks.length > 5 && (
            <li className="text-xs text-parchment-dim/60">+{item.tracks.length - 5} more</li>
          )}
        </ul>
      )}

      <button onClick={toggleComments} className="mt-2 text-[11px] text-parchment-dim hover:text-parchment">
        {commentsOpen ? "Hide comments" : commentsLoaded ? `${comments.length} comment(s)` : "Comments"}
      </button>

      {commentsOpen && (
        <div className="mt-2 pt-2 border-t border-charcoal-700/60 space-y-2">
          {comments.length === 0 ? (
            <p className="text-xs text-parchment-dim/60">No comments yet.</p>
          ) : (
            comments.map((c) => (
              <div key={c.id} className="text-xs">
                <span className="text-teal font-medium">{c.author_username ? `@${c.author_username}` : "Anonymous"}</span>{" "}
                <span className="text-parchment-dim/70">· {relativeTime(c.created_at)}</span>
                <div className="text-parchment-dim">{c.text}</div>
              </div>
            ))
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <MentionTextarea
                value={draft}
                onChange={setDraft}
                placeholder="Add a comment…"
                rows={1}
                className="w-full rounded-md bg-charcoal-900 border border-charcoal-700 px-2 py-1.5 text-xs resize-none"
              />
            </div>
            <button
              onClick={() => void submitComment()}
              disabled={posting || !draft.trim()}
              className="px-2.5 py-1.5 rounded-md text-xs font-semibold bg-signal text-charcoal-950 hover:bg-signal-dim disabled:opacity-30 transition-colors"
            >
              Reply
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

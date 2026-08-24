import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

/** Single <audio> element mounted at the App root, never unmounted by
 * workspace tab switches. Reads player state from the global store and
 * syncs the HTMLAudioElement's src/play/pause/seek to match. */
export function GlobalAudioElement() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const current = useAppStore((s) => s.player.current);
  const isPlaying = useAppStore((s) => s.player.isPlaying);
  const seekPos = useAppStore((s) => s.player.position);
  const setPlayerPosition = useAppStore((s) => s.setPlayerPosition);
  const setPlayerDuration = useAppStore((s) => s.setPlayerDuration);
  const togglePlay = useAppStore((s) => s.togglePlay);
  const next = useAppStore((s) => s.next);

  // Load track when current changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (current) {
      const src = convertFileSrc(current.destination);
      if (audio.src !== src) {
        audio.src = src;
        audio.load();
      }
      void audio.play();
    } else {
      audio.pause();
      audio.removeAttribute("src");
    }
  }, [current?.destination]);

  // Sync play/pause
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (isPlaying) {
      void audio.play();
    } else {
      audio.pause();
    }
  }, [isPlaying, current]);

  // Sync seek position (from store -> audio) — only when the user explicitly
  // seeks (e.g. from PlayerBar scrubber), not on every animation frame.
  const lastSeekRef = useRef(0);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    // Only seek if the position differs significantly from where the audio
    // actually is (prevents feedback loop from the animation frame sync).
    if (Math.abs(audio.currentTime - seekPos) > 0.5) {
      audio.currentTime = seekPos;
      lastSeekRef.current = seekPos;
    }
  }, [seekPos, current]);

  // Mirror audio element events into store
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      setPlayerPosition(audio.currentTime);
    };
    const onLoadedMetadata = () => {
      setPlayerDuration(audio.duration);
    };
    const onEnded = () => {
      // Auto-advance to next track
      const { player } = useAppStore.getState();
      const idx = player.contextQueue.findIndex(
        (t) => t.jobId === player.current?.jobId,
      );
      if (idx >= 0 && idx < player.contextQueue.length - 1) {
        next();
      } else {
        togglePlay(); // stop at end
      }
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, [next, togglePlay, setPlayerPosition, setPlayerDuration]);

  return <audio ref={audioRef} className="hidden" />;
}

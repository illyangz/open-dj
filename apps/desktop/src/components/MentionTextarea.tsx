import { useRef, useState } from "react";
import { api } from "../lib/api";

const TRAILING_MENTION_RE = /@([a-zA-Z0-9_]{1,32})$/;

/** A plain textarea with @mention autocomplete — typing `@partial` queries
 * `searchCommunityUsernames` (debounced) and shows a dropdown of matches
 * below the field; picking one splices `@username ` in at the cursor.
 * Deliberately positioned below the whole field rather than at the exact
 * cursor coordinate — precise caret-position popovers in a plain textarea
 * need character-width measurement/mirroring that isn't worth the
 * complexity here. */
export function MentionTextarea({
  value,
  onChange,
  placeholder,
  rows = 2,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onChange(next);

    const pos = e.target.selectionStart;
    const match = TRAILING_MENTION_RE.exec(next.slice(0, pos));
    if (!match) {
      setOpen(false);
      setSuggestions([]);
      return;
    }
    const query = match[1];
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      api
        .searchCommunityUsernames(query)
        .then((result) => {
          setSuggestions(result);
          setOpen(result.length > 0);
        })
        .catch(() => setOpen(false));
    }, 150);
  }

  function selectSuggestion(username: string) {
    const el = textareaRef.current;
    const pos = el?.selectionStart ?? value.length;
    const match = TRAILING_MENTION_RE.exec(value.slice(0, pos));
    if (!match) return;
    const start = pos - match[0].length;
    const next = `${value.slice(0, start)}@${username} ${value.slice(pos)}`;
    onChange(next);
    setOpen(false);
    setSuggestions([]);
    requestAnimationFrame(() => {
      el?.focus();
      const newPos = start + username.length + 2;
      el?.setSelectionRange(newPos, newPos);
    });
  }

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
      {open && (
        <div className="absolute left-0 right-0 mt-1 z-20 rounded-lg border border-charcoal-700 bg-charcoal-800 shadow-xl py-1 max-h-40 overflow-y-auto">
          {suggestions.map((u) => (
            <button
              key={u}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectSuggestion(u)}
              className="w-full text-left px-3 py-1.5 text-xs font-mono text-parchment hover:bg-charcoal-700"
            >
              @{u}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

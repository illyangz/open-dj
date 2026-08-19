/** Extracts unique @username tokens from a caption. Case-sensitive on
 * purpose — `identities.setUsername` stores the raw string with no
 * normalization, so a `by_username` lookup has to match verbatim. */
const MENTION_RE = /@([a-zA-Z0-9_]{2,32})/g;

export function parseMentions(caption: string): string[] {
  const found = new Set<string>();
  for (const match of caption.matchAll(MENTION_RE)) found.add(match[1]);
  return [...found];
}

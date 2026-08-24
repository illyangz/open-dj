const SERATO_KEY_COLORS: Record<string, string> = {
  "1A": "#65DD9A", "1B": "#3E8F65",
  "2A": "#88FF65", "2B": "#5CB845",
  "3A": "#BAFF52", "3B": "#80B936",
  "4A": "#FFE74D", "4B": "#B6A032",
  "5A": "#F89A45", "5B": "#AC6B2E",
  "6A": "#FA7442", "6B": "#AC502D",
  "7A": "#F15953", "7B": "#A83E39",
  "8A": "#F754F0", "8B": "#AB39A7",
  "9A": "#AC6DFF", "9B": "#764AB4",
  "10A": "#5690FF", "10B": "#3A63B3",
  "11A": "#5FD0FF", "11B": "#3E8FB5",
  "12A": "#6FF2F2", "12B": "#48A3A4",
};

const REKORDBOX_GREEN = "#2BEDB2";

function normalizeCamelot(camelot: string): string {
  const trimmed = camelot.trim();
  if (trimmed.length < 2) return trimmed.toUpperCase();
  const numPart = trimmed.slice(0, -1);
  const letterPart = trimmed.slice(-1).toUpperCase();
  return `${numPart}${letterPart}`;
}

function parseCamelot(camelot: string): { num: number; letter: string } {
  const normalized = normalizeCamelot(camelot);
  const letter = normalized.slice(-1);
  const num = parseInt(normalized.slice(0, -1), 10) || 0;
  return { num, letter };
}

export function seratoKeyColor(camelot: string): string {
  const normalized = normalizeCamelot(camelot);
  return SERATO_KEY_COLORS[normalized] ?? "#666666";
}

export function isHarmonicallyCompatible(masterKey: string, targetKey: string): boolean {
  const master = normalizeCamelot(masterKey);
  const target = normalizeCamelot(targetKey);

  if (master === target) return true;

  const m = parseCamelot(master);
  const t = parseCamelot(target);

  if (m.num === t.num && m.letter !== t.letter) return true;

  if (m.letter === t.letter) {
    const diff = Math.abs(m.num - t.num);
    if (diff === 1) return true;
    if ((m.num === 12 && t.num === 1) || (m.num === 1 && t.num === 12)) return true;
  }

  return false;
}

export function rekordboxKeyColor(masterKey: string, targetKey: string): string {
  if (isHarmonicallyCompatible(masterKey, targetKey)) {
    return REKORDBOX_GREEN;
  }
  return "#D4C5A9";
}

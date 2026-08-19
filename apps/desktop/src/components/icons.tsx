type IconProps = { className?: string };

const base = "w-[18px] h-[18px]";

export function QueueIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path d="M4 6h16M4 12h10M4 18h16" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.5-4.5" strokeLinecap="round" />
    </svg>
  );
}

export function RepairIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path
        d="M14.5 6.5a3.5 3.5 0 0 0-4.8 4.3L4 16.5V20h3.5l5.7-5.7a3.5 3.5 0 0 0 4.3-4.8l-2.6 2.6-2-2 2.6-2.6Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LibraryIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5v-13ZM14 4h4.5A1.5 1.5 0 0 1 20 5.5v13A1.5 1.5 0 0 1 18.5 20H14V4Z" />
    </svg>
  );
}

export function AutomationIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path d="M13 3 5 13h5l-1 8 8-10h-5l1-8Z" strokeLinejoin="round" />
    </svg>
  );
}

export function SettingsIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a7.9 7.9 0 0 0 0-3l2-1.4-2-3.4-2.3.9a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.6a7.7 7.7 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.4a7.9 7.9 0 0 0 0 3l-2 1.4 2 3.4 2.3-.9c.75.65 1.64 1.16 2.6 1.5l.5 2.6h4l.5-2.6a7.7 7.7 0 0 0 2.6-1.5l2.3.9 2-3.4-2-1.4Z" />
    </svg>
  );
}

export function DropIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path d="M12 3v13m0 0-4-4m4 4 4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Official SoundCloud mark (from /public/soundcloud-logo.svg, provided by
// user), inlined rather than referenced via <img> so its `currentColor`
// fills pick up the same lime-active/dim-inactive nav state as every other
// icon here — an <img>'d SVG renders in its own color context and can't see
// the surrounding button's text color. The source animates in on load
// (waveform bars sliding up, cloud outline drawing); stripped since this
// renders as a static nav icon, not a one-time reveal.
export function SoundcloudIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <g fill="currentColor">
        <path d="M0.74 15.94c0 0.17 -0.13 0.26 -0.26 0.26c-0.13 0 -0.26 -0.09 -0.26 -0.26c-0.11 -0.63 -0.2 -1.21 -0.22 -1.79c-0.01 -0.57 0.04 -1.15 0.21 -1.78c0.02 -0.17 0.15 -0.25 0.28 -0.25c0.13 0 0.26 0.08 0.28 0.25c0.2 0.63 0.26 1.21 0.24 1.78c-0.02 0.57 -0.13 1.15 -0.27 1.79Z" />
        <path d="M2.43 16.87c-0.02 0.14 -0.14 0.21 -0.27 0.21c-0.13 0 -0.26 -0.07 -0.27 -0.21c-0.13 -0.94 -0.21 -1.83 -0.23 -2.71c-0.01 -0.88 0.05 -1.77 0.22 -2.7c0.02 -0.16 0.15 -0.24 0.28 -0.24c0.13 0 0.26 0.08 0.28 0.24c0.19 0.95 0.26 1.83 0.24 2.7c-0.02 0.88 -0.12 1.76 -0.25 2.71Z" />
        <path d="M4.06 17.12c0 0.17 -0.13 0.26 -0.26 0.26c-0.13 0 -0.26 -0.09 -0.26 -0.26c-0.1 -0.93 -0.2 -1.82 -0.22 -2.7c-0.02 -0.89 0.03 -1.77 0.23 -2.69c-0.01 -0.14 0.11 -0.24 0.25 -0.26c0.13 -0.01 0.27 0.06 0.29 0.26c0.21 0.91 0.27 1.78 0.24 2.66c-0.03 0.89 -0.14 1.78 -0.27 2.73Z" />
        <path d="M5.75 17.11c-0.01 0.17 -0.14 0.25 -0.27 0.25c-0.13 0 -0.26 -0.08 -0.27 -0.25c-0.15 -1.19 -0.23 -2.38 -0.23 -3.57c0 -1.19 0.08 -2.39 0.23 -3.57c0 -0.18 0.14 -0.27 0.27 -0.27c0.14 0 0.27 0.09 0.27 0.27c0.16 1.19 0.24 2.38 0.24 3.57c0.01 1.19 -0.07 2.38 -0.24 3.57Z" />
        <path d="M7.41 17.09c0 0.18 -0.13 0.27 -0.27 0.27c-0.13 0 -0.27 -0.09 -0.27 -0.27c-0.18 -1.34 -0.25 -2.64 -0.23 -3.95c0.01 -1.3 0.11 -2.6 0.24 -3.95c0 -0.18 0.13 -0.27 0.27 -0.27c0.13 0 0.27 0.09 0.27 0.27c0.13 1.36 0.23 2.66 0.25 3.95c0 1.29 -0.07 2.59 -0.26 3.95Z" />
        <path d="M9.07 17.1c-0.02 0.17 -0.15 0.25 -0.28 0.25c-0.13 0 -0.25 -0.08 -0.27 -0.25c-0.17 -1.31 -0.23 -2.57 -0.22 -3.82c0.01 -1.26 0.09 -2.51 0.22 -3.83c0 -0.19 0.14 -0.28 0.28 -0.28c0.14 0 0.28 0.09 0.28 0.28c0.14 1.33 0.23 2.58 0.24 3.82c0.01 1.25 -0.07 2.5 -0.25 3.83Z" />
        <path d="M10.72 17.09c0 0.18 -0.13 0.26 -0.26 0.26c-0.13 0 -0.26 -0.09 -0.26 -0.26c-0.21 -1.47 -0.26 -2.9 -0.24 -4.33c0.02 -1.43 0.12 -2.86 0.23 -4.34c0 -0.18 0.13 -0.26 0.26 -0.26c0.13 0 0.26 0.09 0.26 0.26c0.12 1.49 0.23 2.91 0.25 4.34c0.04 1.42 -0.03 2.85 -0.24 4.33Z" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12.8 16.28c0 -2.76 0 -5.52 0 -8.27c0.14 -0.09 0.32 -0.13 0.47 -0.18c0.41 -0.1 0.84 -0.14 1.26 -0.15c0.58 0 1.16 0.12 1.7 0.35c0.38 0.16 0.73 0.37 1.06 0.63c0.74 0.59 1.28 1.43 1.51 2.36c0.09 0.41 0.18 0.82 0.27 1.23c0.33 -0.1 0.66 -0.19 1 -0.29c0.24 -0.08 0.5 -0.11 0.76 -0.1c0.55 0.02 1.09 0.26 1.48 0.66c0.49 0.5 0.72 1.24 0.6 1.93c-0.07 0.39 -0.27 0.76 -0.54 1.05c-0.44 0.49 -1.09 0.77 -1.74 0.78c-2.61 0 -5.22 0 -7.83 0Z"
        />
      </g>
    </svg>
  );
}

export function PlayIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  );
}

export function PauseIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <rect x="7" y="5.5" width="4" height="13" rx="1" />
      <rect x="13" y="5.5" width="4" height="13" rx="1" />
    </svg>
  );
}

export function SortIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path d="M6 4v16m0 0-3-3m3 3 3-3M18 20V4m0 0-3 3m3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CratesIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path d="M3 8l2-4h14l2 4M3 8v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8M3 8h18M9 12h6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ExpandIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path
        d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CloseIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

export function CommunityIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth="1.6">
      <path
        d="M7 18v-1a5 5 0 0 1 5-5v0a5 5 0 0 1 5 5v1M1 18v-1a3 3 0 0 1 3-3v0m19 4v-1a3 3 0 0 0-3-3v0m-8-2a3 3 0 1 0 0-6a3 3 0 0 0 0 6m-8 2a2 2 0 1 0 0-4a2 2 0 0 0 0 4m16 0a2 2 0 1 0 0-4a2 2 0 0 0 0 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

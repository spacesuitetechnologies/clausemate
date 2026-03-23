export function Logo({ size = 32, dark = false }: { size?: number; dark?: boolean }) {
  const fg = dark ? "hsl(0,0%,100%)" : "hsl(234,60%,48%)";
  const fgFaint = dark ? "hsla(0,0%,100%,0.4)" : "hsla(234,60%,48%,0.25)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-label="clausemate.ai Logo"
    >
      <rect width="32" height="32" rx="7" fill={dark ? "hsla(0,0%,100%,0.1)" : "hsla(234,60%,48%,0.08)"} />
      <path
        d="M10 7h7l5 5v13a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 019 25V8.5A1.5 1.5 0 0110.5 7z"
        fill="none"
        stroke={fg}
        strokeWidth="1.2"
        strokeOpacity="0.7"
      />
      <path d="M17 7v5h5" stroke={fg} strokeOpacity="0.4" strokeWidth="1" fill="none" />
      <line x1="12" y1="15" x2="20" y2="15" stroke={fg} strokeOpacity="0.35" strokeWidth="0.8" strokeLinecap="round" />
      <line x1="12" y1="17.5" x2="18" y2="17.5" stroke={fgFaint} strokeWidth="0.8" strokeLinecap="round" />
      <line x1="12" y1="20" x2="16" y2="20" stroke={fgFaint} strokeWidth="0.8" strokeLinecap="round" />
    </svg>
  );
}

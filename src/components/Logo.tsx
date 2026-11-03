/** SNAKEYES mark: two dice, one pip each — snake eyes. */
export function LogoMark({ className = "logo-mark" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect x="3" y="14" width="30" height="30" rx="7" fill="#d7ff3b" transform="rotate(-10 18 29)" />
      <circle cx="18" cy="29" r="5" fill="#0d0f02" transform="rotate(-10 18 29)" />
      <rect x="31" y="20" width="30" height="30" rx="7" fill="#f4f1ea" transform="rotate(9 46 35)" />
      <circle cx="46" cy="35" r="5" fill="#e2132f" />
    </svg>
  );
}
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`logo${compact ? " logo-compact" : ""}`}>
      <LogoMark />
      <span className="logo-word">SNAKEYES</span>
    </span>
  );
}

// Small inline icons (stroke-based, currentColor) so we ship no icon dependency.
type P = { className?: string };

export const SearchIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
    <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const SlidersIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 7h11M19 7h1M4 17h1M9 17h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="17" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="7" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

export const ChevronDown = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const XIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const ImageOffIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" />
    <path d="m4 18 5-5 3 3 3-3 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

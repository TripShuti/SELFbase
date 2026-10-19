/** The two open page shapes and their shared amber connection form the 01C mark. */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 36" fill="none" aria-hidden="true" className={className}>
      <path d="M25 12V8a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v4a5 5 0 0 0 5 5h3M20 19h3a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5v-4"
        stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="13" y="15" width="6" height="6" rx="1.3" fill="#e8ad39" />
    </svg>
  );
}

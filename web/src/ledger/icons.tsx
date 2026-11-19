// Inline outline icons (no icon font: the CSP allows only same-origin styles and fonts).
const base = { "aria-hidden": true, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const RefreshIcon = () => <svg {...base} className="size-4"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>;
export const ChevronIcon = ({ dir = "down" }: { dir?: "down" | "left" | "right" }) => (
  <svg {...base} className={`size-4 ${dir === "left" ? "rotate-90" : dir === "right" ? "-rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
);
export const EditIcon = () => <svg {...base} className="size-4"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4M13.5 6.5l4 4" /></svg>;
export const ExternalIcon = () => <svg {...base} className="size-4"><path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M11 13l9-9M15 4h5v5" /></svg>;

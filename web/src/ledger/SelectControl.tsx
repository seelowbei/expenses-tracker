import type { ComponentProps } from "react";

export function SelectChevron() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 forced-colors:hidden"><path d="m5 7.5 5 5 5-5" /></svg>;
}

export function SelectControl({ className, children, ...props }: ComponentProps<"select">) {
  return <span className="relative block">
    <select {...props} className={`${className} appearance-none pr-10 forced-colors:appearance-auto`}>{children}</select>
    <SelectChevron />
  </span>;
}

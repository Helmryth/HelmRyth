import type { SVGProps } from "react";

export function HelmrythMark({ title = "Helmryth", ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  const labelled = Boolean(title);
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      {...props}
    >
      {labelled && <title>{title}</title>}
      <path d="M5 5.5 8 3h5v8.25l6-3.5V3h5l3 2.5v21L24 29h-5v-8.35l-6 3.5V29H8l-3-2.5v-21Z" fill="currentColor" />
      <path d="m13 14.6 6-3.5v5.15l-6 3.5V14.6Z" fill="var(--color-mark-cutout, oklch(0.974 0.012 83))" />
      <path d="M8.25 8.5h4.75M19 23.5h4.75" stroke="var(--color-mark-cutout, oklch(0.974 0.012 83))" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

export function HelmrythWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2" aria-label="Helmryth">
      <HelmrythMark title="" className="h-6 w-6 text-command" />
      {!compact && <span className="font-display text-[15px] font-semibold tracking-[-0.025em] text-ink">Helmryth</span>}
    </span>
  );
}

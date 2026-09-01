// The Box / Self-hosted VPS segmented control shown under the "Runs on"
// picker whenever an operator can use a hosted Workbench. One component, two
// homes, so the copy and the disabled
// rules can never drift apart.
import type { CloudBackend } from "../../server/contracts.ts";
import { cn } from "@/lib/cn";

export function CloudBackendPicker({
  value,
  vpsSupported,
  onChange,
}: {
  value: CloudBackend;
  vpsSupported: boolean;
  onChange: (backend: CloudBackend) => void;
}) {
  return (
    <div className="mt-3 border-l-2 border-signal bg-inset/50 px-3 py-2.5">
      <div className="text-[12px] font-medium text-ink">Hosted Workbench</div>
      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
        {value === "vps"
          ? "Automatic placement reuses a running VPS first. It can create or wake a managed container when permitted. Open the live desktop from the Workbench."
          : "Box is the managed default. Choose Self-hosted VPS to use the Linux Docker host in your SSH configuration."}
      </div>
      <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
        {(["box", "vps"] as const).map((backend, i) => {
          const disabled = backend === "vps" && !vpsSupported;
          return (
            <button
              key={backend}
              disabled={disabled}
              title={disabled ? "This engine does not support a self-hosted Workbench" : undefined}
              onClick={() => onChange(backend)}
              className={cn(
                "flex-1 py-1.5 text-[12px]",
                i > 0 && "border-l border-hairline/40",
                disabled && "cursor-not-allowed opacity-40",
                value === backend ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {backend === "vps" ? "Self-hosted VPS" : "Box"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import {
  Cloud,
  Loader2,
  LogOut,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PhoneSetupFlowView,
  companionAccountActionError,
  companionBridge,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionState,
  usePhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { ConnectionDetail } from "./ConnectionDetail";
import { Card } from "./SettingsPrimitives";

export {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
};

export interface CompanionPanelStatus {
  label: string;
  good: boolean;
}

export function deriveCompanionPanelStatus(
  state: Pick<CompanionState, "enabled" | "devices" | "error">,
): CompanionPanelStatus | null {
  if (state.error) return { label: "Helmryth Mobile link failed", good: false };
  if (!state.enabled) return { label: "Helmryth Mobile is off", good: false };
  const pairedCount = state.devices.length;
  if (!pairedCount) return null;
  return {
    label: `${pairedCount} Helmryth Mobile ${pairedCount === 1 ? "device" : "devices"} paired`,
    good: true,
  };
}

const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const endpointHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function CompanionSection({ profileEmail = "" }: { profileEmail?: string }) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const [revokeDevice, setRevokeDevice] = useState<{ id: string; name: string } | null>(null);
  const traceRef = useRef<HTMLDetailsElement>(null);
  const traceSummaryRef = useRef<HTMLElement>(null);
  const visibleError = c.error ?? state?.error ?? companionAccountActionError(c.account, c.accountError);

  useEffect(() => {
    if (!visibleError || !traceRef.current) return;
    traceRef.current.open = true;
    window.requestAnimationFrame(() => traceSummaryRef.current?.focus());
  }, [visibleError]);

  if (!companionBridge()) {
    return (
      <Card
        title="Helmryth Mobile"
        subtitle="Open System in Helmryth Desktop to connect a Mobile device."
      />
    );
  }

  if (!state) {
    return (
      <Card title="Helmryth Mobile" subtitle="Checking the Mobile link…">
        <Loader2 size={15} className="motion-safe:animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const pairedCount = state.devices.length;
  const panelStatus = deriveCompanionPanelStatus(state);
  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const localRoutes = [
    state.tailnetName ? { label: "Tailscale", value: `${state.tailnetName}:${state.port}` } : null,
    state.lan ? { label: "Wi-Fi", value: `${state.lan}:${state.port}` } : null,
    state.discovery?.name
      ? { label: "Nearby discovery", value: `${state.discovery.name}:${state.port}` }
      : null,
    ...(state.addresses ?? [])
      .filter((address) => address !== state.lan && address !== state.tailscale)
      .map((address, index) => ({ label: `Local route ${index + 1}`, value: `${address}:${state.port}` })),
  ].filter((route): route is { label: string; value: string } => Boolean(route));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {(panelStatus || (pairedCount > 0 && c.hostedReady)) && (
          <div className="mb-4 flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            {panelStatus && (
              <div
                className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[12px] ${
                  panelStatus.good ? "bg-success/10 text-success" : "bg-control text-ink-secondary"
                }`}
              >
                <span className={`size-1.5 rounded-full ${panelStatus.good ? "bg-success" : "bg-ink-secondary/50"}`} />
                {panelStatus.label}
              </div>
            )}
            {pairedCount > 0 && c.hostedReady && (
              <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
                <ShieldCheck size={13} className="text-accent" /> Helmryth Relay ready
              </div>
            )}
          </div>
        )}
        {visibleError && (
          <div role="alert" className="mb-4 border-l-2 border-danger bg-danger/10 px-3 py-2 text-[13px] text-danger">
            Helmryth Mobile could not maintain its link.
            <button
              type="button"
              onClick={() => {
                if (traceRef.current) traceRef.current.open = true;
                traceSummaryRef.current?.focus();
              }}
              className="ml-2 min-h-9 rounded-md px-2 text-[12px] underline underline-offset-2 hover:bg-danger/10"
            >
              Open pairing trace
            </button>
          </div>
        )}
        <PhoneSetupFlowView controller={c} variant="settings" />
      </Card>

      <section className="border-t border-hairline/60 pt-5" aria-labelledby="paired-mobile-title">
        <h3 id="paired-mobile-title" className="font-display text-[16px] font-semibold text-ink">Paired Mobile devices</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
          {pairedCount ? "Manage devices linked to this Helmryth installation." : "Pair a Mobile device to carry workstreams with you."}
        </p>
        {pairedCount > 0 && (
          <ul className="mt-4 flex flex-col border-t border-hairline/60">
            {state.devices.map((device) => (
              <li key={device.id} className="border-b border-hairline/60 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
                    <Smartphone size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{device.name}</div>
                    <div className="text-[12px] text-ink-secondary">Last seen {relative(device.lastSeenAt)}</div>
                  </div>
                  <button
                    disabled={c.busy}
                    onClick={() => setRevokeDevice({ id: device.id, name: device.name })}
                    aria-label={`Remove ${device.name} from Helmryth Mobile`}
                    aria-haspopup="dialog"
                    className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline/30 pt-3">
                  <div>
                    <div className="text-[12px] text-ink">Allow Workbench control</div>
                    <div className="mt-0.5 text-[12px] text-ink-secondary">View the screen and use the pointer and keyboard from this device.</div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={device.cloudDesktopAccess}
                    aria-label={`Workbench access for ${device.name}`}
                    disabled={c.busy}
                    onClick={() =>
                      void c.act((companion) =>
                        companion.cloudDesktop(device.id, !device.cloudDesktopAccess),
                      )
                    }
                    className={cnSwitch(device.cloudDesktopAccess)}
                  >
                    <span className={cnKnob(device.cloudDesktopAccess)} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details ref={traceRef} className="border-t border-hairline/60">
        <summary ref={traceSummaryRef} className="cursor-pointer px-4 py-3.5 text-[13px] font-medium text-ink">
          Pairing trace & recovery
        </summary>
        <div className="flex flex-col gap-4 border-t border-hairline/30 px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">Helmryth Mobile access</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                Turn off every Mobile link to this host workbench.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={state.enabled}
              aria-label="Helmryth Mobile access"
              disabled={c.busy}
              onClick={() => void c.act((companion) => (state.enabled ? companion.stop() : companion.start()))}
              className={cnSwitch(state.enabled)}
            >
              <span className={cnKnob(state.enabled)} />
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">Keep the host workbench awake</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                Keeps Helmryth Mobile and scheduled runs available while the screen is off.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={state.keepAwake}
              aria-label="Keep the host workbench awake while Helmryth Mobile is on"
              disabled={c.busy || !state.enabled}
              onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))}
              className={cnSwitch(state.keepAwake)}
            >
              <span className={cnKnob(state.keepAwake)} />
            </button>
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <Cloud size={15} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">Helmryth Relay account</div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                    {c.account?.status === "ready"
                      ? `Signed in as ${c.account.email ?? "your account"}.`
                      : c.account?.status === "connecting"
                        ? "Finishing secure access…"
                        : c.account?.status === "error"
                          ? "Helmryth Relay needs recovery. Open the pairing trace below."
                          : "You’ll be asked to sign in when you pair Helmryth Mobile."}
                  </div>
                </div>
              </div>
              {(c.account?.status === "ready" || c.account?.status === "connecting" || c.account?.status === "error") && (
                <button
                  disabled={c.accountBusy}
                  onClick={() => void c.accountAct((remote) => remote.signOut())}
                  className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-hairline/60 px-2.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
                >
                  <LogOut size={12} /> Sign out
                </button>
              )}
            </div>
            {c.account?.status === "error" && (
              <button
                disabled={c.accountBusy}
                onClick={c.retryAccount}
                className="mt-3 min-h-9 rounded-md border border-hairline/60 px-3 text-[12px] text-ink hover:bg-control disabled:opacity-40"
              >
                {c.accountBusy ? "Trying again…" : "Retry secure access"}
              </button>
            )}
            {accountActionError && <div role="alert" className="mt-2 text-[12px] text-danger">{accountActionError}</div>}
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="text-[13px] text-ink">Connection details</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              Reveal or copy an address only when troubleshooting manual pairing.
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {hosted && <ConnectionDetail label="Secure route" value={endpointHost(hosted.url)} />}
              {localRoutes.map((route) => <ConnectionDetail key={`${route.label}:${route.value}`} {...route} />)}
              {!hosted && localRoutes.length === 0 && (
                <div className="text-[12px] text-ink-secondary">No reachable address is available yet.</div>
              )}
            </div>
          </div>

          <div className="border-t border-hairline/30 pt-4">
            {c.tailscaleAvailable && (
              <div className="mb-4 border-b border-hairline/30 pb-4">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent" />
                  <div>
                    <div className="text-[13px] text-ink">Tailscale pairing</div>
                    <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                      Keep pairing on your private tailnet, even when a secure hosted route is available.
                    </div>
                  </div>
                </div>
                <button
                  disabled={c.busy || c.accountBusy}
                  onClick={c.useTailscale}
                  className="mt-3 min-h-9 rounded-md border border-hairline/60 px-3 text-[12px] text-ink hover:bg-control disabled:opacity-40"
                >
                  Pair over Tailscale
                </button>
              </div>
            )}
            <div className="flex items-start gap-2.5">
              <Wifi size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
              <div>
                <div className="text-[13px] text-ink">Direct Wi-Fi pairing</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                  Use this only when both devices are nearby and the network allows devices to see each other.
                </div>
              </div>
            </div>
            <button
              disabled={c.busy || c.accountBusy}
              onClick={c.useLocal}
              className="mt-3 min-h-9 rounded-md border border-hairline/60 px-3 text-[12px] text-ink hover:bg-control disabled:opacity-40"
            >
              Pair on this Wi-Fi
            </button>
          </div>

          {state.enabled && !hosted && state.tailscale && !state.tailnetName && (
            <div className="border-l-2 border-warning bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
              Tailscale is connected, but its device name could not be read. Check MagicDNS in Tailscale or use the secure account above.
            </div>
          )}
          {state.enabled && !hosted && !state.tailscale && (
            <div className="border-l-2 border-hairline bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
              Without Helmryth Relay or Tailscale, this host workbench is reachable only on a compatible local network.
            </div>
          )}
          {(c.error || state.error) && <div role="alert" className="text-[12px] text-danger">{c.error ?? state.error}</div>}
        </div>
      </details>
      <MobileRevokeGate
        device={revokeDevice}
        busy={c.busy}
        onCancel={() => setRevokeDevice(null)}
        onConfirm={async () => {
          if (!revokeDevice) return;
          await c.act((companion) => companion.revoke(revokeDevice.id));
          setRevokeDevice(null);
        }}
      />
    </div>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full disabled:opacity-40 ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-panel transition-transform motion-reduce:transition-none ${on ? "translate-x-[20px]" : "translate-x-0"}`;

function MobileRevokeGate({
  device,
  busy,
  onCancel,
  onConfirm,
}: {
  device: { id: string; name: string } | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;
  const deviceId = device?.id ?? null;
  useEffect(() => {
    if (!deviceId) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = gateRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
      if (!controls?.length) {
        event.preventDefault();
        gateRef.current?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus.current?.focus();
    };
  }, [deviceId]);
  useEffect(() => {
    if (deviceId && busy) gateRef.current?.focus();
  }, [busy, deviceId]);
  if (!device) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6">
      <div ref={gateRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="mobile-revoke-title" aria-describedby="mobile-revoke-copy" className="max-h-[calc(100vh-48px)] w-full max-w-[420px] overflow-y-auto rounded-md border border-hairline bg-panel p-5 outline-none">
        <h2 id="mobile-revoke-title" className="font-display text-[20px] font-semibold text-ink">Remove {device.name}?</h2>
        <p id="mobile-revoke-copy" className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          This device will lose Helmryth Mobile and Workbench access immediately. Pair it again to restore access.
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="min-h-9 w-full rounded-md border border-hairline/60 px-4 text-[13px] text-ink hover:bg-raised disabled:opacity-50 sm:w-auto">Keep device</button>
          <button type="button" disabled={busy} onClick={() => void onConfirm()} className="min-h-9 w-full rounded-md bg-danger px-4 text-[13px] font-medium text-[var(--color-danger-ink)] disabled:opacity-50 sm:w-auto">{busy ? "Removing device…" : "Remove device"}</button>
        </div>
      </div>
    </div>
  );
}

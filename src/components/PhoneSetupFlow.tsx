import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  Loader2,
  Mail,
  QrCode,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  companionPairingLink,
  companionPairingRoute,
  companionPairingRoutePin,
  companionPairingRoutePinAvailable,
  type CompanionEndpoint,
  type CompanionPairingRoutePin,
  type CompanionPairingRouteMode,
} from "../lib/companion-pairing";
import {
  PHONE_SETUP_PROVISIONING_TIMEOUT_MS,
  claimPhonePairingAttempt,
  closePhonePairingIfOwned,
  completePhonePairingAttempt,
  companionPairingMode,
  companionPairingOpenFailure,
  companionStartFailure,
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  keepPhonePairingIfCurrent,
  invalidatePhonePairingAttempt,
  newlyPairedDeviceForFlow,
  normalizePhoneSetupActionError,
  phonePairingGate,
  phoneSetupBaseline,
  phoneSetupReducer,
  queuePhonePairingAttempt,
  releasePhonePairingAttempt,
  shouldArmPhoneSetupProvisioningTimeout,
  startNonOverlappingPhoneSetupPoll,
  type PhoneSetupPhase,
  type PhonePairingAttemptLock,
  type PhonePairingAttemptQueue,
} from "../lib/phone-setup";
import type { CompanionAccountState } from "../types/helmryth";
import { ConnectionDetail } from "./ConnectionDetail";

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
}

export interface CompanionState {
  enabled: boolean;
  keepAwake: boolean;
  port: number;
  devices: PhoneDevice[];
  connectedDeviceIds?: string[];
  pairing: { code: string; token: string; expiresAt: number } | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  lan?: string | null;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  discovery?: { advertising: boolean; name: string };
  error?: string;
}

export type CompanionBridge = {
  state: () => Promise<CompanionState>;
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  keepAwake: (enabled: boolean) => Promise<CompanionState>;
  pairing: (open: boolean, expectedToken?: string) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
};

type AccountBridge = NonNullable<NonNullable<Window["helmryth"]>["companionAccount"]>;
type StateBridge<T> = { state: () => Promise<T> };
const DIRECT_PAIRING_UNAVAILABLE =
  "Direct Wi-Fi pairing is unavailable on this host workbench. Connect it to Wi-Fi, then try again.";
const PROTECTED_PAIRING_UNAVAILABLE =
  "The HTTPS pairing route became unavailable. Check secure access, then create a new code.";

interface OwnedCompanionPairingRoutePin extends CompanionPairingRoutePin {
  generation: number;
  token: string;
}

interface PhonePairingRequest {
  routeMode: CompanionPairingRouteMode;
  accountOverride?: CompanionAccountState | null;
  generation: number;
}

export const companionBridge = (): CompanionBridge | null =>
  // SAFETY: the preload owns this narrow bridge; browser builds are guarded by the optional lookup.
  (globalThis as { helmryth?: { companion?: CompanionBridge } }).helmryth?.companion ?? null;

export const companionAccountBridge = (): AccountBridge | null =>
  // SAFETY: Electron exposes only these account operations and never sends credentials to the renderer.
  (globalThis as { helmryth?: { companionAccount?: AccountBridge } }).helmryth?.companionAccount ?? null;

export const loadCompanionBridgeState = async (
  companion: StateBridge<CompanionState> | null,
  remote: StateBridge<CompanionAccountState> | null,
): Promise<{ companion: CompanionState | null; account: CompanionAccountState | null }> => {
  const [companionResult, accountResult] = await Promise.allSettled([
    companion ? Promise.resolve().then(() => companion.state()) : Promise.resolve(null),
    remote ? Promise.resolve().then(() => remote.state()) : Promise.resolve(null),
  ]);
  return {
    companion: companionResult.status === "fulfilled" ? companionResult.value : null,
    account: accountResult.status === "fulfilled" ? accountResult.value : null,
  };
};

export interface CompanionStateMutationEpoch {
  current: number;
}

/** Polls capture the epoch before reading. A mutation advances it both before
 * and after the IPC call, invalidating snapshots taken before or during that
 * mutation while leaving the independently loaded account result usable. */
export const mutateCompanionBridgeState = async <State,>(
  epoch: CompanionStateMutationEpoch,
  mutate: () => Promise<State>,
): Promise<State> => {
  epoch.current += 1;
  try {
    return await mutate();
  } finally {
    epoch.current += 1;
  }
};

export const companionStateRefreshIsCurrent = (
  epoch: CompanionStateMutationEpoch,
  refreshEpoch: number,
): boolean => epoch.current === refreshEpoch;

export const shouldHydrateCompanionEmail = (
  userEdited: boolean,
  account: CompanionAccountState,
): boolean => !userEdited && Boolean(account.email);

export const companionAccountActionError = (
  account: CompanionAccountState | null,
  actionError: string | null,
): string | null => {
  if (actionError) return actionError;
  if (account?.status !== "signed-out" || !account.message) return null;
  return normalizePhoneSetupActionError(
    new Error(account.message),
    "Helmryth Relay needs attention. Check the email address and try again.",
  );
};

export const phonePairingManualCodeMode = (
  pairingOpen: boolean,
  pairingLink: string | null,
): "details" | "direct" | "hidden" => {
  if (!pairingOpen) return "hidden";
  return pairingLink ? "details" : "direct";
};

export interface PhoneSetupController {
  state: CompanionState | null;
  account: CompanionAccountState | null;
  phase: PhoneSetupPhase;
  statusPhase: "loading" | "ready" | "unavailable";
  accountBridgeAvailable: boolean;
  email: string;
  code: string;
  codeSent: boolean;
  busy: boolean;
  accountBusy: boolean;
  error: string | null;
  accountError: string | null;
  pairingLink: string | null;
  secondsLeft: number;
  address: string | undefined;
  pairingPort: number;
  hostedReady: boolean;
  localFallback: boolean;
  tailscaleFallback: boolean;
  tailscaleAvailable: boolean;
  pairingExpired: boolean;
  setupTimedOut: boolean;
  setEmail: (email: string) => void;
  setCode: (code: string) => void;
  changeEmail: () => void;
  start: () => void;
  useLocal: () => void;
  useTailscale: () => void;
  requestCode: () => void;
  verifyCode: () => void;
  retryAccount: () => void;
  retryStatus: () => void;
  cancel: () => void;
  refreshCode: () => void;
  finish: () => void;
  skip: () => void;
  act: (call: (companion: CompanionBridge) => Promise<CompanionState>) => Promise<void>;
  accountAct: (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => Promise<void>;
}

export function usePhoneSetupController(profileEmail = ""): PhoneSetupController {
  const [state, setState] = useState<CompanionState | null>(null);
  const [account, setAccount] = useState<CompanionAccountState | null>(null);
  const [email, setEmailState] = useState(profileEmail);
  const [code, setCodeState] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [setupTimedOut, setSetupTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [statusPhase, setStatusPhase] = useState<"loading" | "ready" | "unavailable">("loading");
  const [now, setNow] = useState(() => Date.now());
  const [flow, dispatchFlow] = useReducer(phoneSetupReducer, initialPhoneSetupFlowState);
  const emailEdited = useRef(false);
  const pairingUiOwner = useRef<PhonePairingAttemptLock>({ generation: null });
  const pairingAttemptQueue = useRef<PhonePairingAttemptQueue<PhonePairingRequest>>({
    active: null,
    pending: null,
  });
  const runPairingAttemptRef = useRef<(request: PhonePairingRequest) => Promise<void>>(
    async () => {},
  );
  const pairingRoutePinRef = useRef<OwnedCompanionPairingRoutePin | null>(null);
  const [pairingRoutePinState, setPairingRoutePinState] =
    useState<OwnedCompanionPairingRoutePin | null>(null);
  const setupGeneration = useRef(0);
  const mounted = useRef(true);
  const companionMutationEpoch = useRef(0);
  const accountMutationEpoch = useRef(0);
  const loadInFlight = useRef<{
    companionEpoch: number;
    accountEpoch: number;
    promise: Promise<void>;
  } | null>(null);

  const publishPairingRoutePin = useCallback((pin: OwnedCompanionPairingRoutePin | null) => {
    pairingRoutePinRef.current = pin;
    setPairingRoutePinState(pin);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setupGeneration.current += 1;
    };
  }, []);

  const load = useCallback((): Promise<void> => {
    const companionRefreshEpoch = companionMutationEpoch.current;
    const accountRefreshEpoch = accountMutationEpoch.current;
    const activeLoad = loadInFlight.current;
    if (
      activeLoad &&
      activeLoad.companionEpoch === companionRefreshEpoch &&
      activeLoad.accountEpoch === accountRefreshEpoch
    ) return activeLoad.promise;
    const pending = (async () => {
      const localBridge = companionBridge();
      const next = await loadCompanionBridgeState(localBridge, companionAccountBridge());
      if (!mounted.current) return;
      if (!localBridge) {
        setStatusPhase("unavailable");
        setStatusError("Helmryth Mobile setup requires Helmryth Desktop.");
      } else if (!next.companion) {
        setStatusPhase("unavailable");
        setStatusError("Helmryth Mobile status could not be read. Retry the connection.");
      } else {
        setStatusPhase("ready");
        setStatusError(null);
      }
      if (
        next.companion
        && companionStateRefreshIsCurrent(companionMutationEpoch, companionRefreshEpoch)
      ) {
        setState(next.companion);
      }
      if (next.account && companionStateRefreshIsCurrent(accountMutationEpoch, accountRefreshEpoch)) {
        setAccount(next.account);
        if (shouldHydrateCompanionEmail(emailEdited.current, next.account)) {
          setEmailState(next.account.email ?? "");
        }
      }
    })().finally(() => {
      if (loadInFlight.current?.promise === pending) loadInFlight.current = null;
    });
    loadInFlight.current = {
      companionEpoch: companionRefreshEpoch,
      accountEpoch: accountRefreshEpoch,
      promise: pending,
    };
    return pending;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!emailEdited.current && profileEmail) setEmailState(profileEmail);
  }, [profileEmail]);

  const act = useCallback(async (call: (companion: CompanionBridge) => Promise<CompanionState>) => {
    const companion = companionBridge();
    if (!companion) return;
    setActionBusy(true);
    setError(null);
    try {
      const next = await mutateCompanionBridgeState(
        companionMutationEpoch,
        () => call(companion),
      );
      if (mounted.current) setState(next);
    } catch (cause) {
      if (mounted.current) setError(
        normalizePhoneSetupActionError(
          cause,
          "Helmryth Mobile access could not be updated. Open Pairing trace & recovery and try again.",
        ),
      );
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }, []);

  const accountAct = useCallback(
    async (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => {
      const remote = companionAccountBridge();
      if (!remote) return;
      setAccountBusy(true);
      setAccountError(null);
      try {
        const next = await mutateCompanionBridgeState(
          accountMutationEpoch,
          () => call(remote),
        );
        if (!mounted.current) return;
        setAccount(next);
        await load();
      } catch (cause) {
        if (mounted.current) setAccountError(normalizePhoneSetupActionError(
          cause,
          "Helmryth Relay access could not be updated. Try again.",
        ));
      } finally {
        if (mounted.current) setAccountBusy(false);
      }
    },
    [load],
  );

  const runPairingAttempt = useCallback(
    async ({ routeMode, accountOverride, generation }: PhonePairingRequest) => {
      const finishAttempt = () => {
        if (releasePhonePairingAttempt(pairingUiOwner.current, generation) && mounted.current) {
          setPairingBusy(false);
        }
        const next = completePhonePairingAttempt(pairingAttemptQueue.current, generation);
        if (next) void runPairingAttemptRef.current(next);
      };
      const isCurrent = () => mounted.current && setupGeneration.current === generation;
      if (!isCurrent()) {
        finishAttempt();
        return;
      }
      const companion = companionBridge();
      if (!companion) {
        if (mounted.current && setupGeneration.current === generation) {
          setError("Helmryth Mobile setup is available in Helmryth Desktop.");
        }
        finishAttempt();
        return;
      }
      const staleAttemptMayClose = () => {
        const activePin = pairingRoutePinRef.current;
        return !activePin || activePin.generation === generation;
      };
      const previousPin = pairingRoutePinRef.current;
      if (previousPin && previousPin.generation !== generation) {
        publishPairingRoutePin(null);
        setState((current) => current?.pairing?.token === previousPin.token
          ? { ...current, pairing: null }
          : current);
      }
      setError(null);
      try {
        const started = state?.enabled
          ? await companion.state()
          : await mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.start(),
            );
        if (!isCurrent()) return;
        setState(started);
        const startFailure = companionStartFailure(started);
        if (startFailure) {
          setProvisioning(false);
          setError("Helmryth Mobile could not start. Open Pairing trace & recovery, then try again.");
          dispatchFlow({ type: "reset" });
          return;
        }
        const explicitRoute = routeMode !== "automatic";
        const gate = phonePairingGate(accountOverride ?? account, started, explicitRoute);
        if (gate !== "open") {
          setProvisioning(gate === "wait" || gate === "start");
          return;
        }
        if (explicitRoute && !companionPairingRoute(started, routeMode)) {
          setProvisioning(false);
          setError(routeMode === "tailscale"
            ? "Tailscale pairing isn’t available right now. Make sure Tailscale is connected and MagicDNS is on."
            : DIRECT_PAIRING_UNAVAILABLE);
          dispatchFlow({ type: "reset" });
          return;
        }
        const paired = await keepPhonePairingIfCurrent(
          () => mutateCompanionBridgeState(
            companionMutationEpoch,
            () => companion.pairing(true),
          ),
          (opened) => closePhonePairingIfOwned(
            opened,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, opened.pairing?.token),
            ),
            staleAttemptMayClose,
          ),
          isCurrent,
        );
        if (!paired) return;

        const pairingWindow = paired.pairing;
        const pairingFailure = companionPairingOpenFailure(
          paired,
          started.pairing?.token ?? null,
        );
        const routePin = pairingFailure ? null : companionPairingRoutePin(paired, routeMode);
        if (pairingFailure || !routePin || !pairingWindow) {
          await closePhonePairingIfOwned(
            paired,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, paired.pairing?.token),
            ),
            isCurrent,
          );
          if (!isCurrent()) return;
          publishPairingRoutePin(null);
          setState({ ...paired, pairing: null });
          setProvisioning(false);
          setError((routeMode === "local"
            ? DIRECT_PAIRING_UNAVAILABLE
            : routeMode === "tailscale"
              ? "Tailscale pairing isn’t available right now. Make sure Tailscale is connected and MagicDNS is on."
              : PROTECTED_PAIRING_UNAVAILABLE));
          dispatchFlow({ type: "reset" });
          return;
        }
        publishPairingRoutePin({
          ...routePin,
          generation,
          token: pairingWindow.token,
        });
        setState(paired);
        setProvisioning(false);
        setSetupTimedOut(false);
        dispatchFlow({
          type: "pairing-opened",
          deviceIds: paired.devices.map((device) => device.id),
        });
      } catch (cause) {
        if (!isCurrent()) return;
        publishPairingRoutePin(null);
        setProvisioning(false);
        setError(normalizePhoneSetupActionError(
          cause,
          "Helmryth Mobile pairing could not be prepared. Open Pairing trace & recovery and try again.",
        ));
        dispatchFlow({ type: "reset" });
      } finally {
        finishAttempt();
      }
    },
    [account, publishPairingRoutePin, state],
  );

  useLayoutEffect(() => {
    runPairingAttemptRef.current = runPairingAttempt;
  }, [runPairingAttempt]);

  const openPairing = useCallback((
    routeMode: CompanionPairingRouteMode,
    accountOverride?: CompanionAccountState | null,
    generation = setupGeneration.current,
  ) => {
    const request = { routeMode, accountOverride, generation };
    const decision = queuePhonePairingAttempt(pairingAttemptQueue.current, request);
    if (decision === "duplicate") return;
    claimPhonePairingAttempt(pairingUiOwner.current, generation);
    setPairingBusy(true);
    if (decision === "start") void runPairingAttemptRef.current(request);
  }, []);

  const start = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "start", deviceIds: baseline });
    setError(null);
    setAccountError(null);
    setSetupTimedOut(false);
    if (
      phonePairingGate(account, state, false) === "open"
      || (account?.available && (account.status === "ready" || account.status === "connecting"))
    ) {
      setProvisioning(true);
      void openPairing("automatic", account, generation);
    }
  }, [account, openPairing, state]);

  const useLocal = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-local" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("local", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  const useTailscale = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-tailscale" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("tailscale", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  const requestCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || !normalized) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setAccountError(null);
    void mutateCompanionBridgeState(accountMutationEpoch, () => remote.requestCode(normalized))
      .then((next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeSent(true);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccountError(
          normalizePhoneSetupActionError(cause, "We could not send the code. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [email]);

  const verifyCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || code.length !== 8) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      accountMutationEpoch,
      () => remote.verifyCode(normalized, code),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeState("");
        setCodeSent(false);
        await openPairing("automatic", next, generation);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, "That code could not be verified. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [code, email, openPairing]);

  const retryAccount = useCallback(() => {
    const remote = companionAccountBridge();
    if (!remote) return;
    const baseline = flow.active ? phoneSetupBaseline(state?.devices ?? null) : null;
    const generation = ++setupGeneration.current;
    if (baseline) dispatchFlow({ type: "start", deviceIds: baseline });
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      accountMutationEpoch,
      () => remote.retry(),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        if (flow.active) await openPairing("automatic", next, generation);
        else {
          await load();
          if (mounted.current && setupGeneration.current === generation) setProvisioning(false);
        }
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, "Secure access could not be restored. Try again."),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [flow.active, load, openPairing, state?.devices]);

  const phase = derivePhoneSetupPhase(flow, {
    accountStatus: account?.available ? account.status : "unavailable",
    accountBusy,
    provisioning,
    provisioningTimedOut: setupTimedOut,
    pairingOpen: Boolean(
      state?.pairing
      && pairingRoutePinState?.token === state.pairing.token,
    ),
  });

  useEffect(() => {
    if (
      !flow.active
      || flow.localFallback
      || flow.tailscaleFallback
      || !account
      || (account.available && account.status !== "signed-out" && account.status !== "error")
    ) {
      return;
    }
    setProvisioning(false);
  }, [account, flow.active, flow.localFallback, flow.tailscaleFallback]);

  useEffect(() => {
    if (!shouldArmPhoneSetupProvisioningTimeout(flow, {
      provisioning,
      provisioningTimedOut: setupTimedOut,
    })) return;
    const timer = window.setTimeout(() => {
      const timedOutGeneration = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, timedOutGeneration);
      releasePhonePairingAttempt(pairingUiOwner.current, timedOutGeneration);
      setPairingBusy(false);
      setAccountBusy(false);
      setProvisioning(false);
      setSetupTimedOut(true);
    }, PHONE_SETUP_PROVISIONING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [flow, provisioning, setupTimedOut]);

  useEffect(() => {
    const pin = pairingRoutePinState;
    if (!pin || !state) return;
    if (!state.pairing) {
      publishPairingRoutePin(null);
      return;
    }

    const tokenMatches = state.pairing.token === pin.token;
    const routeAvailable = companionPairingRoutePinAvailable(state, pin);
    if (tokenMatches && routeAvailable) return;

    const companion = companionBridge();
    if (setupGeneration.current === pin.generation) setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, pin.generation);
    releasePhonePairingAttempt(pairingUiOwner.current, pin.generation);
    setPairingBusy(false);
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    setProvisioning(false);
    setSetupTimedOut(false);
    setError(tokenMatches
      ? PROTECTED_PAIRING_UNAVAILABLE
      : "The pairing code changed before setup finished. Create a new code and try again.");
    dispatchFlow({ type: "reset" });

    if (tokenMatches && companion) {
      void closePhonePairingIfOwned(
        state,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, state.pairing?.token),
        ),
        () => {
          const activePin = pairingRoutePinRef.current;
          return !activePin || activePin.generation === pin.generation;
        },
      );
    }
  }, [pairingRoutePinState, publishPairingRoutePin, state]);

  useEffect(() => {
    if (!state) return;
    const device = newlyPairedDeviceForFlow(flow, state.devices);
    if (device) dispatchFlow({ type: "paired", deviceName: device.name });
  }, [flow, state]);

  useEffect(() => {
    if (
      !flow.active ||
      flow.localFallback ||
      flow.tailscaleFallback ||
      flow.pairingAttempted ||
      setupTimedOut ||
      !state ||
      phonePairingGate(account, state, false) !== "open"
    ) {
      return;
    }
    void openPairing("automatic");
  }, [account, flow.active, flow.localFallback, flow.pairingAttempted, flow.tailscaleFallback, openPairing, setupTimedOut, state]);

  const shouldPoll = flow.active || Boolean(state?.pairing);
  useEffect(() => {
    return startNonOverlappingPhoneSetupPoll(
      () => {
        setNow(Date.now());
        return load();
      },
      shouldPoll ? 1_000 : 10_000,
    );
  }, [load, shouldPoll]);

  const pairingRouteMode: CompanionPairingRouteMode = flow.localFallback
    ? "local"
    : flow.tailscaleFallback
      ? "tailscale"
      : "automatic";
  const pairingRoute = useMemo(
    () => {
      if (!state) return null;
      if (state.pairing) {
        return pairingRoutePinState?.token === state.pairing.token
          ? pairingRoutePinState.route
          : null;
      }
      return companionPairingRoute(state, pairingRouteMode);
    },
    [pairingRouteMode, pairingRoutePinState, state],
  );
  const pairingLink = useMemo(() => {
    if (!state?.pairing || !pairingRoute) return null;
    return companionPairingLink({
      ...pairingRoute,
      code: state.pairing.code,
      token: state.pairing.token,
      name: state.discovery?.name,
    });
  }, [pairingRoute, state]);

  const cancel = useCallback(() => {
    const cancelledGeneration = setupGeneration.current;
    setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, cancelledGeneration);
    releasePhonePairingAttempt(pairingUiOwner.current, cancelledGeneration);
    setPairingBusy(false);
    const snapshot = state;
    const companion = companionBridge();
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    if (companion && snapshot?.pairing) {
      void closePhonePairingIfOwned(
        snapshot,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, snapshot.pairing?.token),
        ),
        () => pairingRoutePinRef.current === null,
      );
    }
    setProvisioning(false);
    setAccountBusy(false);
    setSetupTimedOut(false);
    setCodeSent(false);
    setCodeState("");
    dispatchFlow({ type: "reset" });
  }, [publishPairingRoutePin, state]);

  return {
    state,
    account,
    phase,
    statusPhase,
    accountBridgeAvailable: Boolean(companionAccountBridge()),
    email,
    code,
    codeSent,
    busy: actionBusy || pairingBusy,
    accountBusy,
    error: error ?? statusError,
    accountError,
    pairingLink,
    secondsLeft: state?.pairing
      ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000))
      : 0,
    address: pairingRoute?.address,
    pairingPort: pairingRoute?.port ?? state?.port ?? 8810,
    hostedReady: Boolean(state?.endpoints?.some((endpoint) => endpoint.kind === "hosted")),
    localFallback: flow.localFallback,
    tailscaleFallback: flow.tailscaleFallback,
    tailscaleAvailable: Boolean(state && companionPairingRoute(state, "tailscale")),
    pairingExpired: flow.pairingAttempted && !state?.pairing,
    setupTimedOut,
    setEmail: (next) => {
      emailEdited.current = true;
      setEmailState(next);
    },
    setCode: (next) => setCodeState(next.replaceAll(/\D/g, "").slice(0, 8)),
    changeEmail: () => {
      setCodeState("");
      setCodeSent(false);
      setAccountError(null);
    },
    start,
    useLocal,
    useTailscale,
    requestCode,
    verifyCode,
    retryAccount,
    retryStatus: () => {
      setStatusPhase("loading");
      setStatusError(null);
      void load();
    },
    cancel,
    refreshCode: () => {
      const generation = ++setupGeneration.current;
      void openPairing(pairingRouteMode, undefined, generation);
    },
    finish: () => {
      const generation = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, generation);
      releasePhonePairingAttempt(pairingUiOwner.current, generation);
      setPairingBusy(false);
      publishPairingRoutePin(null);
      setSetupTimedOut(false);
      dispatchFlow({ type: "reset" });
    },
    skip: () => {
      const generation = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, generation);
      releasePhonePairingAttempt(pairingUiOwner.current, generation);
      setPairingBusy(false);
      publishPairingRoutePin(null);
      dispatchFlow({ type: "skip" });
    },
    act,
    accountAct,
  };
}

function ValuePoints() {
  const points: Array<{ Icon: typeof Smartphone; title: string; detail: string }> = [
    { Icon: Smartphone, title: "Workstreams", detail: "Read updates and direct the next move." },
    { Icon: Check, title: "Gates", detail: "Review consequential actions while away." },
    { Icon: ShieldCheck, title: "Your link", detail: "Only Mobile devices you pair can connect." },
  ];
  return (
    <div className="mt-5 grid w-full border-y border-hairline/60 sm:grid-cols-3">
      {points.map(({ Icon, title, detail }) => (
        <div key={title} className="border-b border-hairline/60 px-3 py-3 text-left last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
          <Icon size={16} className="text-accent" />
          <div className="mt-2 text-[13px] font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{detail}</div>
        </div>
      ))}
    </div>
  );
}

export function PhoneSetupFlowView({
  controller,
  variant,
  onSkip,
  onComplete,
}: {
  controller: PhoneSetupController;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
}) {
  const c = controller;
  const actionError = companionAccountActionError(c.account, c.accountError);
  const canSubmitEmail = /^\S+@\S+\.\S+$/.test(c.email.trim());
  const manualCodeMode = phonePairingManualCodeMode(Boolean(c.state?.pairing), c.pairingLink);
  const phaseHeadingRef = useRef<HTMLHeadingElement>(null);
  const phaseHeadingClass =
    "rounded-md font-display text-[20px] font-semibold text-ink outline-none focus:ring-2 focus:ring-focus";

  useEffect(() => {
    phaseHeadingRef.current?.focus();
  }, [c.phase]);

  if (c.phase === "intro") {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-md border border-hairline/60 bg-inset text-accent">
          <Smartphone size={26} />
        </div>
        <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.09em] text-accent">Helmryth Mobile</div>
        <h2 ref={phaseHeadingRef} tabIndex={-1} className={`mt-1 ${phaseHeadingClass}`}>The work moves. You hold the helm.</h2>
        <p className="mt-1.5 max-w-[460px] text-[13.5px] leading-relaxed text-ink-secondary">
          Follow workstreams, review Gates, and direct new runs without staying at the Host Workbench.
        </p>
        <ValuePoints />
        <button
          onClick={c.start}
          disabled={c.statusPhase !== "ready" || !c.state || c.busy || c.accountBusy}
          className="mt-5 w-full max-w-[320px] rounded-md bg-accent py-2.5 text-[14px] font-medium text-accent-ink hover:bg-accent-border disabled:cursor-wait disabled:opacity-40"
        >
          {c.statusPhase === "loading"
            ? "Checking Mobile availability…"
            : c.statusPhase === "unavailable"
              ? "Mobile setup unavailable"
              : variant === "settings"
            ? c.state?.devices.length
              ? "Pair another Mobile device"
              : "Pair Helmryth Mobile"
            : "Set up Helmryth Mobile"}
        </button>
        {c.error && (
          <div role="alert" className="mt-3 max-w-[390px] text-[13px] text-danger">
            <p>{c.error}</p>
            {c.statusPhase === "unavailable" && (
              <button type="button" onClick={c.retryStatus} className="mt-2 min-h-9 rounded-md border border-danger/40 px-3 text-[12px] hover:bg-danger/10">
                Retry Mobile status
              </button>
            )}
          </div>
        )}
        {variant === "onboarding" && (
          <>
            <button
              onClick={() => {
                c.skip();
                onSkip?.();
              }}
              className="mt-2.5 min-h-9 rounded-md px-3 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              Not now
            </button>
            <p className="mt-2 text-[12px] text-ink-secondary">
              Resume anytime from System → Helmryth Mobile.
            </p>
          </>
        )}
      </div>
    );
  }

  if (c.phase === "sign-in") {
    const accountBridgeUnavailable = !c.accountBridgeAvailable;
    const unavailable = accountBridgeUnavailable || !c.account?.available;
    const failed = c.account?.status === "error" || c.setupTimedOut;
    return (
      <div className="mx-auto flex w-full max-w-[430px] flex-col">
        <button type="button" onClick={c.cancel} className="mb-4 flex min-h-9 w-fit items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex size-11 items-center justify-center rounded-md border border-hairline/60 bg-inset text-accent">
          <Mail size={20} />
        </div>
        <h2 ref={phaseHeadingRef} tabIndex={-1} className={`mt-3 ${phaseHeadingClass}`}>
          {unavailable || failed ? "Helmryth Relay needs recovery" : "Sign in to pair securely"}
        </h2>
        <p
          role={c.setupTimedOut ? "alert" : undefined}
          className="mt-1 text-[13px] leading-relaxed text-ink-secondary"
        >
          {accountBridgeUnavailable
            ? "Relay setup is unavailable in this desktop build. You can still pair directly on the same Wi-Fi."
            : unavailable
              ? "Helmryth Relay is unavailable right now. You can still pair directly on the same Wi-Fi."
            : c.setupTimedOut
              ? "Secure access is taking longer than expected. You can try again or pair directly on this Wi-Fi."
            : failed
              ? "We could not finish creating your private connection. Try again or pair directly on this Wi-Fi."
              : "We’ll email you a one-time code. No password needed."}
        </p>

        {!unavailable && !failed && (
          <div className="mt-5 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-secondary">Email</span>
              <input
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={c.email}
                disabled={c.accountBusy || c.codeSent}
                onChange={(event) => c.setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !c.codeSent && canSubmitEmail) c.requestCode();
                }}
                placeholder="you@example.com"
                className="min-h-9 rounded-md border border-hairline/60 bg-inset px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
              />
            </label>
            {c.codeSent && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-secondary">8-digit code</span>
                <input
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={c.code}
                  disabled={c.accountBusy}
                  onChange={(event) => c.setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && c.code.length === 8) c.verifyCode();
                  }}
                  placeholder="12345678"
                  className="min-h-9 rounded-md border border-hairline/60 bg-inset px-3 py-2 font-mono text-[16px] tracking-[0.18em] text-ink outline-none placeholder:tracking-normal placeholder:text-ink-secondary/60 focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                />
              </label>
            )}
            <button
              disabled={c.accountBusy || (!c.codeSent && !canSubmitEmail) || (c.codeSent && c.code.length !== 8)}
              onClick={c.codeSent ? c.verifyCode : c.requestCode}
              className="rounded-md bg-accent py-2.5 text-[14px] font-medium text-accent-ink hover:bg-accent-border disabled:opacity-40"
            >
              {c.accountBusy ? (c.codeSent ? "Verifying code…" : "Sending code…") : c.codeSent ? "Verify and continue" : "Email me a code"}
            </button>
            {c.codeSent && (
              <button
                disabled={c.accountBusy}
                onClick={c.changeEmail}
                className="min-h-9 rounded-md px-3 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
              >
                Use another email
              </button>
            )}
            {c.codeSent && !actionError && (
              <p className="text-[12px] text-ink-secondary">The code expires in 10 minutes.</p>
            )}
          </div>
        )}

        {!accountBridgeUnavailable && (unavailable || failed) && (
          <button
            disabled={c.accountBusy}
            onClick={c.retryAccount}
            className="mt-5 rounded-md bg-accent py-2.5 text-[14px] font-medium text-accent-ink disabled:opacity-40"
          >
            {c.accountBusy ? "Reconnecting Relay…" : "Reconnect Helmryth Relay"}
          </button>
        )}
        {actionError && <p role="alert" className="mt-3 text-[12.5px] text-danger">{actionError}</p>}
        <div className="my-4 flex items-center gap-3 text-[12px] text-ink-secondary">
          <span className="h-px flex-1 bg-hairline/40" /> or <span className="h-px flex-1 bg-hairline/40" />
        </div>
        {c.tailscaleAvailable && (
          <>
            <button
              disabled={c.busy || c.accountBusy}
              onClick={c.useTailscale}
              className="flex min-h-9 items-center justify-center gap-2 rounded-md border border-hairline/60 px-3 text-[13px] text-ink hover:bg-control disabled:opacity-40"
            >
              <ShieldCheck size={15} /> Pair over Tailscale
            </button>
            <p className="mt-2 text-center text-[12px] leading-relaxed text-ink-secondary">
              Your iPhone must be signed in to the same tailnet.
            </p>
          </>
        )}
        <button
          disabled={c.busy || c.accountBusy}
          onClick={c.useLocal}
          className={`${c.tailscaleAvailable ? "mt-3" : ""} flex min-h-9 items-center justify-center gap-2 rounded-md border border-hairline/60 px-3 text-[13px] text-ink hover:bg-control disabled:opacity-40`}
        >
          <Wifi size={15} /> Pair on this Wi-Fi instead
        </button>
        <p className="mt-2 text-center text-[12px] leading-relaxed text-ink-secondary">
          Both devices must be on a network that lets them see each other.
        </p>
      </div>
    );
  }

  if (c.phase === "verifying") {
    return (
      <div className="flex flex-col items-center py-8 text-center" role="status" aria-live="polite">
        <div className="flex size-14 items-center justify-center rounded-md border border-hairline/60 bg-inset text-accent">
          <Loader2 size={25} className="motion-safe:animate-spin" />
        </div>
        <h2 ref={phaseHeadingRef} tabIndex={-1} className={`mt-4 ${phaseHeadingClass}`}>
          {c.localFallback
            ? "Preparing your pairing code"
            : c.tailscaleFallback
              ? "Preparing Tailscale pairing"
              : "Preparing Helmryth Relay"}
        </h2>
        <p className="mt-1.5 max-w-[360px] text-[13px] leading-relaxed text-ink-secondary">
          {c.localFallback
            ? "Preparing a private route on this Wi-Fi."
            : c.tailscaleFallback
              ? "Your pairing code will use your private tailnet connection."
            : "Helmryth Relay gives this host workbench a private route that stays reachable away from this Wi-Fi."}
        </p>
        {(c.error || c.accountError) && (
          <p role="alert" className="mt-3 max-w-[380px] text-[12.5px] text-danger">{c.error ?? c.accountError}</p>
        )}
        <button type="button" onClick={c.cancel} className="mt-5 min-h-9 rounded-md px-3 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">Cancel</button>
      </div>
    );
  }

  if (c.phase === "success") {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-md border border-success/30 bg-success/15 text-success">
          <Check size={28} />
        </div>
        <h2 ref={phaseHeadingRef} tabIndex={-1} className={`mt-4 ${phaseHeadingClass}`}>Helmryth Mobile is ready</h2>
        <p className="mt-1.5 text-[13px] text-ink-secondary">
          This device can open workstreams, review Gates, and start runs.
        </p>
        <button
          onClick={() => {
            c.finish();
            onComplete?.();
          }}
          className="mt-5 w-full max-w-[280px] rounded-md bg-accent py-2.5 text-[14px] font-medium text-accent-ink"
        >
          {variant === "onboarding" ? "Start using Helmryth" : "Return to Mobile settings"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex size-12 items-center justify-center rounded-md border border-hairline/60 bg-card text-ink">
        <QrCode size={23} />
      </div>
      <h2 ref={phaseHeadingRef} tabIndex={-1} className={`mt-3 ${phaseHeadingClass}`} role="status" aria-live="polite">
        {c.pairingExpired ? "That code expired" : "Scan in Helmryth Mobile"}
      </h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        {c.pairingExpired
          ? "Create a fresh code when your Helmryth Mobile device is ready."
          : "Open Helmryth Mobile on your iPhone and scan this code."}
      </p>
      {!c.pairingExpired && c.pairingLink && (
        <div className="mt-4 rounded-md border border-hairline/60 bg-raised p-3.5" role="img" aria-label="QR code for pairing Helmryth Mobile">
          <QRCodeSVG value={c.pairingLink} size={180} level="M" bgColor="var(--color-raised)" fgColor="var(--color-ink)" />
        </div>
      )}
      {!c.pairingExpired && manualCodeMode === "direct" && c.state?.pairing && (
        <div className="mt-4 w-full max-w-[320px] rounded-md bg-inset px-4 py-3 text-[12.5px] text-ink-secondary">
          <div>Open Helmryth Mobile and enter this manual code.</div>
          <div className="mt-2 font-sans text-[22px] tabular-nums tracking-[0.25em] text-ink">
            {c.state.pairing.code}
          </div>
        </div>
      )}
      {!c.pairingExpired && manualCodeMode === "details" && c.state?.pairing && (
        <div className="mt-4 w-full max-w-[320px] border-y border-hairline/60 px-4 py-3 text-[12.5px] text-ink-secondary">
          <div>Can’t scan? Enter this code in Helmryth Mobile.</div>
          <div className="mt-2 font-sans text-[22px] tabular-nums tracking-[0.25em] text-ink">{c.state.pairing.code}</div>
          <div className="mt-1 text-[12px]">Expires in {c.secondsLeft}s</div>
        </div>
      )}
      {c.pairingExpired && (
        <button type="button" onClick={c.refreshCode} disabled={c.busy} className="mt-5 min-h-9 rounded-md bg-accent px-5 text-[14px] font-medium text-accent-ink disabled:opacity-50">
          {c.busy ? "Creating a new code…" : "Create a new code"}
        </button>
      )}
      {!c.pairingExpired && c.state?.pairing && c.address && (
        <details className="mt-4 w-full max-w-[390px] rounded-md border border-hairline/60 px-3 py-2 text-left">
          <summary className="cursor-pointer text-[12px] font-medium text-ink">Pairing trace</summary>
          <div className="mt-3 text-[12px] text-ink-secondary">
            <ConnectionDetail label="Pairing address" value={`${c.address}:${c.pairingPort}`} />
          </div>
        </details>
      )}
      <button type="button" onClick={c.cancel} className="mt-4 min-h-9 rounded-md px-3 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">Cancel</button>
    </div>
  );
}

export function PhoneSetupFlow({
  profileEmail,
  variant,
  onSkip,
  onComplete,
}: {
  profileEmail?: string;
  variant: "settings" | "onboarding";
  onSkip?: () => void;
  onComplete?: () => void;
}) {
  const controller = usePhoneSetupController(profileEmail);
  return (
    <PhoneSetupFlowView
      controller={controller}
      variant={variant}
      onSkip={onSkip}
      onComplete={onComplete}
    />
  );
}

export { companionPairingMode };

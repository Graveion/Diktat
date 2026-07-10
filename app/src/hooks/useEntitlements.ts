import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import Constants from "expo-constants";
import Purchases, { type CustomerInfo, type PurchasesPackage } from "react-native-purchases";
import { supabase } from "../store/supabase";

// Simulator dev: everything unlocked so we're never blocked — EXCEPT when we
// explicitly want to exercise the real RevenueCat/StoreKit path in a dev or
// preview build (sandbox account or an Xcode .storekit config) without an App
// Store submission. Set extra.forceIap: true (app.json) or EXPO_PUBLIC_FORCE_IAP=1.
const EXTRA = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
const FORCE_IAP = EXTRA.forceIap === true || process.env.EXPO_PUBLIC_FORCE_IAP === "1";
const MOCK_MODE = __DEV__ && !FORCE_IAP;

const PRO_ENTITLEMENT = "pro";
// Must match the relay's TRIAL_MS (supabase-auth.ts) — both gate the same window.
export const FREE_TRIAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days of free usage
// Production uses the live App Store key (must ship in the binary — it's a
// public client key). A forced-IAP dev/preview build prefers the RevenueCat
// *Test Store* key so the full purchase flow works with no Apple sandbox
// account and no submission. The test key is injected via env at test time
// (EXPO_PUBLIC_RC_TEST_KEY) and is NOT committed, so it never ships in a
// production bundle.
const RC_LIVE_KEY = (EXTRA.revenueCatIosKey as string) ?? "";
const RC_TEST_KEY = process.env.EXPO_PUBLIC_RC_TEST_KEY ?? "";
const RC_IOS_KEY = FORCE_IAP && RC_TEST_KEY ? RC_TEST_KEY : RC_LIVE_KEY;

let rcConfigured = false;

function parseTs(v: string | null | undefined): number | null {
  if (!v) return null;
  if (v.startsWith("infinity")) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export interface EntitlementsApi {
  ready: boolean;
  /** Pro via RevenueCat. */
  isPro: boolean;
  /** Comp access (redeemed friend code) currently active. */
  compActive: boolean;
  /** Seconds left in the free trial (0 once expired; full window if not started). */
  freeSecondsRemaining: number;
  /** Snapshot: does the user currently have access (pro || comp || free hour)? */
  entitled: boolean;
  /** Purchasable packages (monthly/annual) from the current offering. */
  packages: PurchasesPackage[];
  /** Gate a paid action: starts the free hour if needed; resolves true if allowed. */
  gateAccess: () => Promise<boolean>;
  purchase: (pkg: PurchasesPackage) => Promise<boolean>;
  restore: () => Promise<boolean>;
  redeemCode: (code: string) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

export function useEntitlements(): EntitlementsApi {
  const [ready, setReady] = useState(false);
  const [isPro, setIsPro] = useState(MOCK_MODE);
  const [trialStartedAt, setTrialStartedAt] = useState<number | null>(null);
  const [compUntil, setCompUntil] = useState<number | null>(null);
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [, setTick] = useState(0);
  const trialRef = useRef<number | null>(null);
  trialRef.current = trialStartedAt;

  // Coarse re-render so the free-hour countdown and expiry stay current.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const refreshAccountState = useCallback(async () => {
    const { data } = await supabase
      .from("account_state")
      .select("trial_started_at,comp_until")
      .maybeSingle();
    setTrialStartedAt(parseTs(data?.trial_started_at));
    setCompUntil(parseTs(data?.comp_until));
  }, []);

  useEffect(() => {
    let listener: ((ci: CustomerInfo) => void) | null = null;
    (async () => {
      if (MOCK_MODE) {
        setIsPro(true);
        setReady(true);
        return;
      }
      try {
        if (RC_IOS_KEY && !rcConfigured) {
          const { data } = await supabase.auth.getUser();
          Purchases.configure({ apiKey: RC_IOS_KEY, appUserID: data.user?.id });
          rcConfigured = true;
        }
        if (RC_IOS_KEY) {
          const info = await Purchases.getCustomerInfo();
          setIsPro(Boolean(info.entitlements.active[PRO_ENTITLEMENT]));
          const offerings = await Purchases.getOfferings();
          setPackages(offerings.current?.availablePackages ?? []);
          listener = (ci) => setIsPro(Boolean(ci.entitlements.active[PRO_ENTITLEMENT]));
          Purchases.addCustomerInfoUpdateListener(listener);
        }
      } catch {
        /* RC not reachable / not configured — fall back to trial + comp */
      }
      await refreshAccountState();
      setReady(true);
    })();
    return () => {
      if (listener) Purchases.removeCustomerInfoUpdateListener(listener);
    };
  }, [refreshAccountState]);

  // Refetch on foreground so a subscription bought on another device (or a
  // comp/trial change) shows up without an app restart.
  useEffect(() => {
    if (MOCK_MODE) return;
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      refreshAccountState().catch(() => {});
      if (rcConfigured) {
        Purchases.getCustomerInfo()
          .then((ci) => setIsPro(Boolean(ci.entitlements.active[PRO_ENTITLEMENT])))
          .catch(() => {});
      }
    });
    return () => sub.remove();
  }, [refreshAccountState]);

  const now = Date.now();
  const compActive = compUntil != null && compUntil > now;
  const freeSecondsRemaining =
    trialStartedAt == null
      ? Math.floor(FREE_TRIAL_MS / 1000)
      : Math.max(0, Math.floor((trialStartedAt + FREE_TRIAL_MS - now) / 1000));
  const entitled = isPro || compActive || freeSecondsRemaining > 0;

  const gateAccess = useCallback(async (): Promise<boolean> => {
    if (MOCK_MODE || isPro || compActive) return true;
    let start = trialRef.current;
    if (start == null) {
      const { data } = await supabase.rpc("start_trial");
      start = parseTs(data as string) ?? Date.now();
      setTrialStartedAt(start);
    }
    return Date.now() < start + FREE_TRIAL_MS;
  }, [isPro, compActive]);

  const purchase = useCallback(async (pkg: PurchasesPackage): Promise<boolean> => {
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      const ok = Boolean(customerInfo.entitlements.active[PRO_ENTITLEMENT]);
      setIsPro(ok);
      return ok;
    } catch (e: any) {
      if (e?.userCancelled) return false;
      throw e;
    }
  }, []);

  const restore = useCallback(async (): Promise<boolean> => {
    const info = await Purchases.restorePurchases();
    const ok = Boolean(info.entitlements.active[PRO_ENTITLEMENT]);
    setIsPro(ok);
    return ok;
  }, []);

  const redeemCode = useCallback(
    async (code: string): Promise<{ ok: boolean; error?: string }> => {
      const { data, error } = await supabase.rpc("redeem_comp_code", { code: code.trim() });
      if (error) return { ok: false, error: error.message };
      const res = data as { ok: boolean; error?: string };
      if (!res?.ok) return { ok: false, error: res?.error ?? "Invalid code" };
      await refreshAccountState();
      return { ok: true };
    },
    [refreshAccountState],
  );

  return {
    ready,
    isPro,
    compActive,
    freeSecondsRemaining,
    entitled,
    packages,
    gateAccess,
    purchase,
    restore,
    redeemCode,
    refresh: refreshAccountState,
  };
}

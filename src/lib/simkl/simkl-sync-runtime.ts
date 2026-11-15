import { useEffect } from "react";
import { requestSimklSync } from "./reconcile-watched";
import { getSession, subscribeSession } from "./session";

/**
 * App-level owner of the Simkl watched-sync cadence. Silent: the background
 * loop never toasts — only the manual "Sync now" button reports a result.
 * Force is reserved for a fresh connect; every other trigger is a delta run
 * through the activities gate inside loadSimklProgress.
 */
export function useSimklSyncLoop(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    void requestSimklSync(false);

    const onFocus = () => {
      if (document.visibilityState === "visible") void requestSimklSync(false);
    };
    const onSession = () => {
      // Connect is a force sync (the first import); disconnect is a no-op.
      if (getSession()) void requestSimklSync(true);
    };
    const onProfile = () => void requestSimklSync(false);

    const unsubscribeSession = subscribeSession(onSession);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("harbor:active-profile-changed", onProfile);
    window.addEventListener("harbor:account-provider-changed", onProfile);

    return () => {
      unsubscribeSession();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("harbor:active-profile-changed", onProfile);
      window.removeEventListener("harbor:account-provider-changed", onProfile);
    };
  }, [enabled]);
}

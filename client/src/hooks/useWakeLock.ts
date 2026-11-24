import { useEffect } from "react";

/**
 * Keeps the display awake while `enabled` (issue #172: a laptop dimming and
 * sleeping mid-talk). The Screen Wake Lock API is the browser's handle on the
 * same thing video players hold — on macOS, Chrome and Safari take a
 * PreventUserIdleDisplaySleep power assertion for it.
 *
 * The browser drops the lock whenever the page is hidden (another tab, a
 * minimized window), so it is taken again each time the page comes back.
 * Where the API is missing (older browsers, an insecure origin such as a LAN
 * IP over plain http) this does nothing; the OS's own settings apply.
 */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let disposed = false;

    const acquire = async () => {
      if (disposed || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        // Guarded by the "wakeLock" in navigator check above.
        // eslint-disable-next-line compat/compat
        const next = await navigator.wakeLock.request("screen");
        if (disposed) void next.release();
        else lock = next;
      } catch {
        // Refused (battery saver, a permissions policy): nothing to fall back to.
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
      lock = null;
    };
  }, [enabled]);
}

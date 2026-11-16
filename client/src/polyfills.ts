const MapProto = Map.prototype as Map<unknown, unknown> & {
  getOrInsertComputed?: (key: unknown, cb: (key: unknown) => unknown) => unknown;
};
if (!MapProto.getOrInsertComputed) {
  MapProto.getOrInsertComputed = function (this: Map<unknown, unknown>, key, cb) {
    if (this.has(key)) return this.get(key);
    const value = cb(key);
    this.set(key, value);
    return value;
  };
}

// pdf.js 6 calls Uint8Array.prototype.toHex() to fingerprint documents; older
// Android WebViews/Chromium lack it. Also loaded by the pdf.js worker.
const U8Proto = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
if (typeof U8Proto.toHex !== "function") {
  U8Proto.toHex = function (this: Uint8Array) {
    return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
  };
}

// pdf.js 6 does `Iterator.prototype.join` unguarded on the global; Safari < 18.4
// has no `Iterator` global at all (iPadOS 17).
if (typeof (globalThis as { Iterator?: unknown }).Iterator === "undefined") {
  const iteratorProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  (globalThis as { Iterator?: unknown }).Iterator = { prototype: iteratorProto };
}

// pdf.js calls URL.parse(), missing before Safari 18 / Chrome 126.
if (typeof (URL as { parse?: unknown }).parse !== "function") {
  (URL as unknown as { parse: (url: string | URL, base?: string | URL) => URL | null }).parse = (url, base) => {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

// pdf.js and app code use these unguarded; Safari < 17.4 / Chrome < 116 lack
// some of them. `npm run check:compat` lists what the bundle needs.
if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
  (Promise as unknown as { withResolvers: () => unknown }).withResolvers = function () {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// pdf.js 6's worker calls Promise.try(); Safari < 18.2 / Chrome < 128 lack it.
if (typeof (Promise as { try?: unknown }).try !== "function") {
  (Promise as unknown as { try: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown> }).try =
    function (fn, ...args) {
      return new Promise((resolve) => resolve(fn(...args)));
    };
}

if (typeof AbortSignal.any !== "function") {
  (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any = (signals) => {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
        signal: controller.signal,
      });
    }
    return controller.signal;
  };
}

if (typeof AbortSignal.timeout !== "function") {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("signal timed out", "TimeoutError")), ms);
    return controller.signal;
  };
}

if (typeof Array.prototype.toSorted !== "function") {
  Object.defineProperty(Array.prototype, "toSorted", {
    configurable: true,
    writable: true,
    value: function <T>(this: T[], compare?: (a: T, b: T) => number) {
      return [...this].sort(compare);
    },
  });
}

// Thin wrapper around the Umami tracker loaded in index.html. The script is
// absent in dev builds and blocked by plenty of extensions, so every call has
// to survive `window.umami` being undefined — analytics must never take the
// presentation down with it.

declare global {
  interface Window {
    umami?: {
      track: (name: string, data?: Record<string, unknown>) => void;
    };
  }
}

export function track(name: string, data?: Record<string, unknown>) {
  try {
    window.umami?.track(name, data);
  } catch {
    // Swallow: a failed beacon is never worth surfacing to a presenter.
  }
}

// Session recording (Umami's recorder.js, rrweb underneath). Not in
// index.html: it watches every DOM mutation, which a viewer — repainting the
// slide for a whole talk on whatever device the audience brought — shouldn't
// pay for, and the audience isn't who we're studying. So it's injected only
// once a page is known not to be a viewer (App for every route but /s/:id,
// Presentation once the role settles as controller). Sampled here rather than
// by the script's own data-sample-rate, so the unsampled majority never even
// downloads it; the draw is kept per tab, so a reload doesn't re-roll it.
const RECORDER_SRC = "https://analytics.presio.ch/recorder.js";
const WEBSITE_ID = "3b9c85c6-1dae-4a30-9508-200f274cb857";
const RECORD_SAMPLE_RATE = 0.1;
const RECORD_SAMPLED_KEY = "presio-record-sampled";

let recording = false;

function sampled(): boolean {
  try {
    let draw = sessionStorage.getItem(RECORD_SAMPLED_KEY);
    if (draw === null) {
      draw = Math.random() < RECORD_SAMPLE_RATE ? "1" : "0";
      sessionStorage.setItem(RECORD_SAMPLED_KEY, draw);
    }
    return draw === "1";
  } catch {
    return Math.random() < RECORD_SAMPLE_RATE;
  }
}

export function startRecording() {
  if (recording || !import.meta.env.PROD) return;
  recording = true;
  if (!sampled()) return;
  const script = document.createElement("script");
  script.src = RECORDER_SRC;
  script.async = true;
  script.dataset.websiteId = WEBSITE_ID;
  script.dataset.sampleRate = "1";
  script.dataset.maskLevel = "moderate";
  script.dataset.maxDuration = "300000";
  document.head.appendChild(script);
}

// SHA-256 of raw bytes, hex-encoded. Lets events fingerprint content (e.g.
// tell a recompiled deck apart from an identical re-upload) without any file
// contents leaving the browser — only the digest itself is ever sent.
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// What kind of file a PDF attachment is, from its name. Plugins can read any
// file a deck carries; JSON, images and videos are what decks are expected to
// carry, so the checkers flag anything else for a second look.

const MIME_BY_EXTENSION: Record<string, string> = {
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

/** An attachment's media type from its extension, or null when it isn't JSON,
 *  an image or a video. */
export function attachmentMime(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? null;
}

/** The warning for an attachment that isn't JSON, an image or a video, or null. */
export function unusualAttachmentWarning(filename: string): string | null {
  if (attachmentMime(filename)) return null;
  return "Not JSON, an image or a video — plugins can still read it, but check it's meant to be in the deck";
}

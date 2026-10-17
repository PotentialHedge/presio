import { useEffect, useRef, useState } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { FrameLink, Interactive, PluginHost, SlidePage, SlideView } from "@/lib/plugins/host";
import type { LoadedPlugin, PluginPermission, PluginSurface } from "@/lib/plugins/manifest";
import { cn } from "@/lib/utils";

// Media permissions, as the iframe features they unlock.
const MEDIA_FEATURES: Partial<Record<PluginPermission, string>> = {
  screen: "display-capture",
  camera: "camera",
  microphone: "microphone",
};

/** The frame's `allow`: players inside (YouTube, Vimeo, <video>) may autoplay
 *  and go fullscreen, plus whatever media the plugin asked for. Read when the
 *  frame loads, which is once per plugin version (see below). */
const frameAllow = (plugin: LoadedPlugin) =>
  ["autoplay", "fullscreen", "picture-in-picture", ...plugin.manifest.permissions.flatMap((p) => MEDIA_FEATURES[p] ?? [])].join("; ");

/**
 * One plugin surface: an iframe running plugin-frame.html, booted with the
 * plugin's HTML and a MessagePort into the host.
 *
 * Not a sandbox: plugins are trusted, like VS Code extensions, and run on this
 * origin with the network and embeds (YouTube, Vimeo) available. The frame is
 * there so a plugin only sees the `presio` API and can't break the page around
 * it; audiences are protected by the separate viewer origin instead. Key it by
 * the plugin's hash so a new version gets a fresh frame rather than a second
 * boot of the old one.
 */
export function PluginFrame({
  host,
  plugin,
  surface,
  panel,
  onVisibleChange,
  onInteractiveChange,
  onReady,
  onContentSize,
  visible,
  view,
  page,
  hovered,
  frameRef,
  className,
  style,
}: {
  host: PluginHost;
  plugin: LoadedPlugin;
  surface: PluginSurface;
  /** Panel surface: which of the plugin's panels this frame draws. */
  panel?: string;
  onVisibleChange?: (visible: boolean) => void;
  onInteractiveChange?: (value: Interactive) => void;
  /** The plugin's document is in place — e.g. to listen to it (same origin). */
  onReady?: (frame: HTMLIFrameElement) => void;
  /** Viewer sheet: how tall the plugin's document is (CSS pixels). */
  onContentSize?: (height: number) => void;
  /** Whether Presio shows the frame's container: the plugin hears when
   *  this changes (the viewer dismissed its sheet). */
  visible?: boolean;
  /** Slide surface: the part of it on screen, and its zoom. */
  view?: SlideView;
  /** Slide surface: where the page is within it. */
  page?: SlidePage;
  /** Slide surface: whether a mouse is over the slide. */
  hovered?: boolean;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ownRef = useRef<HTMLIFrameElement>(null);
  const ref = frameRef ?? ownRef;
  const hooksRef = useLatestRef({ onVisibleChange, onInteractiveChange, onReady, onContentSize });
  const [link, setLink] = useState<FrameLink | null>(null);

  useEffect(() => {
    if (view) link?.setView(view);
  }, [link, view]);
  useEffect(() => {
    if (page) link?.setPage(page);
  }, [link, page]);
  useEffect(() => {
    if (hovered !== undefined) link?.setHovered(hovered);
  }, [link, hovered]);
  useEffect(() => {
    if (visible !== undefined) link?.setVisible(visible);
  }, [link, visible]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let connection: FrameLink | null = null;
    // Once per mount: writing the plugin's document into the frame fires
    // `load` again, and a second boot would close the port it's using.
    const boot = () => {
      if (connection) return;
      const { port1, port2 } = new MessageChannel();
      connection = host.connect(
        plugin,
        surface,
        port1,
        {
          onVisible: (v) => hooksRef.current.onVisibleChange?.(v),
          onInteractive: (v) => hooksRef.current.onInteractiveChange?.(v),
          onReady: () => hooksRef.current.onReady?.(frame),
          onContentSize: (h) => hooksRef.current.onContentSize?.(h),
        },
        panel
      );
      setLink(connection);
      // The handshake: protocol, capabilities and context, with the port.
      frame.contentWindow?.postMessage(
        host.bootMessage(plugin, surface, panel),
        // Same origin as this page: it's the frame page this component loaded.
        window.location.origin,
        [port2]
      );
    };
    frame.addEventListener("load", boot);
    // A rerun of this effect finds the frame already booted, on the port the
    // cleanup just closed. Load it afresh rather than leave it running deaf.
    if (frame.dataset.booted) frame.src = "/plugin-frame.html";
    frame.dataset.booted = "1";
    return () => {
      frame.removeEventListener("load", boot);
      connection?.disconnect();
      setLink(null);
    };
  }, [host, plugin, surface, panel, hooksRef, ref]);

  return (
    <iframe
      ref={ref}
      src="/plugin-frame.html"
      allow={frameAllow(plugin)}
      title={plugin.manifest.displayName}
      data-testid={`plugin-frame-${plugin.id}-${surface}${panel ? `-${panel}` : ""}`}
      className={cn("border-0 bg-transparent", className)}
      style={style}
    />
  );
}

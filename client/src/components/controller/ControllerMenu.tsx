import type { Deck } from "@/lib/deck";
import type { PluginHost } from "@/lib/plugins/host";
import { Menu, X, RefreshCw, Settings, ExternalLink, Share2, KeyRound, MonitorPlay, Power, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DownloadButton } from "@/components/DownloadButton";

// Slide-over menu for the narrow controller — phones, and any window too small
// for the full header/footer toolbars. Purely presentational: every action is a
// callback the parent (ControllerView) wires to its single set of
// dialogs/handlers, so there is no duplicated Share/Confirm-End/end-session
// logic living down here. Items whose handler is omitted don't appear, which is
// how the phone (switch this tab to the viewer) and a narrow desktop window
// (open a second viewer window, settings) differ.
export function ControllerMenu({
  open,
  onOpen,
  onClose,
  deck,
  pluginHost,
  canSharePassphrase,
  onShare,
  onShowPassphrase,
  onSwitchToViewer,
  onReplaceClick,
  onEndClick,
  onSettings,
  onOpenViewer,
  onCommands,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  deck: Deck;
  /** Plugins that transform the downloaded PDF. */
  pluginHost?: PluginHost;
  /** Whether shared control can be handed out (synced sessions only — a local
   *  deck is same-device, so there is nobody remote to grant control to). */
  canSharePassphrase: boolean;
  onShare: () => void;
  onShowPassphrase: () => void;
  /** Take over presenting in this tab (phone: there is no second window). */
  onSwitchToViewer?: () => void;
  onReplaceClick: () => void;
  onEndClick: () => void;
  /** Opens the settings dialog — the gear that the wide header shows inline. */
  onSettings?: () => void;
  /** Opens the viewer in its own window (desktop only). */
  onOpenViewer?: () => void;
  /** Opens the command palette. */
  onCommands?: () => void;
}) {
  // Run an action after dismissing the drawer.
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <>
      <Button size="icon-sm" variant="ghost" onClick={onOpen}>
        <Menu size={20} />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <div className="absolute top-0 right-0 w-64 h-full bg-background border-l shadow-lg flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="text-sm font-semibold">Menu</span>
              <Button size="icon-sm" variant="ghost" onClick={onClose}>
                <X size={18} />
              </Button>
            </div>
            <div className="flex-1 flex flex-col gap-1 overflow-y-auto p-2">
              {onCommands && (
                <Button variant="ghost" className="justify-start" data-testid="menu-commands" onClick={act(onCommands)}>
                  <Search size={16} className="mr-2" />
                  Commands
                </Button>
              )}
              <Button variant="ghost" className="justify-start" onClick={act(onShare)}>
                <Share2 size={16} className="mr-2" />
                Share
              </Button>
              {canSharePassphrase && (
                <Button variant="ghost" className="justify-start" onClick={act(onShowPassphrase)}>
                  <KeyRound size={16} className="mr-2" />
                  Passphrase
                </Button>
              )}
              {onOpenViewer && (
                <Button variant="ghost" className="justify-start" onClick={act(onOpenViewer)}>
                  <ExternalLink size={16} className="mr-2" />
                  Open Viewer
                </Button>
              )}
              {onSwitchToViewer && (
                <Button variant="ghost" className="justify-start" onClick={act(onSwitchToViewer)}>
                  <MonitorPlay size={16} className="mr-2" />
                  Switch to Viewer
                </Button>
              )}
              <Button variant="ghost" className="justify-start" data-testid="deck-replace" onClick={act(onReplaceClick)}>
                <RefreshCw size={16} className="mr-2" />
                Replace PDF…
              </Button>
              <DownloadButton deck={deck} plugins={pluginHost} size="default" block />
              {onSettings && (
                <Button variant="ghost" className="justify-start" onClick={act(onSettings)}>
                  <Settings size={16} className="mr-2" />
                  Settings
                </Button>
              )}
              <ThemeToggle block />
              <div className="mt-auto">
                <Button variant="destructive" className="w-full" onClick={act(onEndClick)}>
                  <Power size={16} className="mr-2" />
                  End Presentation
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

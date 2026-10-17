import { Card, CardContent } from "@/components/ui/card";
import { createPortal } from "react-dom";

export function DialogOverlay({
  children,
  onClose,
  maxWidth = "max-w-sm",
  bare = false,
  layer = "z-50",
}: {
  children: React.ReactNode;
  onClose: () => void;
  maxWidth?: string;
  /** Skip the card's padding and spacing: the content lays itself out. */
  bare?: boolean;
  /** Its z-index class: above other dialogs for one that can open over them. */
  layer?: string;
}) {
  // Portal to <body> so the overlay always covers the viewport: an ancestor
  // with backdrop-filter (e.g. the home page's blurred nav) would otherwise
  // become the containing block for this fixed element and collapse it to
  // that ancestor's box.
  return createPortal(
    <div
      className={`fixed inset-0 ${layer} flex items-center justify-center bg-black/60 backdrop-blur-sm`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {bare ? (
        <Card className={`w-full ${maxWidth} max-h-[90dvh] overflow-hidden gap-0 py-0`}>{children}</Card>
      ) : (
        <Card className={`w-full ${maxWidth} max-h-[90dvh] overflow-y-auto`}>
          <CardContent className="pt-6 space-y-4">{children}</CardContent>
        </Card>
      )}
    </div>,
    document.body
  );
}

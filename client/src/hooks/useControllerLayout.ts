import { useCallback, useState } from "react";
import type { MosaicNode } from "react-mosaic-component";
import {
  addLeaf,
  defaultLayout,
  hasPreferredLayout,
  LAYOUT_PRESETS,
  loadLayout,
  loadPreferred,
  removeLeaf,
  saveLayout,
  savePreferred,
  visibleKeys,
  type LayoutForm,
} from "@/lib/controllerLayout";

/**
 * The controller dashboard's arrangement for this screen's form factor
 * (lib/controllerLayout): the tree, which cards it shows, and the Settings
 * actions on it. Every change is saved for this form.
 */
export function useControllerLayout(layoutForm: LayoutForm) {
  const [mosaic, setMosaic] = useState<MosaicNode<string> | null>(() => loadLayout(layoutForm));
  // Crossing the breakpoint (rotating a tablet, resizing a window) swaps in
  // that form's own tree. Adjusting during render rather than in an effect
  // keeps the dashboard from painting one frame with the wrong layout.
  const [renderedForm, setRenderedForm] = useState(layoutForm);
  if (renderedForm !== layoutForm) {
    setRenderedForm(layoutForm);
    setMosaic(loadLayout(layoutForm));
  }
  const [hasPreferred, setHasPreferred] = useState(hasPreferredLayout);
  // A card is shown iff it's a leaf in the tree; this drives the Settings checkboxes.
  const visible = new Set(visibleKeys(mosaic));

  const onMosaicChange = useCallback((node: MosaicNode<string> | null) => {
    setMosaic(node);
    saveLayout(layoutForm, node);
  }, [layoutForm]);

  // Applying a preset writes it to *this* screen's stored tree, so choosing
  // the desktop grid on a phone doesn't change what a desktop starts with.
  const applyPreset = useCallback((form: LayoutForm) => {
    const layout = defaultLayout(form);
    setMosaic(layout);
    saveLayout(layoutForm, layout);
  }, [layoutForm]);

  const activePreset = LAYOUT_PRESETS.find(
    (p) => JSON.stringify(mosaic) === JSON.stringify(defaultLayout(p.form))
  )?.form;

  const resetLayout = useCallback(() => {
    const fresh = defaultLayout(layoutForm);
    setMosaic(fresh);
    saveLayout(layoutForm, fresh);
  }, [layoutForm]);

  const savePreferredLayout = useCallback(() => {
    savePreferred(mosaic);
    setHasPreferred(true);
  }, [mosaic]);

  const restorePreferredLayout = useCallback(() => {
    const pref = loadPreferred();
    if (!pref) return;
    setMosaic(pref);
    saveLayout(layoutForm, pref);
  }, [layoutForm]);

  const toggleCard = useCallback((key: string) => {
    setMosaic((prev) => {
      const next = visibleKeys(prev).includes(key)
        ? removeLeaf(prev, key)
        : addLeaf(prev, key);
      saveLayout(layoutForm, next);
      return next;
    });
  }, [layoutForm]);

  return {
    mosaic,
    visible,
    hasPreferred,
    activePreset,
    onMosaicChange,
    applyPreset,
    resetLayout,
    savePreferredLayout,
    restorePreferredLayout,
    toggleCard,
  };
}

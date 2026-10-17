import { useState, type RefObject } from "react";

/**
 * A ref that also tells you which element it's on, as state: pass the ref
 * wherever a RefObject goes, and depend on the element in effects. A plain
 * ref doesn't re-run anything when its element is replaced — a dashboard card
 * remounting when the layout changes, say — so effects bound to the old one
 * keep working on a detached node.
 */
export function useElementRef<T extends HTMLElement>(): [RefObject<T | null>, T | null] {
  const [element, setElement] = useState<T | null>(null);
  const [ref] = useState<RefObject<T | null>>(() => {
    let current: T | null = null;
    return {
      get current() {
        return current;
      },
      set current(el: T | null) {
        current = el;
        setElement(el);
      },
    };
  });
  return [ref, element];
}

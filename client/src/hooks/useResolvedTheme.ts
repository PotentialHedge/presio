import { useEffect, useState } from "react";

const read = (): "light" | "dark" =>
  typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";

/**
 * The theme on screen. ThemeProvider toggles `dark` on <html>, so this watches
 * that class rather than prefers-color-scheme — the in-app toggle has to win.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

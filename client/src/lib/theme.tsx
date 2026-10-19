import { useEffect } from "react";
import { ThemeContext, type Theme } from "@/hooks/useTheme";
import { useSetting } from "@/lib/settings";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useSetting("theme");

  useEffect(() => {
    const root = document.documentElement;
    const apply = (t: Theme) => {
      const dark =
        t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
    };

    apply(theme);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => apply("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

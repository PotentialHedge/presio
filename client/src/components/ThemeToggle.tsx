import { useTheme } from "@/hooks/useTheme";
import { Button } from "@/components/ui/button";

const icons = {
  light: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  ),
  dark: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  ),
  system: (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" /><path d="M12 17v4" />
    </svg>
  ),
};

const next = { system: "light", light: "dark", dark: "system" } as const;

const LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

export function ThemeToggle({
  size = "sm",
  /** Menu row: full width, icon and label on the left like its neighbours,
   *  rather than the bare icon the toolbars use. */
  block = false,
}: {
  size?: "sm" | "icon";
  block?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  return (
    <Button
      className={block ? "w-full justify-start" : "text-muted-foreground hover:text-foreground"}
      size={block ? "default" : size}
      variant="ghost"
      onClick={() => setTheme(next[theme])}
      title={`Theme: ${theme} — click for ${next[theme]}`}
    >
      {icons[theme]}
      {block && <span className="ml-2">Theme: {LABELS[theme]}</span>}
    </Button>
  );
}

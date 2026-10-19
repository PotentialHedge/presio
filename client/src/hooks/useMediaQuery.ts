import { useEffect, useState } from "react";

/** Whether a CSS media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const read = () => setMatches(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, [query]);
  return matches;
}

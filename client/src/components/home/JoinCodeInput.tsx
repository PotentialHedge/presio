import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { track } from "@/lib/analytics";

const CODE_LENGTH = 6;

/** One box per character of a join code; a full code opens that session as a viewer. */
export function JoinCodeInput() {
  const navigate = useNavigate();
  const [chars, setChars] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const charRefs = useRef<(HTMLInputElement | null)[]>([]);
  const code = chars.join("");

  useEffect(() => {
    if (code.length !== CODE_LENGTH) return;
    track("join-code");
    navigate(`/s/${code}?role=viewer`);
  }, [code, navigate]);

  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length: CODE_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            charRefs.current[i] = el;
          }}
          type="text"
          inputMode="text"
          maxLength={1}
          aria-label={`Session code, character ${i + 1} of ${CODE_LENGTH}`}
          value={chars[i]}
          className="h-12 w-10 rounded-md border border-input bg-background text-center font-mono text-lg font-bold uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
          onChange={(e) => {
            const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
            if (!val) return;
            const next = [...chars];
            next[i] = val[val.length - 1];
            setChars(next);
            if (i < CODE_LENGTH - 1) charRefs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              const next = [...chars];
              if (chars[i]) {
                next[i] = "";
                setChars(next);
              } else if (i > 0) {
                next[i - 1] = "";
                setChars(next);
                charRefs.current[i - 1]?.focus();
              }
            } else if (e.key === "ArrowLeft" && i > 0) {
              charRefs.current[i - 1]?.focus();
            } else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) {
              charRefs.current[i + 1]?.focus();
            } else if (e.key === "Enter" && code.length === CODE_LENGTH) {
              navigate(`/s/${code}?role=viewer`);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData("text").toUpperCase().replace(/[^A-Z0-9]/g, "");
            const next = [...chars];
            for (let j = 0; j < CODE_LENGTH - i && j < pasted.length; j++) {
              next[i + j] = pasted[j];
            }
            setChars(next);
            const focusIdx = Math.min(i + pasted.length, CODE_LENGTH - 1);
            charRefs.current[focusIdx]?.focus();
          }}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

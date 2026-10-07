import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../../components/atoms/Button";

// Tailwind only emits classes it can see whole, so each clamp is spelled out.
const CLAMP_CLASS = { 3: "line-clamp-3", 6: "line-clamp-6" } as const;

interface Props {
  text: string;
  className?: string;
  lineCount?: keyof typeof CLAMP_CLASS;
}

/**
 * Clamps long artifact prose to a few lines. The toggle appears only when the
 * clamp actually hides text, re-measured as the pane resizes.
 */
export function ExpandableText({ text, className = "", lineCount = 3 }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || isExpanded) return;
    const measure = () => setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    // jsdom has no ResizeObserver; the initial measure is all a test needs.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, isExpanded]);

  return (
    <div className="min-w-0 flex-1">
      <p ref={textRef} className={`${isExpanded ? "" : CLAMP_CLASS[lineCount]} ${className}`.trim()}>{text}</p>
      {isOverflowing && (
        <Button variant="link" className="mt-0.5 text-xs! no-underline! hover:underline!" aria-expanded={isExpanded} onClick={() => setIsExpanded(!isExpanded)}>
          {isExpanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

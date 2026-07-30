"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Estimated height while waiting (reduces layout jump). */
  minHeight?: number;
  rootMargin?: string;
}

/**
 * Mounts children only when near the viewport — cuts homepage DOM weight.
 */
export function LazyRail({
  children,
  minHeight = 280,
  rootMargin = "200px 0px",
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /**
   * No IntersectionObserver means nothing will ever tell us the rail is on
   * screen, so the only correct answer is "render it" — and that is an initial
   * VALUE, resolved in the initializer rather than by an effect that would
   * render an empty placeholder first and then immediately replace it.
   */
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined"
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin, threshold: 0.01 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, rootMargin]);

  return (
    <div ref={ref} style={visible ? undefined : { minHeight }}>
      {visible ? children : null}
    </div>
  );
}

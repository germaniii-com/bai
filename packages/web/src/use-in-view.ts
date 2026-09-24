import { useEffect, useRef, useState } from "react";

/**
 * True once the element has scrolled within `rootMargin` of the viewport
 * (and stays true once seen). Extracted from video card lazy-loading so the
 * image/video galleries can share it for infinite scroll sentinels.
 *
 * Falls back to always-visible when IntersectionObserver is unavailable
 * (older WebViews) — callers then treat `inView` as "go ahead".
 */
export function useInView<T extends Element>(rootMargin = "400px"): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setInView(true);
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}

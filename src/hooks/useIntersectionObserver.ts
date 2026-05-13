import { useState, useEffect, MutableRefObject } from 'react';

export function useIntersectionObserver(
  ref: MutableRefObject<Element | null>,
  options: IntersectionObserverInit = { threshold: 0.1, rootMargin: '100px' }
): boolean {
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    if (!ref.current) return;

    const observer = new IntersectionObserver(([entry]) => {
      setIsIntersecting(entry.isIntersecting);
    }, options);

    observer.observe(ref.current);

    return () => {
      if (ref.current) {
        observer.unobserve(ref.current);
      }
      observer.disconnect();
    };
  }, [ref, options.threshold, options.rootMargin, options.root]);

  return isIntersecting;
}

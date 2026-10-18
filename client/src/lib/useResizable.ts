import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag-resize for a vertical panel edge (sidebar width) or a horizontal edge
 * (terminal height). Returns the current size in px, a ref to attach to the
 * divider element, and whether a drag is active (for cursor/body styling).
 */
export function useResizable(
  initial: number,
  {
    min = 120,
    max = 800,
    direction = "left", // "left": panel on the left (drag right edge); "right": panel on the right; "top": panel below (drag top edge, e.g. terminal)
    localStorageKey,
  }: {
    min?: number;
    max?: number;
    direction?: "left" | "right" | "top";
    localStorageKey?: string;
  } = {},
) {
  const [size, setSize] = useState<number>(() => {
    if (localStorageKey) {
      const saved = Number(localStorage.getItem(localStorageKey));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    }
    return initial;
  });
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      setDragging(true);
    },
    [],
  );

  useEffect(() => {
    if (!dragging) return;

    const move = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      let next: number;
      if (direction === "top") {
        // terminal: distance from the bottom of the window to the cursor
        next = window.innerHeight - e.clientY;
      } else if (direction === "right") {
        next = window.innerWidth - e.clientX;
      } else {
        next = e.clientX;
      }
      next = Math.min(Math.max(next, min), max);
      setSize(next);
    };

    const up = () => {
      draggingRef.current = false;
      setDragging(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = direction === "top" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, direction, min, max]);

  // persist
  useEffect(() => {
    if (localStorageKey) localStorage.setItem(localStorageKey, String(size));
  }, [size, localStorageKey]);

  return { size, setSize, dragging, onPointerDown };
}

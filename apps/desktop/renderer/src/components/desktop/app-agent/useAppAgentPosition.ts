import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

const storageKey = "letagents-desktop:app-agent-position";
const launcherSize = 76;
const panelWidth = 390;
const estimatedPanelHeight = 260;
const launcherOrbCenterOffset = { x: launcherSize / 2, y: launcherSize / 2 };
const panelOrbCenterOffset = { x: 37, y: 36 };
const viewportMargin = 12;
const topViewportMargin = 72;

export function appAgentPanelPositionFromLauncher(
  launcherPosition: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: launcherPosition.x + launcherOrbCenterOffset.x - panelOrbCenterOffset.x,
    y: launcherPosition.y + launcherOrbCenterOffset.y - panelOrbCenterOffset.y,
  };
}

export function appAgentLauncherPositionFromPanel(
  panelPosition: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: panelPosition.x + panelOrbCenterOffset.x - launcherOrbCenterOffset.x,
    y: panelPosition.y + panelOrbCenterOffset.y - launcherOrbCenterOffset.y,
  };
}

export function appAgentOrbCenterFromLauncherPosition(
  launcherPosition: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: launcherPosition.x + launcherOrbCenterOffset.x,
    y: launcherPosition.y + launcherOrbCenterOffset.y,
  };
}

export function appAgentOrbCenterFromPanelPosition(
  panelPosition: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: panelPosition.x + panelOrbCenterOffset.x,
    y: panelPosition.y + panelOrbCenterOffset.y,
  };
}

export function appAgentClampTopLeft(
  topLeft: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.min(
      Math.max(viewportMargin, topLeft.x),
      Math.max(viewportMargin, viewport.width - size.width - viewportMargin),
    ),
    y: Math.min(
      Math.max(topViewportMargin, topLeft.y),
      Math.max(topViewportMargin, viewport.height - size.height - viewportMargin),
    ),
  };
}

export function appAgentPanelPositionForLauncher(
  launcherPosition: { x: number; y: number },
  panelSize: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return appAgentClampTopLeft(
    appAgentPanelPositionFromLauncher(launcherPosition),
    panelSize,
    viewport,
  );
}

export function useAppAgentPosition(
  open: Ref<boolean>,
  surfaceElement: Ref<HTMLElement | null>,
) {
  const position = ref({ x: 0, y: 0 });
  const launcherPosition = ref({ x: 0, y: 0 });
  const dragMoved = ref(false);
  const suppressClick = ref(false);
  let resizeObserver: ResizeObserver | null = null;

  const positionStyle = computed(() => ({
    left: `${position.value.x}px`,
    top: `${position.value.y}px`,
  }));

  function consumeSuppressedClick(): boolean {
    if (!suppressClick.value) return false;
    suppressClick.value = false;
    return true;
  }

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { ...position.value };
    const pointerId = event.pointerId;
    const target = event.currentTarget as HTMLElement;
    dragMoved.value = false;
    target.setPointerCapture?.(pointerId);

    function handlePointerMove(moveEvent: PointerEvent): void {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        dragMoved.value = true;
      }
      position.value = {
        x: initial.x + dx,
        y: initial.y + dy,
      };
      clampPosition();
    }

    function handlePointerUp(): void {
      target.releasePointerCapture?.(pointerId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      suppressClick.value = dragMoved.value;
      rememberPosition();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  function restorePosition(): void {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "null") as
        | { x?: number; y?: number }
        | null;
      if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
        rememberLauncherPosition({ x: Number(parsed.x), y: Number(parsed.y) }, true);
        return;
      }
    } catch {
      // Position persistence is optional.
    }
    rememberLauncherPosition({
      x: Math.max(16, window.innerWidth - 96),
      y: Math.max(84, window.innerHeight - 124),
    }, true);
  }

  function rememberPosition(): void {
    const anchorPosition = open.value
      ? appAgentLauncherPositionFromPanel(position.value)
      : position.value;
    rememberLauncherPosition(anchorPosition, !open.value);
  }

  function rememberLauncherPosition(
    anchorPosition: { x: number; y: number },
    syncCurrentSurface: boolean,
  ): void {
    const nextLauncherPosition = clampTopLeft(anchorPosition, {
      width: launcherSize,
      height: launcherSize,
    });
    launcherPosition.value = nextLauncherPosition;
    if (syncCurrentSurface) {
      position.value = nextLauncherPosition;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(nextLauncherPosition));
    } catch {
      // Position persistence is optional.
    }
  }

  function clampPosition(nextOpen = open.value): void {
    position.value = clampTopLeft(position.value, surfaceSize(nextOpen));
  }

  function clampTopLeft(
    topLeft: { x: number; y: number },
    size: { width: number; height: number },
  ): { x: number; y: number } {
    return appAgentClampTopLeft(topLeft, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }

  function surfaceSize(nextOpen: boolean): { width: number; height: number } {
    if (!nextOpen) {
      return { width: launcherSize, height: launcherSize };
    }
    const rect = surfaceElement.value?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      return {
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      };
    }
    return {
      width: Math.min(panelWidth, Math.max(0, window.innerWidth - viewportMargin * 2)),
      height: Math.min(estimatedPanelHeight, Math.max(0, window.innerHeight - topViewportMargin - viewportMargin)),
    };
  }

  function placePanelFromLauncher(): void {
    position.value = appAgentPanelPositionFromLauncher(launcherPosition.value);
    clampPosition(true);
  }

  function placeLauncherFromPanelOrb(): void {
    position.value = launcherPosition.value;
    clampPosition(false);
    rememberLauncherPosition(position.value, true);
  }

  function handleResize(): void {
    clampPosition();
    if (!open.value) {
      rememberLauncherPosition(position.value, true);
    }
  }

  onMounted(() => {
    restorePosition();
    window.addEventListener("resize", handleResize);
    if (typeof ResizeObserver !== "undefined" && surfaceElement.value) {
      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          clampPosition();
        });
      });
      resizeObserver.observe(surfaceElement.value);
    }
  });

  watch(open, () => {
    window.requestAnimationFrame(() => {
      clampPosition();
      if (!open.value) {
        rememberLauncherPosition(position.value, true);
      }
    });
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", handleResize);
    resizeObserver?.disconnect();
  });

  return {
    consumeSuppressedClick,
    placeLauncherFromPanelOrb,
    placePanelFromLauncher,
    positionStyle,
    startDrag,
  };
}

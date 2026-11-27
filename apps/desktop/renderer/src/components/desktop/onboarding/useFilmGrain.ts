import { onMounted, ref } from "vue";

// One small noise tile, made once per page and shared by every onboarding screen.
let tileUrl = "";

/** The same film grain on each onboarding screen, so they read as one place. */
export function useFilmGrain() {
  const grain = ref(tileUrl ? `url(${tileUrl})` : "");
  onMounted(() => {
    if (!tileUrl) {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 160;
      // No canvas (a test page): no grain, nothing else changes.
      const context = typeof tile.getContext === "function" ? tile.getContext("2d") : null;
      if (!context) return;
      const image = context.createImageData(160, 160);
      for (let i = 0; i < image.data.length; i += 4) {
        const value = Math.random() * 255;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
        image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      tileUrl = tile.toDataURL();
    }
    grain.value = `url(${tileUrl})`;
  });
  return grain;
}

// Tiles with the strength baked into each pixel, by strength.
const behindTiles = new Map<number, string>();

/**
 * The same grain as a tile that is already faint, so it can be a plain
 * background under content instead of a faded layer on top of it. Over black
 * it matches the onboarding grain at `strength`.
 */
export function useFilmGrainBehind(strength = 0.045) {
  const grain = ref(behindTiles.has(strength) ? `url(${behindTiles.get(strength)})` : "");
  onMounted(() => {
    if (!behindTiles.has(strength)) {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 160;
      // No canvas (a test page): no grain, nothing else changes.
      const context = typeof tile.getContext === "function" ? tile.getContext("2d") : null;
      if (!context) return;
      const image = context.createImageData(160, 160);
      const alpha = Math.round(255 * strength);
      for (let i = 0; i < image.data.length; i += 4) {
        const value = Math.random() * 255;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
        image.data[i + 3] = alpha;
      }
      context.putImageData(image, 0, 0);
      behindTiles.set(strength, tile.toDataURL());
    }
    grain.value = `url(${behindTiles.get(strength)})`;
  });
  return grain;
}


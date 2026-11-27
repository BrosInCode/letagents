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
      const context = tile.getContext("2d");
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

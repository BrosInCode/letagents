export function parseSipsDimensions(output) {
  const text = String(output ?? "");
  const width = Number(text.match(/\bpixelWidth:\s*(\d+)\b/)?.[1]);
  const height = Number(text.match(/\bpixelHeight:\s*(\d+)\b/)?.[1]);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error("Could not read positive pixelWidth and pixelHeight values from sips output.");
  }
  return { width, height };
}

export function assertSquareImageDimensions({ width, height }, label = "Application icon") {
  if (width !== height) {
    throw new Error(`${label} must be square; received ${width}x${height}.`);
  }
  return { width, height };
}

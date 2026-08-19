/** Recolors a white-on-transparent waveform PNG (a data URI) to an
 * arbitrary hex color by compositing it onto an offscreen canvas with
 * `globalCompositeOperation = "source-in"` — the source's alpha channel is
 * kept exactly, only its RGB is replaced, so this is exact-hue rather than
 * a CSS `filter` hue-rotate approximation. */
export function recolor(dataUri: string, hex: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2d canvas context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = hex;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("failed to load waveform image for recoloring"));
    img.src = dataUri;
  });
}

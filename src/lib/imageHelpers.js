// Client-side image helpers for sending photos to Claude vision.
//
// Anthropic's API only accepts image/jpeg, image/png, image/gif, image/webp.
// So we always need to *convert* whatever the user picked into JPEG via
// a canvas. If the browser can't decode the source image at all (some
// HEIC files, AVIF, raw camera files, PDFs accidentally selected), we
// throw a clear error rather than sending bytes Anthropic will reject.

// Try to decode an image source (File / Blob / URL) into something we
// can drawImage().
async function decodeImage(source) {
  if (typeof source === 'string') {
    // It's a URL — load via <img>.
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(new Error("Browser couldn't load the image from URL."));
      img.src = source;
    });
  }
  // Blob/File path — prefer createImageBitmap for broader codec support.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(source);
    } catch {
      /* fall through */
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser couldn't decode the image."));
    };
    img.src = url;
  });
}

// Decode → downscale to fit `maxDim` on the longer side → re-encode as
// JPEG. Returns { blob, mediaType }.
export async function prepareImageForUpload(
  source,
  maxDim = 1600,
  quality = 0.85
) {
  let decoded;
  try {
    decoded = await decodeImage(source);
  } catch (e) {
    throw new Error(
      `Couldn't read this image. Some phone formats (like HEIC) aren't ` +
        `supported by every browser. Try saving as JPEG/PNG first.`
    );
  }
  const w = decoded.width || decoded.naturalWidth || 0;
  const h = decoded.height || decoded.naturalHeight || 0;
  if (!w || !h) {
    throw new Error('Decoded image has zero dimensions — file may be corrupted.');
  }
  let nw = w;
  let nh = h;
  const longer = Math.max(w, h);
  if (longer > maxDim) {
    const ratio = maxDim / longer;
    nw = Math.round(w * ratio);
    nh = Math.round(h * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(decoded, 0, 0, nw, nh);
  if (typeof decoded.close === 'function') {
    try {
      decoded.close();
    } catch {
      /* noop */
    }
  }
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) =>
        b
          ? resolve(b)
          : reject(new Error('Canvas toBlob returned null — out of memory?')),
      'image/jpeg',
      quality
    );
  });
  return { blob, mediaType: 'image/jpeg' };
}

// Convert a Blob to a base64 string (without the "data:..." prefix).
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Read failed.'));
    reader.readAsDataURL(blob);
  });
}

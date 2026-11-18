// What an attachment's bytes are, decided by the bytes rather than the
// declared type or name. Used by the desktop daemon and the MCP server.

/** The image type the bytes show (PNG, JPEG, GIF or WebP), or null. */
export function sniffAttachmentImageType(bytes) {
  const startsWith = (offset, ...values) => values.every((value, index) => bytes[offset + index] === value);
  if (startsWith(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (startsWith(0, 0x52, 0x49, 0x46, 0x46) && startsWith(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** What a file's bytes are. A NUL byte means binary, as Git decides; text need not be valid UTF-8. */
export function detectAttachmentFile(bytes) {
  if (!bytes.byteLength) return { kind: 'empty' };
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return { kind: 'pdf' };
  let text = bytes;
  let encoding = 'utf-8';
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  if (utf16) {
    let decoded;
    try { decoded = new TextDecoder(utf16, { fatal: true }).decode(bytes); } catch { return { kind: 'binary' }; }
    if (decoded.includes('\u0000')) return { kind: 'binary' };
    text = new TextEncoder().encode(decoded);
    encoding = 'utf-16';
  } else {
    if (bytes.includes(0)) return { kind: 'binary' };
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { encoding = 'unknown'; }
  }
  let lines = 0;
  let longestLine = 0;
  let start = 0;
  for (let index = 0; index <= text.byteLength; index++) {
    if (index === text.byteLength ? index > start : text[index] === 0x0a) {
      lines += 1;
      longestLine = Math.max(longestLine, index - start);
      start = index + 1;
    }
  }
  return { kind: 'text', bytes: text, encoding, lines, longestLine };
}

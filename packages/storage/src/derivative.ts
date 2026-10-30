/** Strict WebP envelope check on a bounded private snapshot, independent of the decoder.
 * No animation, profiles, EXIF/XMP, unknown chunks or trailing bytes are served inline. */
export function webpDimensions(bytes: Buffer) {
  const bad = () => {
    throw Error('INVALID_DERIVATIVE_FORMAT');
  };
  if (
    bytes.length < 20 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return bad();
  let pos = 12,
    width = 0,
    height = 0,
    extended: { width: number; height: number; alpha: boolean } | undefined;
  const seen = new Set<string>();
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) return bad();
    const kind = bytes.toString('ascii', pos, pos + 4),
      size = bytes.readUInt32LE(pos + 4),
      start = pos + 8;
    if (
      !size ||
      start + size + (size % 2) > bytes.length ||
      seen.has(kind) ||
      !['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(kind)
    )
      return bad();
    seen.add(kind);
    if (kind === 'VP8X') {
      if (
        pos !== 12 ||
        size !== 10 ||
        bytes[start]! & ~0x10 ||
        bytes.readUIntLE(start + 1, 3) !== 0
      )
        return bad();
      extended = {
        width: bytes.readUIntLE(start + 4, 3) + 1,
        height: bytes.readUIntLE(start + 7, 3) + 1,
        alpha: !!(bytes[start]! & 0x10),
      };
    } else if (kind === 'ALPH') {
      if (!extended?.alpha || width || bytes[start]! & 0xc0) return bad();
    } else {
      if (width) return bad();
      if (kind === 'VP8 ') {
        if (
          size < 10 ||
          bytes[start]! & 1 ||
          bytes.toString('hex', start + 3, start + 6) !== '9d012a'
        )
          return bad();
        width = bytes.readUInt16LE(start + 6) & 0x3fff;
        height = bytes.readUInt16LE(start + 8) & 0x3fff;
        if (bytes.readUInt16LE(start + 6) >> 14 || bytes.readUInt16LE(start + 8) >> 14)
          return bad();
      } else {
        if (size < 5 || bytes[start] !== 0x2f) return bad();
        const bits = bytes.readUInt32LE(start + 1);
        if (bits >>> 29 || seen.has('ALPH')) return bad();
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
    }
    if (size % 2 && bytes[start + size] !== 0) return bad();
    pos = start + size + (size % 2);
  }
  if (
    !width ||
    !height ||
    (extended && (extended.width !== width || extended.height !== height)) ||
    (seen.has('ALPH') && !seen.has('VP8 '))
  )
    return bad();
  return { width, height };
}

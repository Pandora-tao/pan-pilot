/** 1x1 PNG（标准 89 50 4E 47 魔数）。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 最小 PNG：魔数 + 少量负载。 */
export function pngBytes(): Buffer {
  return Buffer.from(PNG_BASE64, "base64");
}

/** 最小 JPEG：SOI + APP0 头 + EOI。 */
export function jpegBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** 最小 WebP：RIFF + 尺寸 + WEBP 标记。 */
export function webpBytes(): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x14, 0x00, 0x00, 0x00]),
    Buffer.from("WEBPVP8 ", "ascii"),
    Buffer.alloc(8),
  ]);
}

/** 最小 GIF89a 头。 */
export function gifBytes(): Buffer {
  return Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(16)]);
}

/** 最小 WAV：RIFF/WAVE 头 + 空的 data 块。 */
export function wavBytes(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0, 40);
  return header;
}

/** 最小 MP3：ID3v2 头 + 少量负载。 */
export function mp3Bytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.alloc(16),
  ]);
}

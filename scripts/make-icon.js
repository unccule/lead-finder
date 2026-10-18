// Рисует иконку приложения (синий квадрат со скруглёнными углами и белой лупой)
// и сохраняет её в build/icon.ico (для Windows) и build/icon.png.
// Только встроенные модули: картинку считаем по пикселям, PNG сжимаем через node:zlib.
//
// Запуск: npm run build:icon
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256]; // Windows сама выбирает подходящий размер
const BLUE = [47, 111, 237]; // #2f6fed — как акцентный цвет страницы
const WHITE = [255, 255, 255];
const SAMPLES = 4; // 4×4 «подточки» на пиксель — края получаются гладкими

/** Цвет точки (x, y) в долях от 0 до 1 или null, если точка прозрачная. */
function colorAt(x, y) {
  if (!inRoundedSquare(x, y, 0.06, 0.22)) return null;
  const ring = Math.hypot(x - 0.44, y - 0.44);
  if (ring <= 0.25 && ring >= 0.16) return WHITE; // кольцо лупы
  if (distanceToSegment(x, y, 0.62, 0.62, 0.79, 0.79) <= 0.055) return WHITE; // ручка
  return BLUE;
}

function inRoundedSquare(x, y, margin, radius) {
  const left = margin + radius;
  const right = 1 - margin - radius;
  const cx = Math.min(Math.max(x, left), right);
  const cy = Math.min(Math.max(y, left), right);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

/** Картинка size×size в формате RGBA. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = colorAt((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          covered += 1;
        }
      }
      const offset = (y * size + x) * 4;
      if (covered > 0) {
        pixels[offset] = Math.round(r / covered);
        pixels[offset + 1] = Math.round(g / covered);
        pixels[offset + 2] = Math.round(b / covered);
        pixels[offset + 3] = Math.round((covered / SAMPLES ** 2) * 255);
      }
    }
  }
  return pixels;
}

/** RGBA → файл PNG (формат: подпись + блоки IHDR, IDAT, IEND с контрольными суммами). */
function encodePng(size, rgba) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 бит на канал, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Несколько PNG → один файл .ico (Windows понимает PNG внутри ICO). */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = иконка
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 означает 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // плоскости
    entry.writeUInt16LE(32, 6); // бит на пиксель
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

const images = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(images));
writeFileSync(path.join(OUT_DIR, 'icon.png'), images.at(-1).png);
console.log(`Готово: build/icon.ico (${SIZES.join(', ')} px) и build/icon.png`);

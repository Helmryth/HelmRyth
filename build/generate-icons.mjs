import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(BUILD_DIR);
const MASTER_SVG = path.join(BUILD_DIR, "icon.svg");
const MASTER_PNG = path.join(BUILD_DIR, "icon-1024.png");
const ICONSET = path.join(BUILD_DIR, "icon.iconset");
const ICO_RASTERS = path.join(BUILD_DIR, "icon.ico-pngs");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function raster(source, destination, size) {
  run("sips", ["-z", String(size), String(size), "-s", "format", "png", source, "--out", destination]);
}

mkdirSync(ICONSET, { recursive: true });
raster(MASTER_SVG, MASTER_PNG, 1024);

const iconsetFiles = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_64x64.png", 64],
  ["icon_64x64@2x.png", 128],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

for (const [name, size] of iconsetFiles) {
  const destination = path.join(ICONSET, name);
  if (size === 1024) copyFileSync(MASTER_PNG, destination);
  else raster(MASTER_PNG, destination, size);
}

run("iconutil", ["-c", "icns", ICONSET, "-o", path.join(BUILD_DIR, "icon.icns")]);

// ICO accepts PNG payloads. Embedding several exact raster sizes keeps the
// mark crisp in Explorer, the taskbar, installers, and high-DPI shortcuts.
const icoEntries = [16, 32, 48, 64, 128, 256].map((size) => {
  mkdirSync(ICO_RASTERS, { recursive: true });
  const source = path.join(ICO_RASTERS, `${size}.png`);
  raster(MASTER_PNG, source, size);
  return { size, data: readFileSync(source) };
});
const header = Buffer.alloc(6 + icoEntries.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoEntries.length, 4);
let offset = header.length;
icoEntries.forEach(({ size, data }, index) => {
  const at = 6 + index * 16;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = size === 256 ? 0 : size;
  header[at + 2] = 0;
  header[at + 3] = 0;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(data.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += data.length;
});
writeFileSync(path.join(BUILD_DIR, "icon.ico"), Buffer.concat([header, ...icoEntries.map(({ data }) => data)]));

copyFileSync(MASTER_PNG, path.join(ROOT, "electron", "resources", "app-icon.png"));
console.log("Generated Helmryth SVG-derived PNG, ICNS, ICO, and Electron icon assets.");

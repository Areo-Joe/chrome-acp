import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, "../proxy-server/public");
const { version } = JSON.parse(await readFile(join(root, "../proxy-server/package.json"), "utf8"));

// Optional assets can be absent; report other filesystem errors.
async function copyOptional(source, destination) {
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await mkdir(outdir, { recursive: true });
for (const asset of ["manifest.json", "icon-192.png", "icon-512.png"]) {
  await copyOptional(join(root, "src", asset), join(outdir, asset));
}

try {
  const source = await readFile(join(root, "src/sw.js"), "utf8");
  await writeFile(join(outdir, "sw.js"), source.replace(/__VERSION__/g, version));
  console.log(`✓ Service Worker updated with version ${version}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const iconsDir = join(root, "src/icons");
const iconsOutDir = join(outdir, "icons");
try {
  const icons = await readdir(iconsDir, { withFileTypes: true });
  await mkdir(iconsOutDir, { recursive: true });
  for (const icon of icons) {
    if (icon.isFile() && icon.name.endsWith(".png")) {
      await copyFile(join(iconsDir, icon.name), join(iconsOutDir, icon.name));
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

console.log("✓ PWA assets copied to", outdir);

import { mkdir } from "fs/promises";
import { join } from "path";

const outdir = join(import.meta.dir, "../proxy-server/public");

// Copy PWA assets (manifest.json, service-worker.js, logo, icons)
const pwaAssets = ["manifest.json", "sw.js", "logo.svg", "icon-192.png", "icon-512.png"];
for (const asset of pwaAssets) {
  const src = join(import.meta.dir, "src", asset);
  const dest = join(outdir, asset);
  try {
    await Bun.write(dest, Bun.file(src));
  } catch {
    // Asset may not exist yet
  }
}

// Copy icons folder
const iconsDir = join(import.meta.dir, "src/icons");
const iconsOutDir = join(outdir, "icons");
try {
  await mkdir(iconsOutDir, { recursive: true });
  const iconFiles = await Array.fromAsync(new Bun.Glob("*.png").scan(iconsDir));
  for (const icon of iconFiles) {
    await Bun.write(join(iconsOutDir, icon), Bun.file(join(iconsDir, icon)));
  }
} catch {
  // Icons may not exist yet
}

console.log("✓ PWA assets copied to", outdir);


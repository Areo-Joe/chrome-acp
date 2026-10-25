import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Simulate a slow disk after the destination has already been truncated and
// partially written. Other filesystem operations retain their normal behavior.
const writeFile = fs.promises.writeFile;
fs.promises.writeFile = async function (path, content, options) {
  if (typeof path !== 'string' || !path.endsWith('.slow-save')) {
    return writeFile(path, content, options);
  }
  const bytes = Buffer.from(content, options?.encoding ?? 'utf8');
  const file = await fs.promises.open(path, 'w');
  try {
    await file.write(bytes.subarray(0, 1));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await file.writeFile(bytes.subarray(1));
  } finally {
    await file.close();
  }
};
syncBuiltinESMExports();

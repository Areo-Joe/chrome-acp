import { host } from "nsh";
import { pastedImageUri, type ImageBlock } from "./draft";
import type { PasteEvent } from "nsh";

export function isLocalFile(uri: string) {
  try { return new URL(uri).protocol === "file:"; }
  catch { return false; }
}

export function pastedImages(event: Pick<PasteEvent, "text" | "files" | "uris">) {
  if (event.text.length) return { sources: [] as (File | string)[], clipboard: false };
  const images = event.files;
  return images.length ? { sources: images, clipboard: true }
    : { sources: event.uris.filter(isLocalFile), clipboard: false };
}

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
};

// Zed reads/sniffs external files before inserting a mention. Conversion of a
// recognized image remains a separate task; failure reports an error and
// removes that mention, matching insert_images_as_context.
export async function readImageSource(source: File | string): Promise<string | null> {
  const input = typeof source === "string" && source.startsWith("file:")
    ? { path: decodeURIComponent(new URL(source).pathname) }
    : { data: base64(new Uint8Array(await (typeof source === "string" ? await fetch(source).then(response => response.blob()) : source).arrayBuffer())) };
  const result = await host.call("image.normalize", { ...input, inspect: true }, { timeout: 0 }) as { supported?: boolean; data?: string };
  if (result?.supported === false) return null;
  if (result?.supported !== true || typeof result.data !== "string") throw new Error("Failed to read image");
  return result.data;
}

export async function prepareImage(source: File | string, displayName?: string, clipboard = false, sourceData?: string): Promise<{ block: ImageBlock; name: string }> {
  const name = displayName ?? (typeof source === "string" ? decodeURIComponent(new URL(source).pathname.split("/").at(-1) || "Image") : source.name || "Image");
  const input = sourceData !== undefined ? { data: sourceData } : typeof source === "string" && source.startsWith("file:")
    ? { path: decodeURIComponent(new URL(source).pathname) }
    : { data: base64(new Uint8Array(await (typeof source === "string" ? await fetch(source).then(response => response.blob()) : source).arrayBuffer())),
      mimeType: typeof source === "string" ? undefined : source.type || undefined,
      fileName: typeof source === "string" || clipboard ? undefined : source.name };
  const result = await host.call("image.normalize", input, { timeout: 0 }) as { data: string; mimeType: string };
  if (typeof result?.data !== "string" || result.mimeType !== "image/png") throw new Error("Failed to convert image");
  return { name, block: { type: "image", data: result.data, mimeType: "image/png", uri: pastedImageUri(name) } };
}

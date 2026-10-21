/**
 * File system utilities for real-time file watching and browsing
 *
 * Uses @parcel/watcher for efficient, scalable file watching.
 * This is the same library used by VS Code, Parcel, Nx, and Nuxt.
 *
 * Benefits over chokidar:
 * - Native C++ implementation with throttling/coalescing in C++
 * - Automatic Watchman integration for large repos
 * - Uses FSEvents on macOS, inotify on Linux efficiently
 * - Handles tens of thousands of files without exhausting inotify limits
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative, sep, basename, extname } from "node:path";
import * as watcher from "@parcel/watcher";
import { log } from "./logger.js";

// Ignored patterns for file watching (glob patterns for @parcel/watcher).
// Patterns match on relative paths from the watched root.
// The first pattern matches all hidden files/dirs (.git, .vscode, .idea, etc.)
const WATCHER_IGNORE_PATTERNS: string[] = [
  // Hidden files and directories (covers .git, .vscode, .idea, .cache, .next, etc.)
  "**/.*",
  "**/.*/**",
  // Package managers
  "**/node_modules/**",
  // Build outputs
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  // Lock files
  "**/*.lock",
  "**/bun.lockb",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  // Temporary directories
  "**/__pycache__/**",
  "**/tmp/**",
  "**/temp/**",
];

// Ignored names for directory listing (simple string/extension matching)
const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".acp-proxy",
  ".DS_Store",
  "thumbs.db",
  "bun.lockb",
  "package-lock.json",
]);

// Ignored extensions for directory listing
const IGNORED_EXTENSIONS = new Set([".lock"]);

// File size limits
const MAX_TEXT_SIZE = 100 * 1024; // 100KB
const MAX_IMAGE_SIZE = 1 * 1024 * 1024; // 1MB

// Image extensions
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"]);

// Binary extensions (don't try to read as text)
const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv",
  ".ttf", ".otf", ".woff", ".woff2",
]);

export interface FileItem {
  name: string;
  path: string; // relative path
  type: "file" | "dir";
  size?: number;
  mtime?: number;
}

export interface FileContent {
  path: string;
  content: string; // text or base64 for images
  size: number;
  truncated: boolean;
  binary: boolean;
  mimeType?: string;
}

/**
 * File change event from @parcel/watcher
 * Event types:
 * - "create": file or directory was created
 * - "update": file was modified
 * - "delete": file or directory was deleted
 */
export interface FileChange {
  event: "create" | "update" | "delete";
  path: string; // relative path
}

/**
 * Validate and resolve a path, preventing path traversal attacks
 * Returns null if the path is outside the root directory
 */
export function safePath(root: string, userPath: string): string | null {
  const resolvedRoot = resolve(root);
  const resolved = resolve(root, userPath);

  // Must be within root directory (or be the root itself)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    return null;
  }
  return resolved;
}

/**
 * List contents of a directory (lazy loading - one level only)
 */
export function listDir(root: string, dirPath: string): FileItem[] | null {
  const fullPath = safePath(root, dirPath);
  if (!fullPath) return null;

  try {
    const entries = readdirSync(fullPath, { withFileTypes: true });
    const items: FileItem[] = [];

    for (const entry of entries) {
      // Skip hidden files and ignored patterns
      if (entry.name.startsWith(".")) continue;
      if (IGNORED_NAMES.has(entry.name)) continue;
      const ext = extname(entry.name).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) continue;

      const entryPath = resolve(fullPath, entry.name);
      const relativePath = relative(root, entryPath);

      try {
        const stats = statSync(entryPath);
        items.push({
          name: entry.name,
          path: relativePath,
          type: entry.isDirectory() ? "dir" : "file",
          size: entry.isFile() ? stats.size : undefined,
          mtime: stats.mtimeMs,
        });
      } catch {
        // Skip files we can't stat
      }
    }

    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return items;
  } catch {
    return null;
  }
}

/**
 * Read a text file for the ACP `fs/read_text_file` method.
 *
 * Reference: Zed's `handle_read_text_file` — agents may reference any absolute
 * path, not just the session working directory (the agent process itself
 * already has the same file-system access).
 *
 * @param line  1-based line number to start reading from
 * @param limit maximum number of lines to read
 */
export function readTextFile(
  absolutePath: string,
  line?: number | null,
  limit?: number | null,
): string {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`Path must be absolute: ${absolutePath}`);
  }

  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${absolutePath}`);
  }

  const content = readFileSync(absolutePath, "utf-8");
  if (line === undefined && limit === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const start = line ? Math.max(0, line - 1) : 0;
  const end = limit !== undefined && limit !== null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}

/**
 * Write a text file for the ACP `fs/write_text_file` method.
 *
 * Creates parent directories as needed (like Zed's buffer save).
 */
export function writeTextFile(absolutePath: string, content: string): void {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`Path must be absolute: ${absolutePath}`);
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf-8");
}

/**
 * Read file content with size limits and type detection
 */
export function readFile(root: string, filePath: string): FileContent | null {
  const fullPath = safePath(root, filePath);
  if (!fullPath) return null;

  try {
    const stats = statSync(fullPath);
    if (!stats.isFile()) return null;

    const ext = extname(fullPath).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isBinary = BINARY_EXTENSIONS.has(ext);

    // Binary files (non-image)
    if (isBinary) {
      return {
        path: filePath,
        content: `[Binary file: ${basename(fullPath)}, ${formatSize(stats.size)}]`,
        size: stats.size,
        truncated: false,
        binary: true,
      };
    }

    // Image files
    if (isImage) {
      if (stats.size > MAX_IMAGE_SIZE) {
        return {
          path: filePath,
          content: `[Image too large: ${formatSize(stats.size)}, max ${formatSize(MAX_IMAGE_SIZE)}]`,
          size: stats.size,
          truncated: true,
          binary: true,
        };
      }
      const buffer = readFileSync(fullPath);
      const mimeType = getMimeType(ext);
      return {
        path: filePath,
        content: buffer.toString("base64"),
        size: stats.size,
        truncated: false,
        binary: true,
        mimeType,
      };
    }

    // Text files
    const truncated = stats.size > MAX_TEXT_SIZE;
    const buffer = readFileSync(fullPath);
    const content = truncated
      ? buffer.subarray(0, MAX_TEXT_SIZE).toString("utf-8") + "\n\n[... truncated]"
      : buffer.toString("utf-8");

    return {
      path: filePath,
      content,
      size: stats.size,
      truncated,
      binary: false,
    };
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getMimeType(ext: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
  };
  return types[ext] || "application/octet-stream";
}

// ============ File Watcher (@parcel/watcher) ============

export type FileChangeHandler = (changes: FileChange[]) => void;

/**
 * State for a watched directory.
 * @parcel/watcher handles multiple subscriptions internally,
 * but we still track handlers for our own reference counting.
 */
interface WatcherState {
  subscription: watcher.AsyncSubscription;
  handlers: Set<FileChangeHandler>;
}

const watchers = new Map<string, WatcherState>();

/**
 * Start watching a directory for file changes using @parcel/watcher.
 *
 * This uses native OS APIs for efficient watching:
 * - macOS: FSEvents (kernel-level, very efficient)
 * - Linux: inotify (with smart batching to avoid exhausting limits)
 * - Windows: ReadDirectoryChangesW
 * - Watchman: automatically used if installed (best for huge repos)
 *
 * Events are throttled and coalesced in C++ for performance during
 * large filesystem changes (e.g., git checkout, npm install).
 *
 * Uses reference counting - multiple clients can subscribe to the same root.
 * Returns an unsubscribe function to remove this specific handler.
 */
export async function startWatcher(root: string, handler: FileChangeHandler): Promise<() => void> {
  const existing = watchers.get(root);

  if (existing) {
    // Add handler to existing watcher
    existing.handlers.add(handler);
    return createUnsubscribe(existing.handlers, handler, root);
  }

  // Create new watcher with @parcel/watcher
  const handlers = new Set<FileChangeHandler>([handler]);

  const subscription = await watcher.subscribe(
    root,
    (err, events) => {
      if (err) {
        log.error("File watcher error", { root, error: String(err) });
        return;
      }

      // Convert @parcel/watcher events to our FileChange format
      // Events already have: { type: 'create' | 'update' | 'delete', path: string (absolute) }
      const changes: FileChange[] = events.map((event) => ({
        event: event.type,
        path: relative(root, event.path),
      }));

      // Notify all handlers
      for (const h of handlers) {
        h(changes);
      }
    },
    {
      ignore: WATCHER_IGNORE_PATTERNS,
    }
  );

  const state: WatcherState = {
    subscription,
    handlers,
  };

  watchers.set(root, state);
  log.debug("File watcher started", { root });

  return createUnsubscribe(handlers, handler, root);
}

/**
 * Create an unsubscribe function for a handler.
 * Uses fire-and-forget pattern for async cleanup since unsubscribe
 * callbacks are expected to be synchronous by most APIs.
 */
function createUnsubscribe(
  handlers: Set<FileChangeHandler>,
  handler: FileChangeHandler,
  root: string
): () => void {
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      // Fire-and-forget: cleanup runs async but we don't block the caller
      stopWatcher(root).catch((err) => {
        log.error("Failed to stop file watcher", { root, error: String(err) });
      });
    }
  };
}

/**
 * Stop watching a directory (removes all handlers)
 */
export async function stopWatcher(root: string): Promise<void> {
  const state = watchers.get(root);
  if (state) {
    await state.subscription.unsubscribe();
    watchers.delete(root);
    log.debug("File watcher stopped", { root });
  }
}

/**
 * Stop all watchers
 */
export async function stopAllWatchers(): Promise<void> {
  const roots = Array.from(watchers.keys());
  await Promise.all(roots.map((root) => stopWatcher(root)));
}


/**
 * File system utilities for real-time file watching and browsing
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, sep, basename, extname } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

// Ignored patterns for file watching (used by chokidar)
// Using a function for more reliable matching
const IGNORED_GLOB_PATTERNS: ((path: string) => boolean) = (path: string) => {
  const name = basename(path);
  // Ignore hidden files/directories (starting with .)
  if (name.startsWith(".")) return true;
  // Ignore common directories
  if (name === "node_modules" || name === "dist" || name === "build" || name === "coverage") return true;
  // Ignore lock files
  if (name.endsWith(".lock") || name === "bun.lockb" || name === "package-lock.json") return true;
  return false;
};

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

export interface FileChange {
  event: "add" | "addDir" | "change" | "unlink" | "unlinkDir";
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

// ============ File Watcher ============

export type FileChangeHandler = (changes: FileChange[]) => void;

interface WatcherState {
  watcher: FSWatcher;
  pendingChanges: FileChange[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  handlers: Set<FileChangeHandler>;  // Multiple handlers for multiple clients
}

const watchers = new Map<string, WatcherState>();

/**
 * Start watching a directory for file changes.
 * Uses reference counting - multiple clients can subscribe to the same root.
 * Returns an unsubscribe function to remove this specific handler.
 */
export function startWatcher(root: string, handler: FileChangeHandler): () => void {
  const existing = watchers.get(root);

  if (existing) {
    // Add handler to existing watcher
    existing.handlers.add(handler);
    return () => {
      existing.handlers.delete(handler);
      // Stop watcher if no more handlers
      if (existing.handlers.size === 0) {
        stopWatcher(root);
      }
    };
  }

  // Create new watcher
  const watcher = chokidar.watch(root, {
    ignored: IGNORED_GLOB_PATTERNS,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  const state: WatcherState = {
    watcher,
    pendingChanges: [],
    debounceTimer: null,
    handlers: new Set([handler]),
  };

  watcher.on("all", (event, filePath) => {
    // Filter to relevant events
    if (!["add", "addDir", "change", "unlink", "unlinkDir"].includes(event)) return;

    const relativePath = relative(root, filePath);
    state.pendingChanges.push({
      event: event as FileChange["event"],
      path: relativePath,
    });

    // Debounce: batch changes within 150ms window
    if (!state.debounceTimer) {
      state.debounceTimer = setTimeout(() => {
        const changes = [...state.pendingChanges];
        state.pendingChanges = [];
        state.debounceTimer = null;
        // Notify all handlers
        for (const h of state.handlers) {
          h(changes);
        }
      }, 150);
    }
  });

  watchers.set(root, state);

  // Return unsubscribe function
  return () => {
    state.handlers.delete(handler);
    if (state.handlers.size === 0) {
      stopWatcher(root);
    }
  };
}

/**
 * Stop watching a directory (removes all handlers)
 */
export function stopWatcher(root: string): void {
  const state = watchers.get(root);
  if (state) {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    state.watcher.close();
    watchers.delete(root);
  }
}

/**
 * Stop all watchers
 */
export function stopAllWatchers(): void {
  for (const root of watchers.keys()) {
    stopWatcher(root);
  }
}


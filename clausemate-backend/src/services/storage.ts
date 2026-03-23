import fs from "fs/promises";
import path from "path";
import { config } from "../config";
import { v4 as uuidv4 } from "uuid";

/* ── Storage Interface ────────────────────────────── */

interface StorageProvider {
  save(buffer: Buffer, filename: string, mimeType: string): Promise<string>;
  read(storagePath: string): Promise<Buffer>;
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
}

/* ── Local Filesystem Storage ─────────────────────── */

class LocalStorage implements StorageProvider {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = path.resolve(basePath);
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async save(buffer: Buffer, filename: string, _mimeType: string): Promise<string> {
    const ext = path.extname(filename);
    const uniqueName = `${uuidv4()}${ext}`;
    const dateDir = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    const dirPath = path.join(this.basePath, dateDir);
    await this.ensureDir(dirPath);

    const filePath = path.join(dirPath, uniqueName);
    await fs.writeFile(filePath, buffer);

    // Return relative path from base
    return path.relative(this.basePath, filePath);
  }

  async read(storagePath: string): Promise<Buffer> {
    const fullPath = path.resolve(this.basePath, storagePath);

    // Reject any path that escapes the storage root.
    // path.resolve handles ".." traversal and symlink-neutral normalization.
    if (!fullPath.startsWith(this.basePath + path.sep) &&
        fullPath !== this.basePath) {
      throw new Error(`Path traversal attempt blocked: "${storagePath}"`);
    }

    return fs.readFile(fullPath);
  }

  async delete(storagePath: string): Promise<void> {
    const fullPath = path.resolve(this.basePath, storagePath);
    if (!fullPath.startsWith(this.basePath + path.sep) &&
        fullPath !== this.basePath) {
      throw new Error(`Path traversal attempt blocked: "${storagePath}"`);
    }
    await fs.unlink(fullPath).catch(() => {});
  }

  async exists(storagePath: string): Promise<boolean> {
    const fullPath = path.resolve(this.basePath, storagePath);
    if (!fullPath.startsWith(this.basePath + path.sep) &&
        fullPath !== this.basePath) {
      return false;
    }
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

/* ── Factory ──────────────────────────────────────── */

let storageInstance: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (!storageInstance) {
    // validateStorageConfig() must have been called at startup before this.
    // By the time we reach here the config is guaranteed valid.
    storageInstance = new LocalStorage(config.storage.localPath);
  }
  return storageInstance;
}

/* ── Startup Validation ───────────────────────────── */

/**
 * Call once during application startup, before accepting any requests.
 *
 * For STORAGE_TYPE=local:
 *   - Resolves the base path and verifies it is writable. Throws if not,
 *     so misconfigured STORAGE_LOCAL_PATH fails at startup rather than
 *     on the first upload.
 *
 * For STORAGE_TYPE=s3:
 *   - S3 is not yet implemented. Throws immediately with a clear message
 *     listing the required AWS SDK setup steps. A silent fallback to local
 *     disk would cause data loss on ephemeral container storage — that is
 *     never acceptable, so we fail loudly instead.
 *
 * Throws an Error for any invalid configuration. The caller (index.ts)
 * should let it propagate so the process exits before serving traffic.
 */
export async function validateStorageConfig(): Promise<void> {
  const type = config.storage.type;

  if (type === "s3") {
    throw new Error(
      "STORAGE_TYPE=s3 is set but S3 storage is not yet implemented.\n" +
      "\n" +
      "Using a silent local-disk fallback would cause data loss on ephemeral\n" +
      "container storage (every pod restart wipes uploaded contracts).\n" +
      "\n" +
      "To fix:\n" +
      "  1. Install: npm install @aws-sdk/client-s3\n" +
      "  2. Implement S3Storage in src/services/storage.ts\n" +
      "  3. Set: S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION\n" +
      "\n" +
      "To use local storage for now, set STORAGE_TYPE=local (the default)."
    );
  }

  if (type === "local") {
    const basePath = path.resolve(config.storage.localPath);

    // Ensure the directory exists and is writable by attempting to create it
    // and write a small probe file. This catches permission errors and
    // read-only mounts at startup rather than on the first real upload.
    await fs.mkdir(basePath, { recursive: true });

    const probe = path.join(basePath, `.startup-probe-${uuidv4()}`);
    try {
      await fs.writeFile(probe, "ok");
      await fs.unlink(probe);
    } catch (err) {
      throw new Error(
        `Local storage path "${basePath}" is not writable: ${(err as Error).message}\n` +
        "Set STORAGE_LOCAL_PATH to a directory the process can write to."
      );
    }

    return;
  }

  // Unreachable given the config enum, but guards against future additions.
  throw new Error(`Unknown STORAGE_TYPE="${type}". Valid values: local, s3`);
}

/* ── Text Extraction ──────────────────────────────── */

export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  if (mimeType === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // Plain text fallback
  return buffer.toString("utf-8");
}

export async function getPageCount(buffer: Buffer, mimeType: string): Promise<number> {
  if (mimeType === "application/pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    return result.numpages || 1;
  }

  // Estimate page count for DOCX based on character count (~2000 chars per page)
  const text = await extractTextFromBuffer(buffer, mimeType);
  return Math.max(1, Math.ceil(text.length / 2000));
}

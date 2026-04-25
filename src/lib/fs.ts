import { promises as fs } from "node:fs";
import { DATA_DIR } from "../config";

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

export async function tryReadFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

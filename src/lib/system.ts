import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { OpenFileAction } from "../types";

export async function spawnAndWait(
  command: string,
  args: string[],
  options: Record<string, unknown> = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function openFileInSystem(filePath: string): Promise<OpenFileAction> {
  await fs.access(filePath);
  const platform = process.platform;
  if (platform === "darwin") {
    try {
      await spawnAndWait("open", ["-t", filePath], { stdio: "ignore" });
      return "opened";
    } catch {
      await spawnAndWait("open", ["-R", filePath], { stdio: "ignore" });
      return "revealed";
    }
  }

  if (platform === "win32") {
    await spawnAndWait("cmd", ["/c", "start", "", filePath], { stdio: "ignore", windowsHide: true });
    return "opened";
  }

  await spawnAndWait("xdg-open", [filePath], { stdio: "ignore" });
  return "opened";
}

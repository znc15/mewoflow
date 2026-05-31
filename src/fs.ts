import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFileEnsured(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, "utf8");
}

export async function appendFileEnsured(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, content, "utf8");
}

export async function readText(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readText(file)) as T;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFileEnsured(tempFile, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempFile, file);
  } finally {
    if (await pathExists(tempFile)) {
      await fs.rm(tempFile, { force: true });
    }
  }
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(file: string): Promise<string | null> {
  if (!(await pathExists(file))) return null;
  return readText(file);
}

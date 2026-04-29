import { stat } from "node:fs/promises";

const DEFAULT_SEED_PATH = "/app/seed_repo";

export async function resolveCloneReference(seedPath: string = DEFAULT_SEED_PATH): Promise<string | undefined> {
  try {
    await stat(`${seedPath}/.git`);
    return seedPath;
  } catch {
    return undefined;
  }
}

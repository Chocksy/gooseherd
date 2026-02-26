import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PipelineEvent, PipelineEventType } from "./types.js";

/**
 * Append-only JSONL event logger for pipeline execution.
 * Each line is a JSON-serialized PipelineEvent.
 */
export class EventLogger {
  private readonly filePath: string;
  private initialized = false;

  constructor(runDir: string) {
    this.filePath = path.join(runDir, "events.jsonl");
  }

  async emit(type: PipelineEventType, fields: Partial<PipelineEvent> = {}): Promise<void> {
    if (!this.initialized) {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      this.initialized = true;
    }

    const event: PipelineEvent = {
      type,
      timestamp: new Date().toISOString(),
      ...fields
    };

    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }

  getFilePath(): string {
    return this.filePath;
  }
}

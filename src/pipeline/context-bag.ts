/**
 * Typed key-value store passed between pipeline nodes.
 */
export class ContextBag {
  private data: Map<string, unknown> = new Map();

  constructor(initial?: Record<string, unknown>) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.data.set(key, value);
      }
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  getRequired<T = unknown>(key: string): T {
    const value = this.data.get(key);
    if (value === undefined) {
      throw new Error(`ContextBag: required key '${key}' is missing`);
    }
    return value as T;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  /** Append a value to an array stored at key. Creates the array if it doesn't exist. */
  append(key: string, value: unknown): void {
    const existing = this.data.get(key);
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      this.data.set(key, [value]);
    }
  }

  /** Return all keys in the context bag */
  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  /** Merge multiple outputs into the context bag */
  mergeOutputs(outputs: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(outputs)) {
      this.data.set(key, value);
    }
  }

  /**
   * Build an LLM-friendly text summary of selected context keys.
   * If no keys specified, includes all non-internal keys (skips _tokenUsage_*).
   */
  toSummary(keys?: string[]): string {
    const lines: string[] = [];
    const selectedKeys = keys ?? [...this.data.keys()].filter(k => !k.startsWith("_tokenUsage_"));

    for (const key of selectedKeys) {
      const value = this.data.get(key);
      if (value === undefined) continue;

      if (typeof value === "string") {
        lines.push(`${key}: ${value.slice(0, 500)}`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const preview = value.length <= 5
          ? JSON.stringify(value)
          : `[${String(value.length)} items] ${JSON.stringify(value.slice(0, 3))}...`;
        lines.push(`${key}: ${preview}`);
      } else if (typeof value === "object" && value !== null) {
        lines.push(`${key}: ${JSON.stringify(value).slice(0, 300)}`);
      } else {
        lines.push(`${key}: ${String(value)}`);
      }
    }

    return lines.join("\n");
  }

  /** Get all data as a plain object (for template resolution) */
  toObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of this.data.entries()) {
      obj[key] = value;
    }
    return obj;
  }

  /**
   * Resolve a dotted path like "ctx.repoDir" or "config.lintFixCommand"
   * against the context bag data and an optional config object.
   */
  resolve(dotPath: string, config?: Record<string, unknown>): unknown {
    const parts = dotPath.split(".");
    const root = parts[0];
    const rest = parts.slice(1);

    let current: unknown;
    if (root === "ctx") {
      current = this.toObject();
    } else if (root === "config" && config) {
      current = config;
    } else {
      // Try context bag directly
      current = this.data.get(dotPath);
      if (current !== undefined) return current;
      // Try first segment as a key
      current = this.data.get(root);
      if (current === undefined) return undefined;
    }

    for (const part of rest) {
      if (current === null || current === undefined) return undefined;
      if (typeof current === "object") {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }
}

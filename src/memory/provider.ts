export interface MemoryProvider {
  readonly name: string;
  searchMemories(query: string, project?: string, maxTokens?: number): Promise<string>;
  storeMemory(content: string, tags: string[], sourceRef?: string): Promise<boolean>;
}

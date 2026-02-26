export interface SandboxConfig {
  image: string;
  cpus: number;
  memoryMb: number;
  env: Record<string, string>;
  networkMode: "bridge" | "none" | "host";
}

export interface SandboxHandle {
  containerId: string;
  containerName: string;
}

export interface SandboxExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

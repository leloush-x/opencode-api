// Minimal type declarations for Bun's own modules.
//
// The project ships no @types/node: `bun:fs` and `bun:path` are Bun's own
// modules, and only the handful of functions below are used. Declaring them
// here keeps the project free of a Node type dependency.

declare module "bun:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    options?: { mode?: number },
  ): void;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function copyFileSync(source: string, destination: string): void;
  export function cpSync(
    source: string,
    destination: string,
    options?: { recursive?: boolean },
  ): void;
  export function chmodSync(path: string, mode: number): void;
  export function rmSync(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): void;
  export function statSync(path: string): {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
  };
  export function mkdtempSync(prefix: string): string;
}

declare module "bun:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, extension?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}

/** The handful of process members the port uses; Bun implements them. */
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd(): string;
  execPath: string;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
};

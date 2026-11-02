import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function compileConcurrencyWorker(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(packageDir, "node_modules", ".concurrency-"));
  execFileSync(join(packageDir, "node_modules", ".bin", "tsc"), [
    "-p",
    join(packageDir, "tsconfig.json"),
    "--outDir",
    directory,
    "--declaration",
    "false",
    "--declarationMap",
    "false",
    "--sourceMap",
    "false",
  ]);
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export interface Reply {
  value?: string;
  timestamp?: number;
  revalidate?: number;
  pid?: number;
}

/** Bounded IPC; a crash rejects outstanding calls instead of hanging the suite. */
export class CacheProcess {
  private child: ChildProcess;
  private serial = 0;
  private pending = new Map<
    number,
    { resolve: (value: Reply | null) => void; reject: (error: Error) => void }
  >();
  private stderr = "";

  constructor(directory: string) {
    this.child = fork(join(packageDir, "src/testing/concurrency-worker.mjs"), [directory], {
      execArgv: [],
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child.stderr?.on("data", (data) => {
      this.stderr = (this.stderr + data).slice(-8000);
    });
    this.child.on("message", (reply: { id: number; result: Reply | null; error?: string }) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error));
      else pending.resolve(reply.result);
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values())
        pending.reject(new Error(`Worker exited: ${this.stderr}`));
      this.pending.clear();
    });
  }

  async call(message: Record<string, unknown>): Promise<Reply | null> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC timeout: ${JSON.stringify(message)} ${this.stderr}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.send({ ...message, id });
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGKILL");
    await exited;
  }
}

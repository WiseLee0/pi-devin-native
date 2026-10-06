import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

// Resolve the pinned local dependency through ESM; never rely on a global CLI or symlink.
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const manifest = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")) as { bin: { pi: string } };
const piCli = join(piRoot, manifest.bin.pi);

export function runPi(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [piCli, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Pi mock integration timed out")); }, 30_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

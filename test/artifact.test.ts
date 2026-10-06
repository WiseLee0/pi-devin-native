import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runPi } from "./helpers/pi.js";

test("packed extension loads in Pi without checkout node_modules, tests, or global package links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-devin-artifact-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    const npmCli = process.env.npm_execpath;
    const pack = spawnSync(npmCli ? process.execPath : "npm", [
      ...(npmCli ? [npmCli] : []), "pack", "--ignore-scripts", "--json", "--pack-destination", dir,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(pack.status, 0, pack.stderr);
    const [report] = JSON.parse(pack.stdout) as [{ filename: string; files: { path: string }[] }];
    assert.ok(!report.files.some(file => /^(?:node_modules|test|\.pi)\//.test(file.path)));
    const extract = spawnSync("tar", ["-xzf", join(dir, report.filename), "-C", dir], { encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const result = await runPi([
      "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-mcp", "-e", join(dir, "package", "index.ts"), "--list-models", "devin",
    ], { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), DEVIN_API_KEY: "offline-placeholder" }, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /swe-1-6/);
    assert.ok(!result.stderr.includes("Failed to load extension"), result.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPi } from "./helpers/pi.js";

test("real Pi CLI loads extension and completes local read tool cycle with mocked native RPCs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-devin-integration-"));
  const fixture = join(dir, "fixture.txt");
  await writeFile(fixture, "native-devin-fixture\n");
  const extension = fileURLToPath(new URL("./fixtures/mock-extension.ts", import.meta.url));
  try {
    const result = await runPi([
      "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-mcp", "--no-session", "-e", extension, "--model", "devin/swe-1-6", "--tools", "read", "--print", "Read the fixture, then report success.",
    ], { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), DEVIN_API_KEY: "mock-session-token", DEVIN_TEST_FIXTURE: fixture }, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /MOCK_TOOL_CYCLE_OK/);
    assert.ok(!result.stderr.includes("Failed to load extension"), result.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

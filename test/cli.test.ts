import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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

test("discovered Devin models persist and are selected as defaults in fresh offline Pi processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-devin-default-"));
  const agentDir = join(dir, "agent");
  const fixture = join(dir, "fixture.txt");
  const id = "claude-opus-5-5-medium-fast";
  const extension = fileURLToPath(new URL("./fixtures/mock-extension.ts", import.meta.url));
  const flags = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "-e", extension];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, DEVIN_API_KEY: "mock-session-token", DEVIN_TEST_FIXTURE: fixture };
  try {
    await mkdir(agentDir);
    await writeFile(fixture, "native-devin-fixture\n");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "devin", defaultModel: id }));
    // Make Codex available too, reproducing the original silent startup fallback.
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "mock-codex-key" } }));
    const discover = await runPi([
      ...flags, "--offline", "--no-session", "--model", "devin/swe-1-6", "--tools", "read", "--print", "Read the fixture, then report success.",
    ], { ...env, DEVIN_TEST_CATALOG: id }, dir);
    assert.equal(discover.code, 0, discover.stderr);
    assert.match(discover.stdout, /MOCK_TOOL_CYCLE_OK/);
    const stored = JSON.parse(await readFile(join(agentDir, "models-store.json"), "utf8"));
    assert.equal(stored.devin.models[0].id, id);
    assert.equal(stored.devin.models[0].samplingParams.devin.modelRouter, undefined);
    assert.ok(!JSON.stringify(stored).includes("mock-session-token"), "cache must not contain credentials");
    // Each invocation has fresh plugin state, no CLI model override, and no network discovery.
    for (let restart = 0; restart < 2; restart++) {
      const result = await runPi([
        ...flags, "--offline", "--no-session", "--tools", "read", "--print", "Read the fixture, then report success.",
      ], { ...env, DEVIN_TEST_EXPECT_MODEL: `devin/${id}` }, dir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /MOCK_TOOL_CYCLE_OK/);
      assert.ok(!result.stderr.includes("AssertionError"), result.stderr);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { packageErrors, contentErrors, requiredFiles } from "../scripts/check-package.mjs";

function manifest() {
  return {
    name: "pi-devin-native", private: true, license: "MIT", keywords: ["pi-package"], pi: { extensions: ["./index.ts"] },
    peerDependencies: { "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*" },
    devDependencies: { "@earendil-works/pi-ai": "1.0.4", "@earendil-works/pi-coding-agent": "1.0.4" },
  };
}

test("package checks pass for a private development package but release is blocked", () => {
  assert.deepEqual(packageErrors(manifest(), requiredFiles), []);
  const errors = packageErrors(manifest(), requiredFiles, true);
  assert.ok(errors.some(error => error.includes("private:true")));
  for (const field of ["author", "repository", "homepage", "bugs"]) assert.ok(errors.some(error => error.includes(field)));
});

test("release accepts complete real-shaped metadata and rejects placeholders", () => {
  const release = { ...manifest(), private: false, author: "Test Maintainer", repository: { type: "git", url: "git+https://github.com/test-maintainer/pi-devin-native.git" },
    homepage: "https://github.com/test-maintainer/pi-devin-native#readme", bugs: { url: "https://github.com/test-maintainer/pi-devin-native/issues" } };
  assert.deepEqual(packageErrors(release, requiredFiles, true), []);
  assert.ok(packageErrors({ ...release, repository: "https://github.com/OWNER/pi-devin-native" }, requiredFiles, true).length > 0);
});

test("package checks reject missing entrypoints, secrets files and bundled host dependencies", () => {
  assert.ok(packageErrors(manifest(), requiredFiles.filter(path => path !== "index.ts")).some(error => error.includes("index.ts")));
  for (const file of [".env", "auth.json", ".pi/agent/auth.json", "node_modules/pkg/index.js", "test/fixtures/mock-extension.ts"])
    assert.ok(packageErrors(manifest(), [...requiredFiles, file]).length > 0);
  assert.ok(packageErrors({ ...manifest(), dependencies: { "@earendil-works/pi-ai": "1.0.4" } }, requiredFiles).some(error => error.includes("runtime dependency")));
});

test("best-effort content checks flag synthetic credential patterns and local paths", () => {
  assert.deepEqual(contentErrors("README.md", "devin-session-token$<token> is an example"), []);
  for (const sample of ["devin-session-token$" + "x".repeat(45), "eyJ" + "a".repeat(20) + "." + "b".repeat(20) + "." + "c".repeat(20),
    "-----BEGIN PRIVATE KEY-----", "npm_" + "n".repeat(35), "/Users/test-person/project/src"])
    assert.ok(contentErrors("fixture", sample).length > 0);
});

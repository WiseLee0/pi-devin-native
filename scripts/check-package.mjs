import { readFileSync, lstatSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const requiredFiles = [
  "index.ts", "src/oauth.ts", "src/stream.ts", "src/discovery.ts", "src/transport.ts", "src/messages.ts", "src/transform-messages.ts",
  "src/devin.ts", "src/devin-proto.ts", "src/vendor/devin-proto.ts", "src/vendor/protobuf.ts",
  "package.json", "README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "RELEASE.md",
];
const hostPackages = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"];
const placeholder = /(?:YOUR[-_ ]|OWNER|SCOPE|TODO|REPLACE_ME|example\.com|github\.com\/example\/)/i;

export function packageErrors(manifest, paths, release = false) {
  const errors = [];
  for (const file of requiredFiles) if (!paths.includes(file)) errors.push(`Missing packaged file: ${file}`);
  for (const path of paths) {
    if (!/^(?:index\.ts|package\.json|(?:README(?:\.zh-CN)?|LICENSE|CHANGELOG|SECURITY|CONTRIBUTING|RELEASE)(?:\.md)?|src\/.*\.ts)$/.test(path)) {
      errors.push(`Unexpected packaged file: ${path}`);
    }
    if (/(?:^|\/)(?:node_modules|\.pi|\.git|test|tests|coverage|\.env(?:\..*)?|auth\.json)(?:\/|$)/i.test(path)) {
      errors.push(`Private/development file in package: ${path}`);
    }
  }
  if (!manifest.keywords?.includes("pi-package")) errors.push("Missing pi-package keyword.");
  if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./index.ts"])) errors.push("Unexpected Pi entrypoint.");
  if (manifest.license !== "MIT") errors.push("License must preserve the MIT upstream grant.");
  for (const name of hostPackages) {
    if (manifest.dependencies?.[name]) errors.push(`Host package must not be a runtime dependency: ${name}`);
    if (manifest.peerDependencies?.[name] !== "*") errors.push(`Declare host-provided ${name} as a '*' peer dependency.`);
    if (manifest.devDependencies?.[name] !== "1.0.4") errors.push(`Pin development ${name} to tested Pi 1.0.4.`);
  }
  if (release) {
    if (manifest.private !== false && manifest.private !== undefined) errors.push("Remove private:true only after the release checklist is complete.");
    if (typeof manifest.name !== "string" || placeholder.test(manifest.name)) errors.push("Choose the real npm package name/scope.");
    const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    const metadata = {
      author: typeof manifest.author === "string" ? manifest.author : manifest.author?.name,
      repository, homepage: manifest.homepage, bugs: typeof manifest.bugs === "string" ? manifest.bugs : manifest.bugs?.url,
    };
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== "string" || !value.trim() || placeholder.test(value)) errors.push(`Set real, non-placeholder ${key} metadata.`);
    }
    for (const [key, value] of Object.entries(metadata).filter(([key]) => key !== "author")) {
      if (typeof value === "string" && !/^(?:https:\/\/|git\+https:\/\/)/.test(value)) errors.push(`${key} must be a public HTTPS URL.`);
    }
  }
  return errors;
}

export function contentErrors(path, content) {
  const errors = [];
  // This is a best-effort guard, not a replacement for reviewing every tracked file.
  if (/devin-session-token\$[A-Za-z0-9_.-]{40,}/.test(content)) errors.push(`Possible Devin session token in ${path}`);
  if (/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/.test(content)) errors.push(`Possible JWT in ${path}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) errors.push(`Private key in ${path}`);
  if (/npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}/.test(content)) errors.push(`Possible registry/GitHub token in ${path}`);
  if (/\/(?:Users|home)\/[^\s/"']+\//.test(content)) errors.push(`Machine-specific absolute path in ${path}`);
  return errors;
}

function main() {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  // --ignore-scripts prevents prepublishOnly/release:check recursion and install hooks.
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [...(npmCli ? [npmCli] : []), "pack", "--dry-run", "--json", "--ignore-scripts"];
  const packed = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (packed.error || packed.status !== 0) throw new Error("npm pack dry-run failed; inspect npm output manually.");
  const [report] = JSON.parse(packed.stdout);
  const paths = report.files.map(file => file.path);
  const release = process.argv.includes("--release");
  const errors = packageErrors(manifest, paths, release);
  for (const path of paths) {
    const full = resolve(root, path);
    if (relative(root, full).startsWith("..") || lstatSync(full).isSymbolicLink()) {
      errors.push(`Package path escapes root or is a symlink: ${path}`);
      continue;
    }
    errors.push(...contentErrors(path, readFileSync(full, "utf8")));
  }
  if (errors.length) {
    console.error(`${release ? "Release" : "Package"} check failed:\n${errors.map(error => `- ${error}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`${release ? "Release" : "Package"} check passed: ${paths.length} files, ${report.size} bytes packed.`);
    if (!release && manifest.private) console.log("Publication is intentionally blocked (private:true). See RELEASE.md.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Package check failed."); process.exitCode = 1; }
}

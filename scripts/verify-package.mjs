import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function getSinglePackResult(value) {
  const results = Array.isArray(value)
    ? value
    : isPackageResult(value)
      ? [value]
      : isRecord(value)
        ? Object.values(value)
        : [value];
  if (results.length !== 1) {
    throw new Error(
      `npm pack returned ${results.length} package results; expected exactly one`,
    );
  }

  const [result] = results;
  if (!isPackageResult(result)) {
    throw new Error("npm pack did not return a valid package file manifest");
  }
  return result;
}

function verifyPackage() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(
    npmCommand,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const packResult = getSinglePackResult(JSON.parse(output));
  const files = packResult.files.map(({ path }) => path);
  const requiredFiles = [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/client-entry.d.ts",
    "dist/client-entry.js",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/server-entry.d.ts",
    "dist/server-entry.js",
    "package.json",
  ];
  const missingFiles = requiredFiles.filter((path) => !files.includes(path));
  const compiledTestFiles = files.filter(
    (path) => path.startsWith("dist/") && path.includes(".test."),
  );

  if (missingFiles.length > 0) {
    throw new Error(
      `npm package is missing required files: ${missingFiles.join(", ")}`,
    );
  }

  if (compiledTestFiles.length > 0) {
    throw new Error(
      `npm package contains compiled tests: ${compiledTestFiles.join(", ")}`,
    );
  }

  process.stdout.write(
    `Verified npm package contents (${files.length} files).\n`,
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPackageResult(value) {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.every((file) => isRecord(file) && typeof file.path === "string")
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  verifyPackage();
}

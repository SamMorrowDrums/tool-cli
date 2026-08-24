import { execFileSync } from "node:child_process";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const output = execFileSync(
  npmCommand,
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);

const [packResult] = JSON.parse(output);
if (!packResult || !Array.isArray(packResult.files)) {
  throw new Error("npm pack did not return a package file manifest");
}

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

import { readFileSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
const [tagArgument, ...extraArguments] = process.argv.slice(2);

if (extraArguments.length > 0) {
  throw new Error("expected exactly one release tag argument");
}

const releaseTag = tagArgument ?? process.env.RELEASE_TAG;
if (!releaseTag) {
  throw new Error(
    "release tag is required as an argument or through RELEASE_TAG",
  );
}
if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json does not contain a valid version");
}

const expectedTag = `v${version}`;
if (releaseTag !== expectedTag) {
  throw new Error(`release tag ${releaseTag} does not match ${expectedTag}`);
}

process.stdout.write(
  `Verified release tag ${releaseTag} matches package version ${version}.\n`,
);

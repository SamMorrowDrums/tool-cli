import { describe, expect, it } from "vitest";
import { getSinglePackResult } from "./verify-package.mjs";

const packageResult = {
  name: "@sammorrowdrums/tool-cli",
  version: "1.0.1",
  files: [{ path: "package.json" }, { path: "dist/index.js" }],
};

describe("npm pack JSON normalization", () => {
  it("accepts npm's keyed object-shaped result", () => {
    expect(
      getSinglePackResult({
        "@sammorrowdrums/tool-cli": packageResult,
      }),
    ).toBe(packageResult);
  });

  it("accepts npm's one-element array-shaped result", () => {
    expect(getSinglePackResult([packageResult])).toBe(packageResult);
  });

  it.each([[], {}])("rejects zero package results: %j", (emptyResult) => {
    expect(() => getSinglePackResult(emptyResult)).toThrow(
      "npm pack returned 0 package results; expected exactly one",
    );
  });

  it.each([
    [packageResult, packageResult],
    { first: packageResult, second: packageResult },
  ])("rejects multiple package results: %j", (multipleResults) => {
    expect(() => getSinglePackResult(multipleResults)).toThrow(
      "npm pack returned 2 package results; expected exactly one",
    );
  });

  it.each([
    null,
    { files: "package.json" },
    { files: [{}] },
    { files: [{ path: 42 }] },
    { "@sammorrowdrums/tool-cli": { files: [{}] } },
  ])("rejects an invalid package result: %j", (invalidResult) => {
    expect(() => getSinglePackResult(invalidResult)).toThrow(
      "npm pack did not return a valid package file manifest",
    );
  });
});

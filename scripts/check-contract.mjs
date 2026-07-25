import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../vendor/termyte-contract/package.json", import.meta.url), "utf8"),
);

if (manifest.name !== "termyte" || manifest.version !== "1.1.0") {
  throw new Error("Vendored Termyte contract must be termyte@1.1.0");
}

for (const subpath of ["./protocol", "./agent-sdk", "./security/redaction"]) {
  const entry = manifest.exports?.[subpath];
  if (!entry?.import || !entry?.types) {
    throw new Error(`Vendored Termyte contract is missing ${subpath}`);
  }
  await Promise.all([
    import(new URL(`../vendor/termyte-contract/${entry.import.replace("./", "")}`, import.meta.url)),
    readFile(new URL(`../vendor/termyte-contract/${entry.types.replace("./", "")}`, import.meta.url)),
  ]);
}

process.stdout.write(`Verified ${manifest.name}@${manifest.version} cloud contract\n`);

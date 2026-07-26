import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../vendor/termyte-contract/package.json", import.meta.url), "utf8"),
);

if (manifest.name !== "termyte" || manifest.version !== "3.0.0") {
  throw new Error("Vendored Termyte contract must be termyte@3.0.0");
}

const fixtureManifest = JSON.parse(await readFile(new URL("../test/fixtures/cloud-contract/v3/manifest.json", import.meta.url), "utf8"));
if (fixtureManifest.schema_version !== 3) throw new Error("Vendored cloud fixtures must be protocol v3");
for (const [name, expected] of Object.entries(fixtureManifest.files)) {
  const bytes = await readFile(new URL(`../test/fixtures/cloud-contract/v3/${name}`, import.meta.url));
  const actual = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Fixture hash mismatch: ${name}`);
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

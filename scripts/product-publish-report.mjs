export function validateProductPublishReport({ manifest, recorded, report, budget }) {
  const actual = {
    id: report.id,
    name: report.name,
    version: report.version,
    files: report.entryCount ?? report.files?.length,
    compressedBytes: report.size,
    unpackedBytes: report.unpackedSize,
  };
  const expectedIdentity = {
    id: `${manifest.name}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    files: recorded.publishDryRun.files,
  };

  for (const [key, value] of Object.entries(expectedIdentity)) {
    if (actual[key] !== value) {
      throw new Error(`${manifest.name} dry-run ${key} changed: ${actual[key]} !== ${value}`);
    }
  }

  for (const [key, maximum] of [
    ["compressedBytes", budget?.compressedBytes],
    ["unpackedBytes", budget?.unpackedBytes],
  ]) {
    const value = actual[key];
    if (!Number.isInteger(value) || value < 1 || !Number.isInteger(maximum) || value > maximum) {
      throw new Error(`${manifest.name} dry-run ${key} is outside the portable budget: ${value} > ${maximum}`);
    }
  }

  return actual;
}

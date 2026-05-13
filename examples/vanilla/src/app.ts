import {
  buildExampleBrass,
  getExampleUserEffect,
} from "../../shared/src";

async function main() {
  const brass = await buildExampleBrass({
    serviceName: "brass-vanilla-example",
    environment: "local",
  });

  try {
    const response = await brass.runtime.toPromise(getExampleUserEffect(brass, "42"));

    console.log("user", response.body);
    console.log("http stats", brass.http.stats());
    console.log("metrics preview");
    console.log(brass.observability.prometheus.export().split("\n").slice(0, 12).join("\n"));
  } finally {
    await brass.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


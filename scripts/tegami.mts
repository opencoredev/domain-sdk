import { tegami } from "tegami";
import { runCli } from "tegami/cli";

const release = tegami({
  ignore: ["domain-sdk", "fumadocs", "@domain-sdk/config", "@domain-sdk/launch-video"],
  packages: {
    "@opencoredev/domain-sdk": {},
  },
});

await runCli(release);

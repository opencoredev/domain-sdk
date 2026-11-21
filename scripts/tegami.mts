import { tegami } from "tegami";
import { runCli } from "tegami/cli";

const release = tegami({
  ignore: ["domain-sdk", "fumadocs", "@domain-sdk/config"],
  packages: {
    "@opencoredev/domain-sdk": {},
  },
});

await runCli(release);

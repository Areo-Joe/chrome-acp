import { buildApplication } from "@stricli/core";
import { command } from "./command";

export const app = buildApplication(command, {
  name: "acp-proxy",
  versionInfo: {
    currentVersion: "1.0.0",
  },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
});


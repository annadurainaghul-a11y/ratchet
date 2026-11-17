#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    const message = error?.message || String(error);
    console.error(`\nratchet: ${message}`);
    if (/api[_ ]?key|authentication|401/i.test(message)) {
      console.error("\nSet ANTHROPIC_API_KEY, or sign in with `ant auth login`.");
    }
    process.exitCode = 1;
  });

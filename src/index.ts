#!/usr/bin/env node

import { createOpencodeServer } from "@opencode-ai/sdk/server";
import { runAcp } from "./acp-agent.js";

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

async function main() {
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
  });

  console.error(`Opencode server running at ${server.url}`);
  runAcp(server.url);
}

main().catch(console.error);

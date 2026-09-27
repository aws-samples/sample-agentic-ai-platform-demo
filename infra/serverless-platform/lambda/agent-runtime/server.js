"use strict";

import("./server.mjs")
  .then(({ startAgentRuntime }) => startAgentRuntime())
  .catch((error) => {
    console.error("Agent Runtime failed to start.", error);
    process.exitCode = 1;
  });

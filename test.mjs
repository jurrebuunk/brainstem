import { performance } from "node:perf_hooks";

import config from "./config.mjs";
import {
  Brainstem,
  createObservation
} from "./core.mjs";

const brainstem = new Brainstem(config);

async function run(name, observation) {
  const start = performance.now();

  const decision =
    await brainstem.process(observation);

  const ms =
    performance.now() - start;

  console.log(`\n=== ${name} ===`);

  console.log("\nISSUE");
  console.dir(observation, {
    depth: null,
    colors: true
  });

  console.log("\nDECISION");
  console.dir(decision, {
    depth: null,
    colors: true
  });

  console.log("\nTIME");
  console.log({
    ms: Number(ms.toFixed(2)),
    seconds: Number(
      (ms / 1000).toFixed(3)
    )
  });
}


console.log("\n=== STARTING BRAINSTEM ===");

const startupStart =
  performance.now();

await brainstem.start();

console.log({
  startup_ms: Number(
    (
      performance.now() -
      startupStart
    ).toFixed(2)
  )
});


/*
 * 1. Normal feature request
 */

await run(
  "1. FEATURE REQUEST",

  createObservation({
    id: "github:brainstem:issue:41",

    source: {
      type: "github",
      name: "brainstem"
    },

    type: "issue",

    state: "open",

    title:
      "Add support for Discord notifications",

    message:
      "It would be useful if Brainstem could send notifications to Discord when an observation is dispatched.",

    data: {
      number: 41,
      author: "example-user",
      labels: [
        "enhancement"
      ],
      comments: 0
    }
  })
);


/*
 * 2. Application bug
 */

await run(
  "2. BUG REPORT",

  createObservation({
    id: "github:brainstem:issue:42",

    source: {
      type: "github",
      name: "brainstem"
    },

    type: "issue",

    state: "open",

    title:
      "Brainstem crashes when observation data contains an empty array",

    message:
      "Calling process() with an observation containing an empty array in data causes the process to terminate unexpectedly.",

    data: {
      number: 42,
      author: "tester",
      labels: [
        "bug"
      ],
      comments: 3
    }
  })
);


/*
 * 3. Serious security issue
 */

await run(
  "3. SECURITY ISSUE",

  createObservation({
    id: "github:brainstem:issue:43",

    source: {
      type: "github",
      name: "brainstem"
    },

    type: "issue",

    state: "open",

    title:
      "Authentication token exposed in application logs",

    message:
      "GitHub authentication tokens are written unredacted to the application logs when the GitHub adapter encounters an API error.",

    data: {
      number: 43,
      author: "security-researcher",
      labels: [
        "bug",
        "security"
      ],
      comments: 2
    }
  })
);


/*
 * 4. Documentation typo
 */

await run(
  "4. DOCUMENTATION TYPO",

  createObservation({
    id: "github:brainstem:issue:44",

    source: {
      type: "github",
      name: "brainstem"
    },

    type: "issue",

    state: "open",

    title:
      "Typo in installation documentation",

    message:
      "The installation documentation says 'dependecies' instead of 'dependencies'.",

    data: {
      number: 44,
      author: "docs-user",
      labels: [
        "documentation"
      ],
      comments: 0
    }
  })
);


/*
 * 5. Production-breaking bug
 */

await run(
  "5. CRITICAL BUG",

  createObservation({
    id: "github:brainstem:issue:45",

    source: {
      type: "github",
      name: "brainstem"
    },

    type: "issue",

    state: "open",

    title:
      "Brainstem stops processing observations after several hours",

    message:
      "Multiple users report that Brainstem stops processing new observations after several hours. Existing monitors continue running but no new decisions are produced until the service is restarted.",

    data: {
      number: 45,
      author: "operator",
      labels: [
        "bug"
      ],
      comments: 8
    }
  })
);


/*
 * 6. Duplicate / already solved issue
 */

await run(
  "6. DUPLICATE ISSUE",

  createObservation({
    id: "github:brainstem:issue:46",

    source: {
      type: "github",
      name: "brainstem"
    },

    type: "issue",

    state: "open",

    title:
      "Discord notifications",

    message:
      "Can you add Discord notifications? I think this was already requested in another issue.",

    data: {
      number: 46,
      author: "another-user",
      labels: [
        "duplicate"
      ],
      comments: 1,
      duplicate_of: 41
    }
  })
);


await brainstem.close();

console.log(
  "\n=== GITHUB TEST COMPLETE ==="
);

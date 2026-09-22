export default {
  /*
   * Example input plugins.
   *
   * Copy this file to brainstem.config.mjs and edit for your environment.
   */
  inputs: [
    /*
    {
      id: "api-health",
      module: "./plugins/http-health/index.mjs",
      input: "check",
      config: {
        name: "example-api",
        url: "https://example.com/health",
        timeoutMs: 10000,
        expectedStatuses: [[200, 399]],
        failureThreshold: 3,
        recoveryThreshold: 2,
        minimumDecisionOnFailure: "dispatch"
      }
    },
    {
      id: "example-tls",
      module: "./plugins/tls-certificate/index.mjs",
      input: "check",
      config: {
        host: "example.com",
        warnDays: 14,
        criticalDays: 3,
        minimumDecisionOnWarning: "queue",
        minimumDecisionOnCritical: "dispatch"
      }
    },
    {
      id: "email-inbox",
      module: "./plugins/email-imap/index.mjs",
      input: "messages",
      config: {
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: "user@example.com",
        passwordEnv: "EMAIL_PASSWORD",
        mailbox: "INBOX",
        startFromNow: true,
        timeoutMs: 10000
      }
    },
    {
      id: "github-issues",
      module: "./plugins/github-issues/index.mjs",
      input: "issues",
      config: {
        repo: "owner/repo",
        tokenEnv: "GITHUB_TOKEN",
        perPage: 10
      }
    }
    */
  ],

  destinations: [
    {
      module: "./plugins/log-decisions/index.mjs",
      destination: "default",
      decisions: [
        "queue",
        "dispatch",
        "escalate"
      ],
      routes: "all",
      sources: "all",
      types: "all",
      config: {
        prefix: "brainstem"
      }
    }

    /*
    ,{
      module: "./plugins/matrix/index.mjs",
      destination: "room",
      decisions: "all",
      routes: "all",
      sources: ["http", "tls", "email"],
      types: ["health_check", "certificate", "message"],
      config: {
        homeserver: "https://matrix.example.org",
        roomId: "!roomid:example.org",
        tokenEnv: "MATRIX_ACCESS_TOKEN",
        notify: {
          actionableDecisions: ["queue", "dispatch", "escalate"],
          repeatAfterMs: 60 * 60 * 1000,
          onRecovery: true,
          statePath: "data/matrix-notifications.json"
        },
        retry: {
          attempts: 3,
          minDelayMs: 1000,
          maxDelayMs: 30000,
          factor: 2
        },
        message: {
          format: "text"
        },
        threading: true

      }
    }
    */
  ],

  runtime: {
    logging: {
      level: "info",
      format: "pretty"
    },

    records: {
      type: "sqlite",
      path: "data/brainstem.sqlite",
      pruneAfterDays: 90
    },

    checkpoints: {
      type: "json",
      path: "data/checkpoints.json"
    },

    retry: {
      attempts: 3,
      minDelayMs: 1000,
      maxDelayMs: 30000,
      factor: 2
    },

    startupRetry: {
      attempts: 3,
      minDelayMs: 5000,
      maxDelayMs: 60000,
      factor: 2
    },

    laya: {
      // Optional: avoid first-run model downloads by mounting a local model dir.
      // modelDir: "./data/laya-model",
      // Optional: override download cache location.
      // cacheDir: "./data/laya-cache"
    }
  },

  policy: {
    dispatch: {
      attention: 0.65,
      actionable: 0.60
    },

    queue: {
      actionable: 0.50,
      severity: 1.25
    },

    actionableQueue: {
      actionable: 0.65
    }
  },

  laya: {
    questions: {
      attention: {
        type: "noul",
        instructions:
          "Does this observation represent abnormal or problematic behavior that deserves investigation? Normal healthy behavior should score very low."
      },

      actionable: {
        type: "noul",
        instructions:
          "Could a technical agent usefully investigate, diagnose, fix, or otherwise act on this observation?"
      },

      severity: {
        type: "score",
        instructions:
          "Rate the actual technical impact of this observation.",
        criteria: [
          "normal - no problem and no meaningful impact",
          "minor - real issue but impact is small",
          "significant - functionality is degraded, failing, or requires investigation",
          "critical - major outage, confirmed compromise, data loss, or similarly severe impact"
        ]
      },

      route: {
        type: "choice",
        instructions:
          "Choose the primary technical domain responsible for investigating this observation.",
        criteria: {
          infrastructure:
            "Servers, containers, networking, storage, deployments, operating systems or service availability",

          coding:
            "Application behavior, source code, application errors, tests, builds or software defects",

          security:
            "Unauthorized access, authentication attacks, vulnerabilities, compromise or suspicious security activity",

          general:
            "Anything that does not clearly belong to another category"
        }
      }
    }
  }
};

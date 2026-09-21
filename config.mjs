export default {
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

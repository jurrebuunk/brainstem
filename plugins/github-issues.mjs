import { defineInputPlugin } from "../sdk.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/github",

  inputs: {
    issues: {
      mode: "poll",
      defaultIntervalMs: 60_000,

      async *poll(ctx) {
        const repo = ctx.config.repo;

        if (!repo) {
          throw new Error(
            "GitHub issues input requires config.repo, e.g. 'owner/name'"
          );
        }

        const state =
          ctx.config.state ?? "open";

        const perPage =
          ctx.config.perPage ?? 100;

        const url =
          new URL(
            `https://api.github.com/repos/${repo}/issues`
          );

        url.searchParams.set("state", state);
        url.searchParams.set("per_page", String(perPage));

        if (ctx.config.labels) {
          url.searchParams.set(
            "labels",
            ctx.config.labels
          );
        }

        const headers = {
          accept: "application/vnd.github+json",
          "user-agent": "brainstem"
        };

        const token =
          resolveToken(ctx.config);

        if (token) {
          headers.authorization =
            `Bearer ${token}`;
        }

        const response =
          await fetch(url, {
            headers,
            signal: ctx.signal
          });

        if (!response.ok) {
          let hint = "";

          if (response.status === 404) {
            hint =
              " Check that config.repo is a real 'owner/repo' repository. For private repositories, set GITHUB_TOKEN or config.tokenEnv.";
          }
          else if (response.status === 401) {
            hint =
              " Check that the GitHub token is valid.";
          }
          else if (response.status === 403) {
            hint =
              " Check token permissions or GitHub rate limits.";
          }

          throw new Error(
            `GitHub request failed for ${repo}: ${response.status} ${response.statusText}.${hint}`
          );
        }

        const issues =
          await response.json();

        for (const issue of issues) {
          if (issue.pull_request) {
            continue;
          }

          yield toObservation(ctx, repo, issue);
        }
      }
    }
  }
});

function toObservation(ctx, repo, issue) {
  const labels =
    issue.labels
      .map(label => label.name)
      .sort();

  const facts = {};

  if (labels.includes("security")) {
    facts.minimum_decision = "dispatch";
  }

  return ctx.observation({
    id: `github:${repo}:issue:${issue.number}`,

    source: {
      type: "github",
      name: repo
    },

    type: "issue",
    state: issue.state,

    title: issue.title,
    message: issue.body ?? "",

    facts,

    data: {
      number: issue.number,
      author: issue.user?.login ?? null,
      labels,
      comments: issue.comments,
      url: issue.html_url
    }
  });
}

function resolveToken(config) {
  /*
   * Preferred:
   *   tokenEnv: "GITHUB_TOKEN"
   * or:
   *   token: { env: "GITHUB_TOKEN" }
   *
   * Plain token strings are supported for tests, but should not
   * be committed in real config files.
   */
  if (typeof config.token === "string") {
    return config.token;
  }

  if (
    config.token &&
    typeof config.token === "object" &&
    typeof config.token.env === "string"
  ) {
    return process.env[config.token.env];
  }

  if (config.tokenEnv) {
    return process.env[config.tokenEnv];
  }

  return process.env.GITHUB_TOKEN;
}

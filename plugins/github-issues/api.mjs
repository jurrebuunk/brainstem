export async function fetchIssues(config, signal) {
  const issues = [];

  for (let page = 1; page <= config.maxPages; page += 1) {
    const pageIssues =
      await fetchIssuePage(
        config,
        page,
        signal
      );

    issues.push(
      ...pageIssues
    );

    if (pageIssues.length < config.perPage) {
      break;
    }
  }

  return issues;
}

async function fetchIssuePage(config, page, signal) {
  const url =
    new URL(
      `https://api.github.com/repos/${config.repo}/issues`
    );

  url.searchParams.set("state", config.state);
  url.searchParams.set("per_page", String(config.perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", config.sort);
  url.searchParams.set("direction", config.direction);

  if (config.labels) {
    url.searchParams.set(
      "labels",
      config.labels
    );
  }

  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "brainstem"
  };

  if (config.token) {
    headers.authorization =
      `Bearer ${config.token}`;
  }

  const response =
    await fetch(url, {
      headers,
      signal
    });

  if (!response.ok) {
    throw new Error(
      githubErrorMessage(config.repo, response)
    );
  }

  return await response.json();
}

function githubErrorMessage(repo, response) {
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

  return `GitHub request failed for ${repo}: ${response.status} ${response.statusText}.${hint}`;
}

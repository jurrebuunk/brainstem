export function toObservation(ctx, repo, issue) {
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

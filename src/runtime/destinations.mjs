export function eventMatchesDestination(event, entry) {
  return (
    decisionLevelMatches(event.decision, entry) &&
    routeMatches(event.decision, entry) &&
    sourceMatches(event.observation, entry) &&
    typeMatches(event.observation, entry)
  );
}

function decisionLevelMatches(decision, entry) {
  const allowed = entry.decisions ?? ["queue", "dispatch", "escalate"];
  if (allowed === "all") return true;
  return allowed.includes(decision.payload.decision);
}

function routeMatches(decision, entry) {
  const allowed = entry.routes;
  if (!allowed || allowed === "all") return true;
  return allowed.includes(decision.payload.route);
}

function sourceMatches(observation, entry) {
  const allowed = entry.sources;
  if (!allowed || allowed === "all") return true;
  return allowed.includes(observation.payload.source.type);
}

function typeMatches(observation, entry) {
  const allowed = entry.types;
  if (!allowed || allowed === "all") return true;
  return allowed.includes(observation.payload.type);
}

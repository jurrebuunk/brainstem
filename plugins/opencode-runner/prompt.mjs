export function buildPrompt(config, event) {
  if (typeof config.promptTemplate === "function") {
    return config.promptTemplate(event);
  }

  const observation = event.observation.payload;
  const decision = event.decision.payload;

  return [
    "You are being invoked by Brainstem because an observation was classified as actionable.",
    "Investigate the observation and perform the appropriate coding or operational work.",
    "Be careful, explain what you do, and stop when the task is complete.",
    "",
    "Brainstem decision:",
    JSON.stringify(decision, null, 2),
    "",
    "Observation:",
    JSON.stringify(observation, null, 2)
  ].join("\n");
}

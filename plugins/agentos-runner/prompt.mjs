/*
 * Templates see the output envelope with the inner envelopes
 * unwrapped, so `{{observation.data.title}}` and
 * `{{decision.route}}` work as written:
 *
 *   { decision, observation, input, destination,
 *     timestamp, pollId, idempotencyKey }
 */
export function templateScope(event) {
  return {
    ...event,
    decision: event.decision?.payload ?? event.decision ?? null,
    observation: event.observation?.payload ?? event.observation ?? null
  };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/*
 * Renders a string template or calls a template function. A
 * function receives the raw event and must return the final
 * text itself; `quote` only applies to string templates.
 */
export function renderTemplate(template, event, { quote = value => value } = {}) {
  if (typeof template === "function") {
    const rendered = template(event);

    if (typeof rendered !== "string" || !rendered.trim()) {
      throw new TypeError("agentos-runner: template function must return a non-empty string");
    }

    return rendered;
  }

  const scope = templateScope(event);

  return template.replace(PLACEHOLDER, (_, path) =>
    quote(stringify(lookup(scope, path)))
  );
}

/*
 * Command templates interpolate observation data (issue titles,
 * email subjects, ...) into a shell line. Every value is quoted
 * so that data can never become shell syntax.
 */
export function renderCommand(template, event) {
  return renderTemplate(template, event, { quote: shellQuote });
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/*
 * The messages that start an agent run. The envelope itself is
 * not inlined (observation data can be large); the model gets a
 * compact summary and can inspect the full file with commands.
 */
export function buildAgentPrompt(config, event) {
  const { observation, decision } = templateScope(event);
  const { limits } = config;
  const required = Object.values(config.tools)
    .filter(tool => tool.required)
    .map(tool => tool.name);

  const system = [
    "You are a small, careful task agent started by Brainstem, an operations monitor.",
    "Work in as few steps as possible and keep answers short.",
    `Budget: at most ${limits.maxCommands} commands and ${limits.maxTurns} turns; command output is cut at ${limits.maxToolOutputChars} characters.`,
    "Use targeted commands (grep, head, tail, wc) instead of printing whole files. Never repeat a command.",
    `The observation summary below is usually enough; the full envelope is JSON at ${config.inboxPath} if you need a specific field (grep it rather than printing it).`,
    `To return structured data, write JSON to ${config.outboxPath}.`,
    required.length > 0
      ? `You must call ${required.join(", ")} before you finish.`
      : null,
    "When done, reply with a brief final answer and no tool calls."
  ].filter(Boolean).join("\n");

  const context = [
    "Observation:",
    `- id: ${observation?.id ?? "unknown"}`,
    `- source: ${observation?.source?.type ?? "?"}/${observation?.source?.name ?? "?"} (type ${observation?.type ?? "?"}, state ${observation?.state ?? "?"})`,
    `- title: ${clip(observation?.title, 200)}`,
    `- message: ${clip(observation?.message, 600)}`,
    `- decision: ${decision?.decision ?? "?"} (route ${decision?.route ?? "?"})`,
    decision?.reason ? `- reason: ${clip(decision.reason, 200)}` : null
  ].filter(Boolean).join("\n");

  return {
    system,
    prompt: `${renderTemplate(config.prompt, event).trim()}\n\n${context}`
  };
}

function clip(value, max) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/*
 * agentOS turns a host function key into a kebab-case command:
 * `sendReport` and `send-report` both become `send-report`;
 * snake_case is kept as written.
 */
export function toolCommandName(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function lookup(scope, path) {
  let value = scope;

  for (const key of path.split(".")) {
    if (value === null || value === undefined) return undefined;
    value = value[key];
  }

  return value;
}

function stringify(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

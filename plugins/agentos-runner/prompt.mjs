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
 * The task prompt plus the facts every agent run needs: where
 * the envelope is, where to put a result, and which tools exist.
 */
export function buildAgentPrompt(config, event) {
  const task = renderTemplate(config.prompt, event);
  const tools = Object.values(config.tools);
  const lines = [
    task.trim(),
    "",
    "---",
    "Context from Brainstem:",
    `- The full decision and observation envelope is at ${config.inboxPath}.`,
    `- To return a structured result, write JSON to ${config.outboxPath}.`
  ];

  if (tools.length === 0) {
    lines.push("- No tools are available for this task.");
  }
  else {
    lines.push(
      `- Tools run on the host. Call them as \`agentos-${config.toolCollection} <tool> --<field> <value>\`; each prints a JSON result.`
    );

    for (const tool of tools) {
      const limits = [
        tool.required ? "required: call it before you finish" : null,
        `at most ${tool.maxCalls} call${tool.maxCalls === 1 ? "" : "s"}`
      ].filter(Boolean).join(", ");

      lines.push(`  - ${toolCommandName(tool.name)}: ${tool.description} (${limits})`);
    }
  }

  return lines.join("\n");
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

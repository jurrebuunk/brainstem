export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function readJsonBody(request, fallback, { maxBodyBytes }) {
  const body = await readBody(request, { maxBodyBytes });
  if (!body) return fallback;

  try {
    return JSON.parse(body);
  }
  catch {
    throw new HttpError(400, "Invalid JSON request body");
  }
}

export function readBody(request, { maxBodyBytes }) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", chunk => {
      size += chunk.length;

      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }

      if (!tooLarge) chunks.push(chunk);
    });

    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "Request body too large"));
        return;
      }

      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

export function sendJson(response, value, status = 200) {
  response.writeHead(status, responseHeaders({
    "content-type": "application/json; charset=utf-8"
  }));
  response.end(JSON.stringify(value));
}

export function sendNoContent(response, status = 204) {
  response.writeHead(status, responseHeaders());
  response.end();
}

export function responseHeaders(headers = {}) {
  return { ...headers };
}

export function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

export function finiteNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampLimit(value, fallback) {
  const limit = positiveInteger(value, fallback);
  return Math.min(Math.max(limit, 1), 10_000);
}

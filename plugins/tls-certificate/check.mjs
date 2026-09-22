import tls from "node:tls";

export async function checkCertificate(target, parentSignal) {
  const startedAt = Date.now();

  try {
    const result =
      await fetchCertificate(target, parentSignal);

    return evaluateCertificate(
      target,
      result,
      startedAt
    );
  }
  catch (error) {
    return {
      state: "unreachable",
      ok: false,
      error: error.message,
      authorized: false,
      authorizationError: null,
      validTo: null,
      daysRemaining: null,
      fingerprint256: null,
      checkedAt: new Date(startedAt).toISOString()
    };
  }
}

export function evaluateCertificate(target, result, now = Date.now()) {
  const certificate =
    result.certificate;

  if (!certificate || Object.keys(certificate).length === 0) {
    return {
      state: "invalid",
      ok: false,
      error: "No peer certificate was returned",
      authorized: result.authorized,
      authorizationError: result.authorizationError,
      validTo: null,
      daysRemaining: null,
      fingerprint256: null,
      checkedAt: new Date(now).toISOString()
    };
  }

  const validToDate =
    new Date(certificate.valid_to);

  const daysRemaining =
    Math.floor(
      (validToDate.getTime() - now) /
      (24 * 60 * 60 * 1000)
    );

  let state = "valid";
  let ok = true;
  let error = null;

  if (
    target.checkAuthorization &&
    !result.authorized
  ) {
    state = "invalid";
    ok = false;
    error = result.authorizationError ?? "Certificate is not authorized";
  }
  else if (daysRemaining < 0) {
    state = "expired";
    ok = false;
    error = "Certificate has expired";
  }
  else if (daysRemaining <= target.criticalDays) {
    state = "critical";
    ok = false;
    error = `Certificate expires in ${daysRemaining} day(s)`;
  }
  else if (daysRemaining <= target.warnDays) {
    state = "expiring";
    ok = false;
    error = `Certificate expires in ${daysRemaining} day(s)`;
  }

  return {
    state,
    ok,
    error,
    authorized: result.authorized,
    authorizationError: result.authorizationError,
    validTo: validToDate.toISOString(),
    daysRemaining,
    fingerprint256: certificate.fingerprint256 ?? null,
    subject: certificate.subject ?? null,
    issuer: certificate.issuer ?? null,
    checkedAt: new Date(now).toISOString()
  };
}

function fetchCertificate(target, parentSignal) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.servername,
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("TLS connection timed out"));
    }, target.timeoutMs);

    const abort = () => {
      cleanup();
      socket.destroy();
      reject(new Error("TLS check aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
      socket.removeAllListeners();
    };

    parentSignal?.addEventListener(
      "abort",
      abort,
      { once: true }
    );

    socket.once("secureConnect", () => {
      const certificate =
        socket.getPeerCertificate(true);

      const result = {
        certificate,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ?? null
      };

      cleanup();
      socket.end();
      resolve(result);
    });

    socket.once("error", error => {
      cleanup();
      reject(error);
    });
  });
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import { buildFlowModel } from "./flow/model.js";
import NodeInspector from "./components/NodeInspector.jsx";

const nodeTypes = {
  brainstemNode: BrainstemNode,
  handoffPill: HandoffPillNode
};

const pages = [
  { id: "flow", label: "Flow", icon: "schema", permission: "dashboard:read" },
  { id: "stats", label: "Stats", icon: "query_stats", permission: "stats:read" },
  { id: "deliveries", label: "Deliveries", icon: "outbox", permission: "runtime:read" },
  { id: "settings", label: "Settings", icon: "settings" }
];

const settingsTabs = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "config", label: "Config", icon: "code", permission: "config:read" },
  { id: "users", label: "Users", icon: "group", permission: "users:read" },
  { id: "roles", label: "Roles", icon: "admin_panel_settings", permission: "roles:read" }
];

const defaultMetrics = [
  "events.total",
  "decisions.total",
  "outputs.total",
  "errors.total"
];

const metricColors = [
  "--brainstem",
  "--input-active",
  "--destination-active",
  "--danger",
  "--warning",
  "--brainstem-active",
  "--success",
  "--muted-2"
];

const statsRanges = [
  [30 * 60 * 1000, "30m"],
  [60 * 60 * 1000, "1h"],
  [3 * 60 * 60 * 1000, "3h"],
  [6 * 60 * 60 * 1000, "6h"]
];

const lightEditorTheme = EditorView.theme({
  "&": {
    backgroundColor: "#ffffff",
    color: "#0f172a"
  },
  ".cm-content": {
    caretColor: "#be185d"
  },
  ".cm-gutters": {
    backgroundColor: "#f8fafc",
    color: "#64748b",
    borderRightColor: "#e2e8f0"
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "#fce7f3"
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "#be185d"
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgba(219, 39, 119, 0.18)"
  }
}, { dark: false });


export default function App() {
  const [events, setEvents] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [page, setPageState] = useState(pageFromPath(window.location.pathname));
  const [settingsTab, setSettingsTabState] = useState(settingsTabFromPath(window.location.pathname));
  const [themePreference, setThemePreference] = useState(() => {
    return localStorage.getItem("brainstem-theme") ?? "dark";
  });
  const [actualTheme, setActualTheme] = useState("dark");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("brainstem-sidebar-width"));
    return Number.isFinite(stored) && stored >= 160 ? stored : 220;
  });
  const auth = useAuth();
  const [flowInstance, setFlowInstance] = useState(null);
  const autoFitDoneRef = useRef(false);
  const topology = useTopology(auth);
  const graph = useMemo(() => {
    try {
      return buildFlowModel({ topology, events, now: clock });
    }
    catch (error) {
      console.error("Failed to build flow graph", error);
      return { nodes: [], edges: [], cores: [], nodeIdsFor: () => [], error };
    }
  }, [topology, events, clock]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes(current => alignHandoffPills(graph.nodes, current));
    setEdges(graph.edges);

    if (flowInstance && page === "flow" && !autoFitDoneRef.current && graph.nodes.length > 1) {
      autoFitDoneRef.current = true;
      requestAnimationFrame(() => {
        flowInstance.fitView({ padding: 0.2, duration: 180 });
      });
    }
  }, [flowInstance, graph, page, setEdges, setNodes]);

  useEffect(() => {
    const onPopState = () => {
      setPageState(pageFromPath(window.location.pathname));
      setSettingsTabState(settingsTabFromPath(window.location.pathname));
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      const resolved = themePreference === "system"
        ? media.matches ? "light" : "dark"
        : themePreference;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themePreference = themePreference;
      localStorage.setItem("brainstem-theme", themePreference);
      setActualTheme(resolved);
    };

    applyTheme();
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
  }, [themePreference]);

  const setPage = useCallback(pageId => {
    setPageState(pageId);
    if (pageId === "settings") {
      setSettingsTabState(current => current || "appearance");
    }
    const path = pathForPage(pageId, settingsTab);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  }, [settingsTab]);

  const setSettingsTab = useCallback(tabId => {
    setSettingsTabState(tabId);
    setPageState("settings");
    const path = pathForSettingsTab(tabId);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setClock(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!auth.user || !hasPermission(auth.user, "events:read")) return undefined;

    auth.apiFetch("/api/events")
      .then(response => response.json())
      .then(setEvents)
      .catch(error => {
        if (error.status === 401) auth.refresh();
      });

    const source = new EventSource("/api/stream", { withCredentials: true });

    source.onmessage = message => {
      const event = JSON.parse(message.data);
      if (event.kind === "web.connected") return;
      setEvents(current => [...current.slice(-1999), event]);
    };

    source.onerror = () => {
      // Let the browser retry; auth refresh happens through normal API calls.
    };

    return () => source.close();
  }, [auth.user?.id]);

  const onNodeClick = useCallback((_event, node) => {
    // The transient handoff pill has nothing to inspect.
    if (node.type === "handoffPill") return;
    setSelectedNode(node);
  }, []);

  const nodeEvents = useMemo(() => {
    if (!selectedNode) {
      return [];
    }

    return events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => graph.nodeIdsFor(event).includes(selectedNode.id))
      .reverse();
  }, [events, selectedNode, graph]);

  if (auth.loading) {
    return <AuthShell title="Loading Brainstem…" />;
  }

  if (auth.setupRequired) {
    return <FirstRunOnboarding auth={auth} />;
  }

  if (!auth.user && auth.error) {
    return <BackendUnavailable auth={auth} />;
  }

  if (!auth.user) {
    return <LoginPage auth={auth} />;
  }

  return (
    <main
      className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` }}
    >
      <Sidebar
        page={page}
        setPage={setPage}
        collapsed={sidebarCollapsed}
        setCollapsed={setSidebarCollapsed}
        width={sidebarWidth}
        setWidth={setSidebarWidth}
        user={auth.user}
        onLogout={auth.logout}
      />

      <section className="page">
        {page === "flow" && (
          <FlowPage
            nodes={nodes}
            edges={edges}
            cores={graph.cores}
            structure={graph.structure}
            graphError={graph.error}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onInit={setFlowInstance}
          />
        )}
        {page === "stats" && <StatsPage events={events} actualTheme={actualTheme} auth={auth} />}
        {page === "deliveries" && <DeliveriesPage auth={auth} />}
        {page === "settings" && (
          <SettingsPage
            activeTab={settingsTab}
            setActiveTab={setSettingsTab}
            themePreference={themePreference}
            actualTheme={actualTheme}
            setThemePreference={setThemePreference}
            auth={auth}
          />
        )}
      </section>

      {selectedNode && page === "flow" && (
        <NodeInspector
          node={selectedNode}
          events={nodeEvents}
          allEvents={events}
          nodeIdsFor={graph.nodeIdsFor}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </main>
  );
}

/*
 * Structure for the Flow page from GET /api/topology (cores plus
 * configured inputs/destinations). null when the user may not read
 * it or the backend predates the endpoint; the flow model then
 * falls back to snapshot events.
 */
function useTopology(auth) {
  const [topology, setTopology] = useState(null);
  const allowed = Boolean(auth.user) && hasPermission(auth.user, "runtime:read");

  useEffect(() => {
    if (!allowed) {
      setTopology(null);
      return undefined;
    }

    let cancelled = false;

    const load = () => {
      auth.apiFetch("/api/topology")
        .then(response => response.json())
        .then(body => {
          if (!cancelled) setTopology(body);
        })
        .catch(() => {
          if (!cancelled) setTopology(null);
        });
    };

    load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [allowed, auth.user?.id]);

  return topology;
}

function useAuth() {
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const apiFetch = useCallback(async (url, options = {}) => {
    const method = options.method ?? "GET";
    const headers = {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) ? { "x-csrf-token": csrfToken } : {}),
      ...(options.headers ?? {})
    };
    const response = await fetch(url, {
      credentials: "include",
      ...options,
      method,
      headers
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const err = new Error(body.error ?? `Request failed (${response.status})`);
      err.status = response.status;
      throw err;
    }
    return response;
  }, [csrfToken]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await fetch("/api/auth/status", { credentials: "include" }).then(response => response.json());
      setSetupRequired(status.setupRequired === true);
      if (!status.setupRequired) {
        const me = await fetch("/api/auth/me", { credentials: "include" });
        if (me.ok) {
          const body = await me.json();
          setUser(body.user);
          setCsrfToken(body.csrfToken);
        }
        else {
          setUser(null);
          setCsrfToken(null);
        }
      }
      else {
        setUser(null);
        setCsrfToken(null);
      }
    }
    catch (refreshError) {
      setError(refreshError.message);
      setUser(null);
    }
    finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (payload, setup = false) => {
    setError(null);
    const response = await fetch(setup ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Authentication failed");
    setUser(body.user);
    setCsrfToken(body.csrfToken);
    setSetupRequired(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    }
    catch {}
    setUser(null);
    setCsrfToken(null);
  }, [apiFetch]);

  return { user, csrfToken, setupRequired, loading, error, apiFetch, login, logout, refresh };
}

function hasPermission(user, permission) {
  return Boolean(user?.permissions?.includes(permission));
}

function AuthShell({ title, children }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark">B</span><strong>Brainstem</strong></div>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function BackendUnavailable({ auth }) {
  return (
    <AuthShell title="Backend unavailable">
      <p>Brainstem Web is running, but it cannot reach the backend API. Start the backend API or enable runtime.api in the Brainstem config, then retry.</p>
      <pre className="auth-command">npm run api{"\n"}WEB_BACKEND_URL=http://127.0.0.1:5174 npm run web</pre>
      <div className="notice notice-error">{auth.error}</div>
      <button className="auth-primary-button" onClick={auth.refresh}>Retry connection</button>
    </AuthShell>
  );
}

function LoginPage({ auth }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState(auth.error ?? "");

  const submit = async event => {
    event.preventDefault();
    setNotice("");
    try {
      await auth.login({ username, password }, false);
    }
    catch (error) {
      setNotice(error.message);
    }
  };

  return (
    <AuthShell title="Sign in">
      <p>Sign in to manage Brainstem.</p>
      {notice && <div className="notice notice-error">{notice}</div>}
      <form className="auth-form" onSubmit={submit}>
        <label>Username<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label>
        <label>Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
        <button type="submit">Login</button>
      </form>
    </AuthShell>
  );
}

function FirstRunOnboarding({ auth }) {
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(auth.error ?? "");
  const passwordChecks = useMemo(() => evaluatePassword(password, username), [password, username]);
  const secureContext = typeof window === "undefined" || window.location.protocol === "https:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const usernameOk = /^[a-zA-Z0-9_.@-]{3,80}$/.test(username);
  const canSubmit = usernameOk && passwordChecks.ok && password === confirmPassword && acknowledged && !submitting;

  const submit = async event => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setNotice("");
    try {
      await auth.login({ username, name, password }, true);
    }
    catch (error) {
      setNotice(error.message);
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title="Set up Brainstem">
      <div className="onboarding-progress" aria-label="Setup progress">
        {["Secure", "Admin", "Finish"].map((label, index) => (
          <button key={label} className={step === index ? "active" : index < step ? "complete" : ""} onClick={() => setStep(index)} type="button">
            <span>{index + 1}</span>{label}
          </button>
        ))}
      </div>
      {notice && <div className="notice notice-error">{notice}</div>}
      {step === 0 && (
        <div className="onboarding-panel">
          <p className="onboarding-lede">No administrator exists yet. Create the first local administrator before Brainstem exposes telemetry, config, or user management.</p>
          <ul className="security-list">
            <li><span className="material-symbols-outlined" aria-hidden="true">lock</span>No default credentials are created.</li>
            <li><span className="material-symbols-outlined" aria-hidden="true">key</span>Passwords are hashed with Argon2id.</li>
            <li><span className="material-symbols-outlined" aria-hidden="true">verified_user</span>Admin sessions use HttpOnly cookies, SameSite, and CSRF protection.</li>
            <li className={secureContext ? "ok" : "warn"}><span className="material-symbols-outlined" aria-hidden="true">{secureContext ? "shield" : "warning"}</span>{secureContext ? "This setup page is running in a secure local/HTTPS context." : "Use HTTPS or localhost before entering credentials."}</li>
          </ul>
          <button type="button" onClick={() => setStep(1)}>Continue</button>
        </div>
      )}
      {step === 1 && (
        <form className="auth-form onboarding-form" onSubmit={event => { event.preventDefault(); setStep(2); }}>
          <label>Admin username<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required pattern="[a-zA-Z0-9_.@-]{3,80}" /></label>
          {!usernameOk && username && <small className="field-hint error">Use 3-80 letters, numbers, dot, underscore, @, or dash.</small>}
          <label>Display name<input value={name} onChange={event => setName(event.target.value)} autoComplete="name" /></label>
          <label>Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="new-password" required minLength="12" /></label>
          <PasswordChecklist checks={passwordChecks.checks} />
          <label>Confirm password<input value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" required /></label>
          {confirmPassword && password !== confirmPassword && <small className="field-hint error">Passwords do not match.</small>}
          <button type="submit" disabled={!usernameOk || !passwordChecks.ok || password !== confirmPassword}>Review setup</button>
        </form>
      )}
      {step === 2 && (
        <form className="auth-form onboarding-form" onSubmit={submit}>
          <div className="setup-summary">
            <strong>Initial administrator</strong>
            <span>{username}</span>
            <small>This account receives the Administrator role. You can create lower-privilege users after setup.</small>
          </div>
          <label className="check-label">
            <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
            I saved this password in a password manager. Brainstem cannot recover it.
          </label>
          <button type="submit" disabled={!canSubmit}>{submitting ? "Creating administrator…" : "Create administrator"}</button>
          <button type="button" className="secondary-button" onClick={() => setStep(1)}>Back</button>
        </form>
      )}
    </AuthShell>
  );
}

function PasswordChecklist({ checks }) {
  return (
    <ul className="password-checklist">
      {checks.map(check => (
        <li key={check.label} className={check.ok ? "ok" : ""}>
          <span className="material-symbols-outlined" aria-hidden="true">{check.ok ? "check_circle" : "radio_button_unchecked"}</span>
          {check.label}
        </li>
      ))}
    </ul>
  );
}

function evaluatePassword(password, username) {
  const lower = password.toLowerCase();
  const checks = [
    { label: "At least 12 characters", ok: password.length >= 12 },
    { label: "Not a common or repeated password", ok: !new Set(["password1234", "password12345", "password123456", "adminadminadmin", "brainstembrainstem"]).has(lower) && !/^(.)\1{11,}$/.test(password) },
    { label: "Different from the username", ok: !username || !lower.includes(username.toLowerCase()) },
    { label: "Use a mix of words, numbers, or symbols", ok: [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(pattern => pattern.test(password)).length >= 3 }
  ];
  return { checks, ok: checks.every(check => check.ok) };
}

function Sidebar({ page, setPage, collapsed, setCollapsed, width, setWidth, user, onLogout }) {
  const startResize = useCallback(event => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    const onMove = moveEvent => {
      const next = Math.min(420, Math.max(160, startWidth + moveEvent.clientX - startX));
      setWidth(next);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem("brainstem-sidebar-width", String(width));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [setWidth, width]);

  useEffect(() => {
    if (!collapsed) {
      localStorage.setItem("brainstem-sidebar-width", String(width));
    }
  }, [collapsed, width]);

  return (
    <aside className="sidebar">
      <button
        className="sidebar-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {collapsed ? "chevron_right" : "chevron_left"}
        </span>
      </button>
      <div className="sidebar-brand">
        <span className="brand-mark">B</span>
        {!collapsed && <span>Brainstem</span>}
      </div>
      <nav className="sidebar-nav">
        {pages.filter(item => !item.permission || hasPermission(user, item.permission)).map(item => (
          <button
            key={item.id}
            className={page === item.id ? "active" : ""}
            onClick={() => setPage(item.id)}
            title={item.label}
          >
            <span className="material-symbols-outlined" aria-hidden="true">{item.icon}</span>
            {!collapsed && item.label}
          </button>
        ))}
      </nav>
      {user && (
        <div className="sidebar-user">
          {!collapsed && (
            <div className="sidebar-user-meta">
              <strong>{user.name || user.username}</strong>
              <span>{user.roles?.map(role => role.name).join(", ")}</span>
            </div>
          )}
          <button onClick={onLogout} title="Logout" aria-label="Logout">
            <span className="material-symbols-outlined" aria-hidden="true">logout</span>
            {!collapsed && "Logout"}
          </button>
        </div>
      )}
      {!collapsed && <div className="sidebar-resizer" onPointerDown={startResize} title="Resize sidebar" />}
    </aside>
  );
}

function FlowPage({ nodes, edges, cores = [], structure, graphError, onNodesChange, onEdgesChange, onNodeClick, onInit }) {
  const [interactive, setInteractive] = useState(false);

  return (
    <div className="flow-page">
      {cores.length > 0 && <CoresPanel cores={cores} />}
      {graphError && (
        <FlowNotice
          title="Flow unavailable"
          message="One telemetry event could not be rendered. New events will keep streaming."
        />
      )}
      {!graphError && nodes.length <= 1 && (
        <FlowNotice
          title="Waiting for telemetry"
          message="Start Brainstem with runtime.telemetry.url pointing at this Web UI to populate the graph."
        />
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onInit={onInit}
        nodesDraggable={interactive}
        nodesConnectable={interactive}
        elementsSelectable={interactive}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.25}
        maxZoom={1.4}
      >
        <Background color="var(--bg-grid)" gap={22} size={1} />
        <Controls onInteractiveChange={setInteractive} />
      </ReactFlow>
    </div>
  );
}

/*
 * The registered cores: one row per runtime process, with its
 * heartbeat status. With one runtime this is a single row.
 */
function CoresPanel({ cores }) {
  const [open, setOpen] = useState(false);
  const running = cores.filter(core => core.status === "running").length;

  return (
    <aside className={`cores-panel${open ? " is-open" : ""}`} aria-label="Cores">
      <button className="cores-panel-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span className="material-symbols-outlined" aria-hidden="true">memory</span>
        <span>{cores.length} core{cores.length === 1 ? "" : "s"}</span>
        <span className="cores-panel-count">{running} running</span>
        <span className="material-symbols-outlined" aria-hidden="true">{open ? "expand_less" : "expand_more"}</span>
      </button>
      {open && (
        <ul className="cores-panel-list">
          {cores.map(core => (
            <li key={core.id} className={`core-row core-${core.status}`}>
              <span className="core-dot" aria-hidden="true" />
              <div>
                <strong title={core.id}>{core.id}</strong>
                <span>
                  {core.status} · seen {formatTime(core.lastSeenAt)}
                  {core.version ? ` · v${core.version}` : ""}
                </span>
                <span>{[core.role, ...(core.queues ?? [])].join(" · ")}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function FlowNotice({ title, message }) {
  return (
    <div className="flow-notice">
      <span className="material-symbols-outlined" aria-hidden="true">info</span>
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
    </div>
  );
}

function BrainstemNode({ data }) {
  const isInput = data.nodeType === "input";
  const isCore = data.nodeType === "core";
  const isDestination = data.nodeType === "destination";

  return (
    <div
      className={`node-card node-${data.nodeType}${data.active ? " is-active" : ""}`}
      style={{ minHeight: data.height }}
    >
      {isCore && data.inputHandles.map(handle => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="target"
          position={Position.Left}
          className={`node-handle stacked-handle${handle.active ? " is-handle-active" : ""}`}
          style={{ top: `${handle.top}%` }}
        />
      ))}
      {isCore && data.outputHandles.map(handle => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={Position.Right}
          className={`node-handle stacked-handle${handle.active ? " is-handle-active" : ""}`}
          style={{ top: `${handle.top}%` }}
        />
      ))}
      {isDestination && (
        <Handle id="in" type="target" position={Position.Left} className={`node-handle${data.handleActive || data.active ? " is-handle-active" : ""}`} />
      )}

      <div className="node-header">
        <span>{data.nodeType}</span>
        <span>{data.status}</span>
      </div>

      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>

      <div className="node-meta">
        {data.meta.map(item => (
          <span key={item.label}>
            <strong>{item.value}</strong>
            {item.label}
          </span>
        ))}
      </div>

      {data.footnote && <div className="node-footnote">{data.footnote}</div>}

      {isDestination && data.handingOff && (
        <Handle id="handoff-out" type="source" position={Position.Right} className="node-handle handoff-handle is-handle-active" isConnectable={false} />
      )}

      {isInput && (
        <Handle id="out" type="source" position={Position.Right} className={`node-handle${data.handleActive || data.active ? " is-handle-active" : ""}`} />
      )}
    </div>
  );
}

/*
 * The transient "handing off" node right of a destination, linked
 * by an ordinary edge. Appears and disappears like other nodes.
 */
function HandoffPillNode({ data }) {
  return (
    <div className="handoff-pill" title={`${data.destinationId} is handing an observation back to the core`}>
      <Handle id="in" type="target" position={Position.Left} className="node-handle handoff-handle is-handle-active" isConnectable={false} />
      {data.label}
    </div>
  );
}

const HANDOFF_PILL_HEIGHT = 44;

/*
 * Centre each handoff pill on its destination node so the edge
 * between them is a straight line. Node heights are only known
 * once React Flow has measured them, so this uses the measured
 * sizes from the current nodes.
 */
function alignHandoffPills(nodes, current) {
  const measured = new Map(current.map(node => [node.id, node]));

  return nodes.map(node => {
    if (node.type !== "handoffPill") return node;

    const destination = measured.get(`destination:${node.data.destinationId}`);
    const destinationHeight = destination?.measured?.height;
    if (!destination || !destinationHeight) return node;

    const pillHeight = measured.get(node.id)?.measured?.height ?? HANDOFF_PILL_HEIGHT;

    return {
      ...node,
      position: {
        x: node.position.x,
        y: destination.position.y + destinationHeight / 2 - pillHeight / 2
      }
    };
  });
}

function StatsPage({ events, actualTheme, auth }) {
  const [stats, setStats] = useState(null);
  const [live, setLive] = useState(true);
  const [rangeMs, setRangeMs] = useState(6 * 60 * 60 * 1000);
  const [query, setQuery] = useState("");
  const [chartType, setChartType] = useState("area");
  const [selectedMetrics, setSelectedMetrics] = useState(defaultMetrics);

  const loadStats = useCallback(() => {
    auth.apiFetch("/api/stats")
      .then(response => response.json())
      .then(setStats)
      .catch(() => {});
  }, [auth.apiFetch]);

  useEffect(() => {
    loadStats();
    if (!live) return undefined;

    const interval = setInterval(loadStats, 5000);
    return () => clearInterval(interval);
  }, [events.length, live, loadStats]);

  const counters = stats?.counters ?? {};
  const series = stats?.series ?? [];
  const rangeLabel = statsRanges.find(([value]) => value === rangeMs)?.[1] ?? "custom";
  const cutoff = Date.now() - rangeMs;

  const rangeRows = useMemo(() => {
    return series.filter(row => Date.parse(row.bucket) >= cutoff);
  }, [series, cutoff]);

  const rangeTotals = useMemo(() => sumRowsByMetric(rangeRows), [rangeRows]);
  const availableMetrics = useMemo(() => {
    return [...new Set([...Object.keys(counters), ...series.map(row => row.metric)])].sort();
  }, [counters, series]);
  const filteredMetrics = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return availableMetrics.filter(metric => {
      return !needle
        || metric.toLowerCase().includes(needle)
        || metricLabel(metric).toLowerCase().includes(needle);
    });
  }, [availableMetrics, query]);
  const visibleSelectedMetrics = selectedMetrics.filter(metric => availableMetrics.includes(metric));

  const cards = [
    ["Events", "events.total", "ingested"],
    ["Decisions", "decisions.total", "total"],
    ["Outputs", "outputs.total", "sent"],
    ["Errors", "errors.total", "all sources"],
    ["Polls", "polls.started", "started"],
    ["Observations", "observations.emitted", "emitted"]
  ];
  const completed = rangeTotals["destinations.completed"] ?? 0;
  const failed = rangeTotals["destinations.failed"] ?? 0;
  const rangeEvents = rangeTotals["events.total"] ?? 0;
  const rangeErrors = rangeTotals["errors.total"] ?? 0;
  const rangeMinutes = Math.max(1, rangeMs / 60000);
  const kpis = [
    ["Success rate", completed + failed ? `${Math.round((completed / (completed + failed)) * 100)}%` : "—", "destinations"],
    ["Error rate", rangeEvents ? `${((rangeErrors / rangeEvents) * 100).toFixed(1)}%` : "0%", `in ${rangeLabel}`],
    ["Events/min", (rangeEvents / rangeMinutes).toFixed(rangeEvents >= rangeMinutes ? 1 : 2), `in ${rangeLabel}`]
  ];
  const metricRows = filteredMetrics
    .map(metric => ({
      metric,
      label: metricLabel(metric),
      lifetime: counters[metric] ?? 0,
      range: rangeTotals[metric] ?? 0,
      selected: selectedMetrics.includes(metric)
    }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.range - a.range || b.lifetime - a.lifetime || a.metric.localeCompare(b.metric));

  const toggleMetric = metric => {
    setSelectedMetrics(current => current.includes(metric)
      ? current.filter(value => value !== metric)
      : [...current, metric]
    );
  };

  return (
    <div className="panel-page stats-page">
      <PageHeader title="Stats" subtitle="Live metrics powered by uPlot, derived from the persisted telemetry store." />

      <div className="metrics-toolbar">
        <label className="metric-search">
          <span className="material-symbols-outlined" aria-hidden="true">search</span>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Filter metrics…"
          />
        </label>
        <div className="segmented-control" aria-label="Time range">
          {statsRanges.map(([value, label]) => (
            <button key={value} className={rangeMs === value ? "active" : ""} onClick={() => setRangeMs(value)}>{label}</button>
          ))}
        </div>
        <div className="segmented-control" aria-label="Chart style">
          {[["line", "Line"], ["area", "Area"]].map(([value, label]) => (
            <button key={value} className={chartType === value ? "active" : ""} onClick={() => setChartType(value)}>{label}</button>
          ))}
        </div>
        <button className={`live-toggle${live ? " active" : ""}`} onClick={() => setLive(value => !value)}>
          <span className="live-dot" />
          {live ? "Live" : "Paused"}
        </button>
      </div>

      <div className="stat-grid">
        {cards.map(([label, metric, hint]) => (
          <button className="stat-card metric-card" key={metric} onClick={() => toggleMetric(metric)}>
            <span>{label}</span>
            <strong>{formatMetricValue(counters[metric] ?? 0)}</strong>
            <em>{formatMetricValue(rangeTotals[metric] ?? 0)} in {rangeLabel} · {hint}</em>
          </button>
        ))}
        {kpis.map(([label, value, hint]) => (
          <div className="stat-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <em>{hint}</em>
          </div>
        ))}
      </div>

      <section className="metrics-panel chart-card wide-chart-card">
        <header>
          <div>
            <h3>Time series</h3>
            <span>{visibleSelectedMetrics.length} selected · {rangeLabel} · updated {stats?.generatedAt ? formatTime(stats.generatedAt) : "—"}</span>
          </div>
          <div className="chart-actions">
            <button onClick={() => setSelectedMetrics(defaultMetrics)}>Defaults</button>
            <button onClick={() => setSelectedMetrics(filteredMetrics.slice(0, 8))}>Top visible</button>
            <button onClick={() => setSelectedMetrics([])}>Clear</button>
          </div>
        </header>
        <MetricChips
          metrics={filteredMetrics}
          selectedMetrics={selectedMetrics}
          onToggle={toggleMetric}
        />
        <UplotMetricChart
          rows={rangeRows}
          metrics={visibleSelectedMetrics}
          chartType={chartType}
          rangeMs={rangeMs}
          actualTheme={actualTheme}
        />
      </section>

      <section className="metrics-panel metric-table-card">
        <header>
          <div>
            <h3>Metric breakdown</h3>
            <span>{metricRows.length} metrics{query ? ` matching “${query}”` : ""}</span>
          </div>
        </header>
        <div className="metric-table-wrap">
          <table className="metric-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>{rangeLabel}</th>
                <th>Lifetime</th>
                <th>Chart</th>
              </tr>
            </thead>
            <tbody>
              {metricRows.map(row => (
                <tr key={row.metric}>
                  <td>
                    <strong>{row.label}</strong>
                    <span>{row.metric}</span>
                  </td>
                  <td>{formatMetricValue(row.range)}</td>
                  <td>{formatMetricValue(row.lifetime)}</td>
                  <td>
                    <button className={row.selected ? "selected" : ""} onClick={() => toggleMetric(row.metric)}>
                      {row.selected ? "Shown" : "Show"}
                    </button>
                  </td>
                </tr>
              ))}
              {metricRows.length === 0 && (
                <tr><td colSpan="4" className="empty-cell">No metrics match the current filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MetricChips({ metrics, selectedMetrics, onToggle }) {
  return (
    <div className="metric-chips" aria-label="Metric selection">
      {metrics.map(metric => {
        const selected = selectedMetrics.includes(metric);
        return (
          <button key={metric} className={selected ? "selected" : ""} onClick={() => onToggle(metric)}>
            {metricLabel(metric)}
          </button>
        );
      })}
      {metrics.length === 0 && <span>No metrics available yet.</span>}
    </div>
  );
}

function UplotMetricChart({ rows, metrics, chartType, rangeMs, actualTheme }) {
  const containerRef = useRef(null);
  const plotRef = useRef(null);

  const chartData = useMemo(() => buildChartData(rows, metrics, rangeMs), [rows, metrics, rangeMs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    plotRef.current?.destroy();
    plotRef.current = null;

    const width = Math.max(320, Math.floor(container.clientWidth));
    const height = 330;
    const css = getComputedStyle(document.documentElement);
    const token = name => css.getPropertyValue(name).trim();
    const text = token("--muted");
    const grid = token("--border");
    const bg = token("--panel");
    const data = chartData.data;

    const plot = new uPlot({
      width,
      height,
      padding: [10, 14, 4, 4],
      cursor: {
        drag: { x: true, y: false, setScale: true }
      },
      legend: { show: true, live: true },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          font: '11px "Inter", sans-serif'
        },
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid },
          font: '11px "Inter", sans-serif'
        }
      ],
      series: [
        {},
        ...metrics.map((metric, index) => {
          const color = token(metricColors[index % metricColors.length]);
          return {
            label: metricLabel(metric),
            stroke: color,
            width: 2,
            points: { show: false },
            fill: chartType === "area" ? colorMix(color, bg, 0.18) : undefined
          };
        })
      ]
    }, data, container);

    const resetZoom = () => {
      plot.setScale("x", { min: data[0][0], max: data[0][data[0].length - 1] });
    };
    plot.root.addEventListener("dblclick", resetZoom);
    plotRef.current = plot;

    const observer = new ResizeObserver(() => {
      plot.setSize({ width: Math.max(320, Math.floor(container.clientWidth)), height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      plot.root.removeEventListener("dblclick", resetZoom);
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
  }, [chartData, metrics, chartType, actualTheme]);

  return (
    <div className="uplot-shell">
      <div ref={containerRef} className="uplot-container" />
      {metrics.length === 0 && (
        <div className="chart-empty">Select one or more metrics to draw a chart.</div>
      )}
      {metrics.length > 0 && chartData.empty && (
        <div className="chart-empty">No time-series samples in this range yet.</div>
      )}
      <p className="chart-help">Hover for values, drag horizontally to zoom, double-click to reset.</p>
    </div>
  );
}

function buildChartData(rows, metrics, rangeMs) {
  const end = Date.now();
  const start = end - rangeMs;
  const startSecond = Math.floor(start / 1000);
  const endSecond = Math.floor(end / 1000);
  const buckets = [...new Set(rows.map(row => Math.floor(Date.parse(row.bucket) / 1000)))].sort((a, b) => a - b);
  const x = [...new Set([startSecond, ...buckets, endSecond])].sort((a, b) => a - b);
  const valuesByMetric = new Map(metrics.map(metric => [metric, new Map()]));

  for (const row of rows) {
    if (!valuesByMetric.has(row.metric)) continue;
    valuesByMetric.get(row.metric).set(Math.floor(Date.parse(row.bucket) / 1000), row.value);
  }

  return {
    empty: buckets.length === 0,
    data: [
      x,
      ...metrics.map(metric => {
        const values = valuesByMetric.get(metric) ?? new Map();
        return x.map(bucket => values.get(bucket) ?? 0);
      })
    ]
  };
}

function sumRowsByMetric(rows) {
  return rows.reduce((accumulator, row) => {
    accumulator[row.metric] = (accumulator[row.metric] ?? 0) + row.value;
    return accumulator;
  }, {});
}

function metricLabel(metric) {
  return String(metric)
    .split(".")
    .map(part => part.replace(/-/g, " "))
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
}

function formatMetricValue(value) {
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function colorMix(foreground, background, alpha) {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return foreground;
  const mix = fg.map((channel, index) => Math.round(channel * alpha + bg[index] * (1 - alpha)));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function parseColor(value) {
  const hex = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return hex.slice(1).split("").map(char => parseInt(`${char}${char}`, 16));
  }
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  }
  return null;
}

function SettingsPage({ activeTab, setActiveTab, themePreference, actualTheme, setThemePreference, auth }) {
  const visibleTabs = settingsTabs.filter(tab => !tab.permission || hasPermission(auth.user, tab.permission));
  const effectiveTab = visibleTabs.some(tab => tab.id === activeTab) ? activeTab : "appearance";

  return (
    <div className="panel-page settings-page">
      <PageHeader title="Settings" subtitle="Appearance and runtime configuration for this Brainstem Web UI." />
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          {visibleTabs.map(tab => (
            <button
              key={tab.id}
              className={effectiveTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
        <section className="settings-panel">
          {effectiveTab === "appearance" && (
            <AppearanceSettings
              themePreference={themePreference}
              setThemePreference={setThemePreference}
            />
          )}
          {effectiveTab === "config" && <ConfigSettings actualTheme={actualTheme} auth={auth} />}
          {effectiveTab === "users" && <UsersSettings auth={auth} />}
          {effectiveTab === "roles" && <RolesSettings auth={auth} />}
        </section>
      </div>
    </div>
  );
}

function AppearanceSettings({ themePreference, setThemePreference }) {
  return (
    <div className="settings-section">
      <h2>Appearance</h2>
      <p>Choose how Brainstem should look on this device.</p>
      <div className="theme-options" role="radiogroup" aria-label="Theme">
        {[
          ["system", "System", "desktop_windows"],
          ["dark", "Dark", "dark_mode"],
          ["light", "Light", "light_mode"]
        ].map(([value, label, icon]) => (
          <button
            key={value}
            className={themePreference === value ? "selected" : ""}
            onClick={() => setThemePreference(value)}
            role="radio"
            aria-checked={themePreference === value}
          >
            <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
            <strong>{label}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfigSettings({ actualTheme, auth }) {
  const [config, setConfig] = useState({ path: "", content: "" });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({ type: "info", text: "Loading config…" });

  useEffect(() => {
    auth.apiFetch("/api/config")
      .then(response => response.json().then(body => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error ?? "Failed to load config");
        setConfig(body);
        setDraft(body.content ?? "");
        setNotice({ type: "info", text: `Loaded ${body.path}` });
      })
      .catch(error => setNotice({ type: "error", text: error.message }));
  }, [auth.apiFetch]);

  const save = async () => {
    setSaving(true);
    setNotice({ type: "info", text: "Checking and saving config…" });
    try {
      const response = await auth.apiFetch("/api/config", {
        method: "PUT",
        body: JSON.stringify({ content: draft })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Save failed");
      setConfig({ path: body.path, content: draft });
      setNotice({ type: "success", text: `Saved ${new Date(body.savedAt).toLocaleTimeString()}. Restart Brainstem to reload it.` });
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
    finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section config-page">
      <div className="config-header">
        <div>
          <h2>Configuration</h2>
          <p>{config.path || "brainstem.config.mjs"}</p>
        </div>
        <button
          className="config-save"
          onClick={save}
          disabled={saving || draft === config.content}
        >
          {saving ? "Saving…" : "Save config"}
        </button>
      </div>
      {notice.text && notice.type !== "info" && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}
      <CodeEditor key={actualTheme} value={draft} onChange={setDraft} theme={actualTheme} />
    </div>
  );
}

function UsersSettings({ auth }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [notice, setNotice] = useState({ type: "info", text: "Loading users…" });
  const [draft, setDraft] = useState({ username: "", name: "", password: "", roleIds: [] });

  const load = useCallback(async () => {
    try {
      const [usersBody, rolesBody] = await Promise.all([
        auth.apiFetch("/api/users").then(response => response.json()),
        auth.apiFetch("/api/roles").then(response => response.json())
      ]);
      setUsers(usersBody);
      setRoles(rolesBody.roles ?? []);
      setDraft(current => ({ ...current, roleIds: current.roleIds.length ? current.roleIds : rolesBody.roles?.filter(role => role.name === "Viewer").map(role => role.id) ?? [] }));
      setNotice({ type: "info", text: `${usersBody.length} users` });
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  }, [auth.apiFetch]);

  useEffect(() => { load(); }, [load]);

  const create = async event => {
    event.preventDefault();
    try {
      await auth.apiFetch("/api/users", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ username: "", name: "", password: "", roleIds: draft.roleIds });
      await load();
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  };

  const setUserActive = async (user, active) => {
    try {
      await auth.apiFetch(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          username: user.username,
          name: user.name,
          active,
          roleIds: user.roles.map(role => role.id)
        })
      });
      await load();
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  };

  const deleteUser = async user => {
    if (!window.confirm(`Delete user ${user.username}? This cannot be undone.`)) return;
    try {
      await auth.apiFetch(`/api/users/${user.id}`, { method: "DELETE" });
      await load();
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  };

  const activeUsers = users.filter(user => user.active).length;

  return (
    <div className="settings-section admin-section">
      <div className="admin-header">
        <div>
          <h2>Users</h2>
          <p>Create local accounts and assign roles. Authorization is enforced by the backend.</p>
        </div>
        <div className="admin-summary" aria-label="User summary">
          <span><strong>{users.length}</strong> total</span>
          <span><strong>{activeUsers}</strong> active</span>
        </div>
      </div>
      {notice.text && notice.type !== "info" && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}
      <div className="admin-layout">
        {hasPermission(auth.user, "users:create") && (
          <form className="admin-form admin-create-card" onSubmit={create}>
            <header>
              <div>
                <h3>New user</h3>
                <p>Use a temporary strong password and share it out-of-band.</p>
              </div>
            </header>
            <label>Username<input placeholder="jane.ops" value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} required /></label>
            <label>Name<input placeholder="Jane Ops" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>Password<input placeholder="At least 12 characters" type="password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} minLength="12" required /></label>
            <label>Roles<select multiple value={draft.roleIds} onChange={event => setDraft({ ...draft, roleIds: [...event.target.selectedOptions].map(option => option.value) })}>
              {roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select></label>
            <button type="submit"><span className="material-symbols-outlined" aria-hidden="true">add</span>Create user</button>
          </form>
        )}
        <section className="admin-list-card">
          <header>
            <div>
              <h3>Accounts</h3>
              <p>{users.length === 0 ? "No users yet." : "Current user directory."}</p>
            </div>
          </header>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>User</th><th>Roles</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>{users.map(user => (
                <tr key={user.id}>
                  <td><strong>{user.username}</strong><span>{user.name || "No display name"}</span></td>
                  <td><div className="badge-row">{user.roles.map(role => <span className="role-badge" key={role.id}>{role.name}</span>)}</div></td>
                  <td><span className={user.active ? "status-pill active" : "status-pill"}>{user.active ? "Active" : "Disabled"}</span></td>
                  <td>
                    <div className="row-actions">
                      {hasPermission(auth.user, "users:update") && <button onClick={() => setUserActive(user, !user.active)}>{user.active ? "Disable" : "Enable"}</button>}
                      {hasPermission(auth.user, "users:delete") && <button className="danger" onClick={() => deleteUser(user)}>Delete</button>}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function RolesSettings({ auth }) {
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [notice, setNotice] = useState({ type: "info", text: "Loading roles…" });
  const [draft, setDraft] = useState({ name: "", description: "", permissions: [] });

  const load = useCallback(async () => {
    try {
      const body = await auth.apiFetch("/api/roles").then(response => response.json());
      setRoles(body.roles ?? []);
      setPermissions(body.permissions ?? []);
      setNotice({ type: "info", text: `${body.roles?.length ?? 0} roles` });
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  }, [auth.apiFetch]);

  useEffect(() => { load(); }, [load]);

  const create = async event => {
    event.preventDefault();
    try {
      await auth.apiFetch("/api/roles", { method: "POST", body: JSON.stringify(draft) });
      setDraft({ name: "", description: "", permissions: [] });
      await load();
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  };

  const deleteRole = async role => {
    if (!window.confirm(`Delete role ${role.name}? Users with only this role will lose those permissions.`)) return;
    try {
      await auth.apiFetch(`/api/roles/${role.id}`, { method: "DELETE" });
      await load();
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  };

  return (
    <div className="settings-section admin-section">
      <div className="admin-header">
        <div>
          <h2>Roles</h2>
          <p>Compose permissions into reusable access levels for operators and viewers.</p>
        </div>
        <div className="admin-summary" aria-label="Role summary">
          <span><strong>{roles.length}</strong> roles</span>
          <span><strong>{permissions.length}</strong> permissions</span>
        </div>
      </div>
      {notice.text && notice.type !== "info" && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}
      <div className="admin-layout">
        {hasPermission(auth.user, "roles:manage") && (
          <form className="admin-form admin-create-card" onSubmit={create}>
            <header>
              <div>
                <h3>New role</h3>
                <p>Grant the smallest permission set that still lets people do their work.</p>
              </div>
            </header>
            <label>Role name<input placeholder="Incident responder" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} required /></label>
            <label>Description<input placeholder="Can inspect telemetry and update config" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
            <fieldset className="permission-grid">
              <legend>Permissions</legend>
              {permissions.map(permission => (
                <label key={permission}>
                  <input type="checkbox" checked={draft.permissions.includes(permission)} onChange={event => setDraft({ ...draft, permissions: event.target.checked ? [...draft.permissions, permission] : draft.permissions.filter(value => value !== permission) })} />
                  <span>{formatPermission(permission)}</span>
                  <small>{permission}</small>
                </label>
              ))}
            </fieldset>
            <button type="submit"><span className="material-symbols-outlined" aria-hidden="true">add</span>Create role</button>
          </form>
        )}
        <section className="admin-list-card">
          <header>
            <div>
              <h3>Role library</h3>
              <p>System roles are protected; custom roles can be changed later.</p>
            </div>
          </header>
          <div className="admin-table-wrap">
            <table className="admin-table roles-table">
              <thead><tr><th>Role</th><th>Permissions</th><th>Type</th><th>Actions</th></tr></thead>
              <tbody>{roles.map(role => <tr key={role.id}><td><strong>{role.name}</strong><span>{role.description || "No description"}</span></td><td><div className="permission-chips">{role.permissions.map(permission => <span key={permission}>{permission}</span>)}</div></td><td><span className={role.system ? "status-pill" : "status-pill active"}>{role.system ? "System" : "Custom"}</span></td><td><div className="row-actions">{hasPermission(auth.user, "roles:manage") && (role.system ? <button disabled title="Built-in roles are protected">Locked</button> : <button className="danger" onClick={() => deleteRole(role)}>Delete</button>)}</div></td></tr>)}</tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatPermission(permission) {
  return permission.split(":").map(part => part.replace(/-/g, " ")).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" · ");
}

function CodeEditor({ value, onChange, theme }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        javascript({ jsx: true }),
        theme === "light" ? lightEditorTheme : oneDark,
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          onChangeRef.current(update.state.doc.toString());
        })
      ]
    });

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const current = view.state.doc.toString();
    if (current === value) return;

    view.dispatch({
      changes: {
        from: 0,
        to: current.length,
        insert: value
      }
    });
  }, [value]);

  return <div className="code-editor" ref={containerRef} />;
}

const deliveryStatusFilters = [
  ["", "All"],
  ["failed", "Retrying"],
  ["dead", "Dead"],
  ["pending", "Pending"],
  ["delivered", "Delivered"],
  ["discarded", "Discarded"]
];

/*
 * Delivery pipeline: queue depth, the delivery log and the
 * dead-letter queue with redrive / discard.
 */
function DeliveriesPage({ auth }) {
  const [summary, setSummary] = useState(null);
  const [deadJobs, setDeadJobs] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const canControl = hasPermission(auth.user, "runtime:control");

  const load = useCallback(async () => {
    try {
      const query = status ? `?status=${encodeURIComponent(status)}&limit=200` : "?limit=200";
      const [summaryBody, deadBody, deliveriesBody] = await Promise.all([
        auth.apiFetch("/api/pipeline").then(response => response.json()),
        auth.apiFetch("/api/jobs?state=dead&limit=200").then(response => response.json()),
        auth.apiFetch(`/api/deliveries${query}`).then(response => response.json())
      ]);
      setSummary(summaryBody);
      setDeadJobs(deadBody);
      setDeliveries(deliveriesBody);
      setSelected(current => new Set([...current].filter(id => deadBody.some(job => job.id === id))));
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  }, [auth.apiFetch, status]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (action, ids) => {
    if (ids.length === 0) return;
    if (action === "discard" && !window.confirm(`Discard ${ids.length} dead job(s)? They will not be retried.`)) return;

    setBusy(true);
    try {
      const body = await auth.apiFetch(`/api/jobs/${action}`, {
        method: "POST",
        body: JSON.stringify({ ids })
      }).then(response => response.json());
      const done = body.redriven ?? body.discarded ?? [];
      setNotice({
        type: "success",
        text: action === "redrive"
          ? `Redrove ${done.length} job(s); they run on the next queue poll.`
          : `Discarded ${done.length} job(s).`
      });
      setSelected(new Set());
      await load();
    }
    catch (error) {
      setNotice({ type: "error", text: error.message });
    }
    finally {
      setBusy(false);
    }
  };

  const toggle = id => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const queueCounts = queue => Object.fromEntries(
    (summary?.jobs ?? []).filter(row => row.queue === queue).map(row => [row.state, row.count])
  );

  return (
    <div className="panel-page deliveries-page">
      <PageHeader title="Deliveries" subtitle="The durable decide → deliver pipeline: queued jobs, the delivery log, and dead jobs to redrive." />

      {notice && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}

      <div className="pipeline-summary">
        {["decide", "deliver"].map(queue => {
          const counts = queueCounts(queue);
          return (
            <section className="admin-list-card pipeline-queue" key={queue}>
              <header><div><h3>{queue === "decide" ? "Decide queue" : "Deliver queue"}</h3><p>{queue === "decide" ? "Observations waiting for a decision." : "Decisions waiting for a destination."}</p></div></header>
              <div className="admin-summary">
                <span><strong>{counts.ready ?? 0}</strong> queued</span>
                <span><strong>{counts.running ?? 0}</strong> running</span>
                <span className={counts.dead ? "pill-danger" : ""}><strong>{counts.dead ?? 0}</strong> dead</span>
              </div>
            </section>
          );
        })}
        <section className="admin-list-card pipeline-queue">
          <header><div><h3>Delivery log</h3><p>Finished deliveries are pruned after the retention window.</p></div></header>
          <div className="admin-summary">
            {["delivered", "failed", "dead"].map(key => (
              <span key={key} className={key === "dead" && summary?.deliveries?.dead ? "pill-danger" : ""}><strong>{summary?.deliveries?.[key] ?? 0}</strong> {key === "failed" ? "retrying" : key}</span>
            ))}
          </div>
        </section>
      </div>

      <section className="admin-list-card">
        <header>
          <div>
            <h3>Dead jobs</h3>
            <p>{deadJobs.length === 0 ? "Nothing is stuck. Jobs land here after their last retry fails." : "Out of retries. Fix the cause, then redrive them, or discard them."}</p>
          </div>
          {canControl && deadJobs.length > 0 && (
            <div className="row-actions">
              <button disabled={busy || selected.size === 0} onClick={() => act("redrive", [...selected])}>Redrive selected</button>
              <button disabled={busy} onClick={() => act("redrive", deadJobs.map(job => job.id))}>Redrive all</button>
              <button className="danger" disabled={busy || selected.size === 0} onClick={() => act("discard", [...selected])}>Discard selected</button>
            </div>
          )}
        </header>
        {deadJobs.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr>{canControl && <th aria-label="Select" />}<th>Job</th><th>Attempts</th><th>Last error</th><th>Updated</th>{canControl && <th>Actions</th>}</tr></thead>
              <tbody>{deadJobs.map(job => (
                <tr key={job.id}>
                  {canControl && <td><input type="checkbox" aria-label={`Select job ${job.id}`} checked={selected.has(job.id)} onChange={() => toggle(job.id)} /></td>}
                  <td><strong>{job.queue} #{job.id}</strong><span>{jobLabel(job)}</span></td>
                  <td>{job.attempts}/{job.maxAttempts}</td>
                  <td className="error-cell">{job.lastError ?? "—"}</td>
                  <td>{formatDateTime(job.updatedAt)}</td>
                  {canControl && (
                    <td><div className="row-actions">
                      <button disabled={busy} onClick={() => act("redrive", [job.id])}>Redrive</button>
                      <button className="danger" disabled={busy} onClick={() => act("discard", [job.id])}>Discard</button>
                    </div></td>
                  )}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-list-card">
        <header>
          <div>
            <h3>Delivery log</h3>
            <p>One row per decision and destination. The key is the idempotency key the destination receives.</p>
          </div>
          <label className="inline-select">Status
            <select value={status} onChange={event => setStatus(event.target.value)}>
              {deliveryStatusFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </header>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Observation</th><th>Destination</th><th>Decision</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Updated</th></tr></thead>
            <tbody>
              {deliveries.length === 0 && <tr><td colSpan="7">No deliveries{status ? ` with status ${status}` : ""}.</td></tr>}
              {deliveries.map(delivery => (
                <tr key={delivery.key}>
                  <td><strong>{delivery.observationId}</strong><span title={delivery.key}>rev {delivery.revision}</span></td>
                  <td>{delivery.destination}<span className="cell-muted">{delivery.plugin}</span></td>
                  <td>{delivery.decision}</td>
                  <td><span className={`status-pill delivery-${delivery.status}`}>{delivery.status === "failed" ? "retrying" : delivery.status}</span></td>
                  <td>{delivery.attempts}</td>
                  <td className="error-cell">{delivery.lastError ?? "—"}</td>
                  <td>{formatDateTime(delivery.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function jobLabel(job) {
  if (job.queue === "deliver") return job.payload?.key ?? "";
  if (job.queue === "decide") return job.payload?.observation?.payload?.id ?? "";
  return job.jobKey ?? "";
}

function PageHeader({ title, subtitle }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

function pageFromPath(pathname) {
  if (pathname === "/stats") return "stats";
  if (pathname === "/deliveries") return "deliveries";
  if (pathname === "/config" || pathname.startsWith("/settings")) return "settings";
  return "flow";
}

function settingsTabFromPath(pathname) {
  if (pathname === "/settings/config" || pathname === "/config") return "config";
  return "appearance";
}

function pathForPage(pageId, settingsTab = "appearance") {
  if (pageId === "stats") return "/stats";
  if (pageId === "deliveries") return "/deliveries";
  if (pageId === "settings") return pathForSettingsTab(settingsTab);
  return "/";
}

function pathForSettingsTab(tabId) {
  return tabId === "config" ? "/settings/config" : "/settings/appearance";
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

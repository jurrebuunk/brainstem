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
import {
  buildGraph,
  eventNodeIds
} from "./events.js";
import NodeInspector from "./components/NodeInspector.jsx";

const nodeTypes = {
  brainstemNode: BrainstemNode
};

const pages = [
  { id: "flow", label: "Flow", icon: "schema", permission: "dashboard:read" },
  { id: "stats", label: "Stats", icon: "query_stats", permission: "stats:read" },
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
  const graph = useMemo(() => {
    try {
      return buildGraph(events, clock);
    }
    catch (error) {
      console.error("Failed to build flow graph", error);
      return { nodes: [], edges: [], error };
    }
  }, [events, clock]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes(graph.nodes);
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
    setSelectedNode(node);
  }, []);

  const nodeEvents = useMemo(() => {
    if (!selectedNode) {
      return [];
    }

    return events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => eventNodeIds(event).includes(selectedNode.id))
      .reverse();
  }, [events, selectedNode]);

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
            graphError={graph.error}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onInit={setFlowInstance}
          />
        )}
        {page === "stats" && <StatsPage events={events} actualTheme={actualTheme} auth={auth} />}
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
          onClose={() => setSelectedNode(null)}
        />
      )}
    </main>
  );
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

function FlowPage({ nodes, edges, graphError, onNodesChange, onEdgesChange, onNodeClick, onInit }) {
  const [interactive, setInteractive] = useState(false);

  return (
    <div className="flow-page">
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

      {isInput && (
        <Handle id="out" type="source" position={Position.Right} className={`node-handle${data.handleActive || data.active ? " is-handle-active" : ""}`} />
      )}
    </div>
  );
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
  if (pathname === "/config" || pathname.startsWith("/settings")) return "settings";
  return "flow";
}

function settingsTabFromPath(pathname) {
  if (pathname === "/settings/config" || pathname === "/config") return "config";
  return "appearance";
}

function pathForPage(pageId, settingsTab = "appearance") {
  if (pageId === "stats") return "/stats";
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

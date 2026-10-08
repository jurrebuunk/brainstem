import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import {
  buildGraph,
  eventId,
  eventLevel,
  eventNodeIds,
  eventSummary,
  eventTimestamp,
  eventTitle
} from "./events.js";

const nodeTypes = {
  brainstemNode: BrainstemNode
};

const edgeTypes = {
  siphon: SiphonEdge
};

const pages = [
  { id: "flow", label: "Flow", icon: "schema" },
  { id: "stats", label: "Stats", icon: "query_stats" },
  { id: "config", label: "Config", icon: "settings" }
];

export default function App() {
  const [events, setEvents] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [page, setPageState] = useState(pageFromPath(window.location.pathname));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("brainstem-sidebar-width"));
    return Number.isFinite(stored) && stored >= 160 ? stored : 220;
  });
  const graph = useMemo(() => buildGraph(events, clock), [events, clock]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setEdges, setNodes]);

  useEffect(() => {
    const onPopState = () => {
      setPageState(pageFromPath(window.location.pathname));
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const setPage = useCallback(pageId => {
    setPageState(pageId);
    const path = pathForPage(pageId);
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
    fetch("/api/events")
      .then(response => response.json())
      .then(setEvents)
      .catch(() => {});

    const source = new EventSource("/api/stream");

    source.onmessage = message => {
      const event = JSON.parse(message.data);

      if (event.kind === "web.connected") {
        return;
      }

      setEvents(current => [
        ...current.slice(-1999),
        event
      ]);
    };

    return () => source.close();
  }, []);

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
      />

      <section className="page">
        {page === "flow" && (
          <FlowPage
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
          />
        )}
        {page === "stats" && <StatsPage events={events} />}
        {page === "config" && <ConfigPage />}
      </section>

      {selectedNode && page === "flow" && (
        <NodeModal
          node={selectedNode}
          events={nodeEvents}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </main>
  );
}

function Sidebar({ page, setPage, collapsed, setCollapsed, width, setWidth }) {
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
      <button className="sidebar-toggle" onClick={() => setCollapsed(!collapsed)}>
        <span className="material-symbols-outlined" aria-hidden="true">
          {collapsed ? "chevron_right" : "chevron_left"}
        </span>
      </button>
      <div className="sidebar-brand">
        <span className="brand-mark">B</span>
        {!collapsed && <span>Brainstem</span>}
      </div>
      <nav className="sidebar-nav">
        {pages.map(item => (
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
      {!collapsed && <div className="sidebar-resizer" onPointerDown={startResize} title="Resize sidebar" />}
    </aside>
  );
}

function FlowPage({ nodes, edges, onNodesChange, onEdgesChange, onNodeClick }) {
  return (
    <div className="flow-page">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        nodesFocusable={false}
        deleteKeyCode={null}
        fitView
        minZoom={0.25}
        maxZoom={1.4}
      >
        <Background color="#343a40" gap={22} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function SiphonEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style }) {
  const direction = targetX >= sourceX ? 1 : -1;
  const gap = Math.abs(targetX - sourceX);
  const elbowOffset = Math.min(Math.max(gap * 0.46, 70), 230);
  const elbowX = sourceX + direction * elbowOffset;
  const path = `M ${sourceX},${sourceY} H ${elbowX} V ${targetY} H ${targetX}`;

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
    />
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
          className="node-handle stacked-handle"
          style={{ top: `${handle.top}%` }}
        />
      ))}
      {isCore && data.outputHandles.map(handle => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={Position.Right}
          className="node-handle stacked-handle"
          style={{ top: `${handle.top}%` }}
        />
      ))}
      {isDestination && (
        <Handle id="in" type="target" position={Position.Left} className="node-handle" />
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
        <Handle id="out" type="source" position={Position.Right} className="node-handle" />
      )}
    </div>
  );
}

function StatsPage({ events }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      fetch("/api/stats")
        .then(response => response.json())
        .then(value => {
          if (!cancelled) setStats(value);
        })
        .catch(() => {});
    };

    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [events.length]);

  const counters = stats?.counters ?? {};
  const cards = [
    ["Polls", counters["polls.started"] ?? 0, "started"],
    ["Decisions", counters["decisions.total"] ?? 0, "total"],
    ["Outputs", counters["outputs.total"] ?? 0, "sent"],
    ["Destination errors", counters["destinations.failed"] ?? 0, "failed"],
    ["Plugin errors", counters["plugin.errors"] ?? 0, "logged"],
    ["Events", counters["events.total"] ?? 0, "ingested"]
  ];

  return (
    <div className="panel-page stats-page">
      <PageHeader title="Stats" subtitle="Persistent web stats, stored in data/web-stats.sqlite." />
      <div className="stat-grid">
        {cards.map(([label, value, hint]) => (
          <div className="stat-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <em>{hint}</em>
          </div>
        ))}
      </div>
      <div className="chart-grid">
        <MiniChart title="Polls" metric="polls.started" stats={stats} color="#38bdf8" />
        <MiniChart title="Decisions" metric="decisions.total" stats={stats} color="#a78bfa" />
        <MiniChart title="Destination failures" metric="destinations.failed" stats={stats} color="#fb7185" />
        <MiniChart title="Outputs" metric="outputs.total" stats={stats} color="#34d399" />
      </div>
    </div>
  );
}

function MiniChart({ title, metric, stats, color }) {
  const points = useMemo(() => {
    const rows = stats?.series?.filter(row => row.metric === metric) ?? [];
    return rows.slice(-36).map(row => row.value);
  }, [stats, metric]);
  const max = Math.max(...points, 1);

  return (
    <section className="chart-card">
      <header>
        <h3>{title}</h3>
        <span>{points.reduce((sum, value) => sum + value, 0)} / 6h</span>
      </header>
      <div className="bars">
        {(points.length ? points : [0]).map((value, index) => (
          <span
            key={`${index}-${value}`}
            style={{ height: `${Math.max(4, (value / max) * 100)}%`, background: color }}
            title={`${value}`}
          />
        ))}
      </div>
    </section>
  );
}

function ConfigPage() {
  const [config, setConfig] = useState({ path: "", content: "" });
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Loading config…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then(response => response.json())
      .then(value => {
        setConfig(value);
        setDraft(value.content ?? "");
        setStatus("Loaded");
      })
      .catch(error => setStatus(error.message));
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus("Checking and saving…");
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Save failed");
      setConfig({ path: body.path, content: draft });
      setStatus(`Saved ${new Date(body.savedAt).toLocaleTimeString()}`);
    }
    catch (error) {
      setStatus(error.message);
    }
    finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel-page config-page">
      <PageHeader title="Configuration" subtitle={config.path || "brainstem.config.mjs"} />
      <div className="config-toolbar">
        <span className={draft === config.content ? "clean" : "dirty"}>
          {draft === config.content ? "No changes" : "Unsaved changes"}
        </span>
        <button onClick={save} disabled={saving || draft === config.content}>Save config</button>
      </div>
      <CodeEditor value={draft} onChange={setDraft} />
      <div className="config-status">{status}</div>
    </div>
  );
}

function CodeEditor({ value, onChange }) {
  return (
    <div className="code-editor">
      <pre aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightJs(value) || " " }} />
      <textarea
        spellCheck="false"
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}

function PageHeader({ title, subtitle }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

function NodeModal({ node, events, onClose }) {
  const [selectedEventId, setSelectedEventId] = useState(null);
  const selectedEvent = useMemo(() => {
    return events.find(({ event, index }) =>
      eventId(event, index) === selectedEventId
    ) ?? events[0] ?? null;
  }, [events, selectedEventId]);

  useEffect(() => {
    setSelectedEventId(null);
  }, [node.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal" onClick={event => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>{node.data.label}</h2>
            <p>{node.data.subtitle}</p>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </header>

        <div className="modal-body">
          <div className="log-table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Event</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {events.map(({ event, index }) => {
                  const id = eventId(event, index);
                  const active = selectedEvent && eventId(selectedEvent.event, selectedEvent.index) === id;

                  return (
                    <tr
                      key={id}
                      className={active ? "selected" : ""}
                      onClick={() => setSelectedEventId(id)}
                    >
                      <td>{formatTime(eventTimestamp(event))}</td>
                      <td><span className={`level level-${eventLevel(event)}`}>{eventLevel(event)}</span></td>
                      <td>{eventTitle(event)}</td>
                      <td>{eventSummary(event)}</td>
                    </tr>
                  );
                })}

                {events.length === 0 && (
                  <tr>
                    <td colSpan="4" className="empty-cell">No events for this node yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <aside className="event-detail">
            <h3>Event details</h3>
            {selectedEvent ? (
              <pre>{JSON.stringify(selectedEvent.event, null, 2)}</pre>
            ) : (
              <div className="empty-detail">Select a log line.</div>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}

function highlightJs(value) {
  return escapeHtml(value)
    .replace(/(\/\/.*)$/gm, "<span class=\"tok-comment\">$1</span>")
    .replace(/(\b(?:export|default|const|let|var|return|true|false|null|async|await|import|from)\b)/g, "<span class=\"tok-keyword\">$1</span>")
    .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, "<span class=\"tok-string\">$1</span>")
    .replace(/(\b\d+(?:\.\d+)?\b)/g, "<span class=\"tok-number\">$1</span>");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pageFromPath(pathname) {
  if (pathname === "/stats") return "stats";
  if (pathname === "/config") return "config";
  return "flow";
}

function pathForPage(pageId) {
  if (pageId === "stats") return "/stats";
  if (pageId === "config") return "/config";
  return "/";
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

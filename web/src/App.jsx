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
  { id: "flow", label: "Flow", icon: "schema" },
  { id: "stats", label: "Stats", icon: "query_stats" },
  { id: "settings", label: "Settings", icon: "settings" }
];

const settingsTabs = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "config", label: "Config", icon: "code" }
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
            graphError={graph.error}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onInit={setFlowInstance}
          />
        )}
        {page === "stats" && <StatsPage events={events} actualTheme={actualTheme} />}
        {page === "settings" && (
          <SettingsPage
            activeTab={settingsTab}
            setActiveTab={setSettingsTab}
            themePreference={themePreference}
            actualTheme={actualTheme}
            setThemePreference={setThemePreference}
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

function StatsPage({ events, actualTheme }) {
  const [stats, setStats] = useState(null);
  const [live, setLive] = useState(true);
  const [rangeMs, setRangeMs] = useState(6 * 60 * 60 * 1000);
  const [query, setQuery] = useState("");
  const [chartType, setChartType] = useState("area");
  const [selectedMetrics, setSelectedMetrics] = useState(defaultMetrics);

  const loadStats = useCallback(() => {
    fetch("/api/stats")
      .then(response => response.json())
      .then(setStats)
      .catch(() => {});
  }, []);

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

function SettingsPage({ activeTab, setActiveTab, themePreference, actualTheme, setThemePreference }) {
  return (
    <div className="panel-page settings-page">
      <PageHeader title="Settings" subtitle="Appearance and runtime configuration for this Brainstem Web UI." />
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          {settingsTabs.map(tab => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
        <section className="settings-panel">
          {activeTab === "appearance" && (
            <AppearanceSettings
              themePreference={themePreference}
              setThemePreference={setThemePreference}
            />
          )}
          {activeTab === "config" && <ConfigSettings actualTheme={actualTheme} />}
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

function ConfigSettings({ actualTheme }) {
  const [config, setConfig] = useState({ path: "", content: "" });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({ type: "info", text: "Loading config…" });

  useEffect(() => {
    fetch("/api/config")
      .then(response => response.json().then(body => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error ?? "Failed to load config");
        setConfig(body);
        setDraft(body.content ?? "");
        setNotice({ type: "info", text: `Loaded ${body.path}` });
      })
      .catch(error => setNotice({ type: "error", text: error.message }));
  }, []);

  const save = async () => {
    setSaving(true);
    setNotice({ type: "info", text: "Checking and saving config…" });
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
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
      {notice.text && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}
      <CodeEditor key={actualTheme} value={draft} onChange={setDraft} theme={actualTheme} />
    </div>
  );
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

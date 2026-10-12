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
        <NodeModal
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

function NodeModal({ node, events, allEvents, onClose }) {
  const indexedEvents = useMemo(() => allEvents.map((event, index) => ({ event, index })), [allEvents]);
  const fallbackEvents = useMemo(() => events.map(({ event, index }) => ({
    id: eventId(event, index),
    timestamp: eventTimestamp(event),
    title: eventTitle(event),
    subtitle: eventSummary(event),
    badge: eventLevel(event),
    status: eventLevel(event),
    leftTitle: "Event envelope",
    leftSubtitle: "Raw telemetry received by the Web UI",
    leftBlocks: [{ type: "json", title: event.kind, value: event }],
    rightTitle: "Payload",
    rightSubtitle: "Normalized payload for this event",
    rightBlocks: [{ type: "json", title: "payload", value: event.payload ?? {} }]
  })), [events]);
  const records = useMemo(() => {
    const built = buildInspectorRecords(node, indexedEvents);
    return built.length > 0 ? built : fallbackEvents;
  }, [node, indexedEvents, fallbackEvents]);
  const mode = inspectorMode(node);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const selectedRecord = useMemo(() => {
    return records.find(record => record.id === selectedRecordId) ?? records[0] ?? null;
  }, [records, selectedRecordId]);

  useEffect(() => {
    setSelectedRecordId(null);
  }, [node.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal node-inspector" onClick={event => event.stopPropagation()}>
        <header className="modal-header node-inspector-header">
          <div>
            <h2>{node.data.label}</h2>
            <p>{node.data.subtitle}</p>
          </div>
          <div className="node-inspector-summary" aria-label="Inspector summary">
            <span>{mode.label}</span>
            <strong>{records.length}</strong>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close node inspector">×</button>
        </header>

        <div className="node-inspector-body">
          <aside className="run-list" aria-label={mode.listLabel}>
            <div className="run-list-heading">
              <h3>{mode.listLabel}</h3>
              <p>{mode.listHint}</p>
            </div>
            <div className="run-list-items">
              {records.map(record => (
                <button
                  key={record.id}
                  className={`run-list-item${selectedRecord?.id === record.id ? " selected" : ""}`}
                  onClick={() => setSelectedRecordId(record.id)}
                >
                  <span className="run-list-time">{formatDateTime(record.timestamp)}</span>
                  <strong>{record.title}</strong>
                  <em>{record.subtitle}</em>
                  <span className="run-list-meta">
                    <span className={`level level-${record.status ?? "event"}`}>{record.badge ?? record.status ?? "event"}</span>
                  </span>
                </button>
              ))}
              {records.length === 0 && (
                <div className="empty-detail">No inspectable activity for this node yet.</div>
              )}
            </div>
          </aside>

          <section className="run-detail" aria-live="polite">
            {selectedRecord ? (
              <>
                <header className="run-detail-header">
                  <div>
                    <h3>{selectedRecord.title}</h3>
                    <p>{selectedRecord.subtitle}</p>
                  </div>
                </header>
                <div className="io-grid">
                  <InspectorPane
                    title={selectedRecord.leftTitle}
                    subtitle={selectedRecord.leftSubtitle}
                    blocks={selectedRecord.leftBlocks}
                  />
                  <InspectorPane
                    title={selectedRecord.rightTitle}
                    subtitle={selectedRecord.rightSubtitle}
                    blocks={selectedRecord.rightBlocks}
                  />
                </div>
              </>
            ) : (
              <div className="empty-detail">Select an item to inspect its input and output.</div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function InspectorPane({ title, subtitle, blocks }) {
  return (
    <article className="io-pane">
      <header>
        <h4>{title}</h4>
        {subtitle && <p>{subtitle}</p>}
      </header>
      <div className="io-pane-body">
        {blocks.map((block, index) => (
          <InspectorBlock block={block} key={`${block.type}-${block.title ?? index}-${index}`} />
        ))}
      </div>
    </article>
  );
}

function InspectorBlock({ block }) {
  if (block.type === "timeline") {
    return <TimelineBlock title={block.title} items={block.items} empty={block.empty} />;
  }

  if (block.type === "summary") {
    return (
      <div className="io-summary-block">
        {block.items.map(item => (
          <span key={item.label}>
            <strong>{item.value}</strong>
            {item.label}
          </span>
        ))}
      </div>
    );
  }

  return (
    <section className="json-block">
      {block.title && <h5>{block.title}</h5>}
      {block.value == null ? (
        <div className="empty-detail compact">No envelope captured for this side yet.</div>
      ) : (
        <pre>{JSON.stringify(block.value, null, 2)}</pre>
      )}
    </section>
  );
}

function TimelineBlock({ title, items, empty }) {
  return (
    <section className="timeline-block">
      {title && <h5>{title}</h5>}
      <div className="timeline-list">
        {items.map(({ event, index }) => (
          <details className="timeline-item" key={eventId(event, index)}>
            <summary>
              <span>{formatTime(eventTimestamp(event))}</span>
              <strong>{eventTitle(event)}</strong>
              <em className={`level level-${eventLevel(event)}`}>{eventLevel(event)}</em>
              <small>{eventSummary(event)}</small>
            </summary>
            <pre>{JSON.stringify(event, null, 2)}</pre>
          </details>
        ))}
        {items.length === 0 && <div className="empty-detail compact">{empty ?? "No related activity captured."}</div>}
      </div>
    </section>
  );
}

function inspectorMode(node) {
  if (node.id === "core") {
    return {
      label: "Core I/O",
      listLabel: "Decisions",
      listHint: "Each item shows the observation entering the core and the decision envelope leaving it."
    };
  }

  if (node.id.startsWith("destination:")) {
    return {
      label: "Destination I/O",
      listLabel: "Received envelopes",
      listHint: "Select a delivered decision to see the input envelope and destination-scoped activity."
    };
  }

  return {
    label: "Input polling",
    listLabel: "Polls",
    listHint: "Select a poll to inspect plugin activity and emitted observation envelopes."
  };
}

function buildInspectorRecords(node, items) {
  if (node.id === "core") return buildCoreRecords(items);
  if (node.id.startsWith("destination:")) return buildDestinationRecords(node, items);
  if (node.id.startsWith("input:")) return buildInputRecords(node, items);
  return [];
}

function buildCoreRecords(items) {
  return items
    .filter(({ event }) => event.kind === "brainstem.core.decision")
    .map(item => {
      const payload = item.event.payload ?? {};
      const observationId = payload.observationId ?? payload.observation?.payload?.id;
      const decision = payload.decision?.payload?.decision ?? payload.decision ?? "unknown";
      const related = relatedByObservationOrPoll(items, {
        observationId,
        pollId: payload.pollId,
        includeKinds: new Set(["brainstem.input.observation", "brainstem.core.decision", "brainstem.output"])
      });

      return {
        id: eventId(item.event, item.index),
        timestamp: eventTimestamp(item.event),
        title: observationId ? `Observation ${observationId}` : "Core decision",
        subtitle: `${payload.source ?? payload.observation?.payload?.source?.type ?? "source"} · ${payload.type ?? payload.observation?.payload?.type ?? "observation"} → ${decision}`,
        badge: decision,
        status: decision === "ignore" ? "event" : "output",
        count: related.length,
        leftTitle: "Input envelope",
        leftSubtitle: "Observation received by Brainstem Core",
        leftBlocks: [
          { type: "summary", items: compactSummaryItems([
            ["Observation", observationId],
            ["Poll", payload.pollId],
            ["Input", payload.inputId]
          ]) },
          { type: "json", title: "observation", value: payload.observation ?? findObservationEnvelope(items, observationId) }
        ],
        rightTitle: "Output envelope",
        rightSubtitle: "Decision emitted by the core",
        rightBlocks: [
          { type: "summary", items: compactSummaryItems([
            ["Decision", decision],
            ["Route", payload.route ?? payload.decision?.payload?.route],
            ["State", payload.state]
          ]) },
          { type: "json", title: "decision", value: payload.decision ?? item.event },
          { type: "timeline", title: "Related I/O", items: related }
        ]
      };
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function buildDestinationRecords(node, items) {
  const destinationKey = node.id.slice("destination:".length);
  const records = new Map();
  const relevant = items.filter(item => {
    return destinationMatches(item.event, destinationKey) && (
      item.event.kind.startsWith("brainstem.destination.") ||
      item.event.kind === "brainstem.output"
    );
  });

  for (const item of relevant) {
    const payload = item.event.payload ?? {};
    const observationId = observationIdForEvent(item.event);
    const pollId = pollIdForEvent(item.event);
    const key = observationId ?? pollId ?? eventId(item.event, item.index);
    const current = records.get(key) ?? {
      id: `destination-${destinationKey}-${key}`,
      destinationKey,
      observationId,
      pollId,
      events: [],
      output: null,
      inputEnvelope: null,
      latestAt: eventTimestamp(item.event),
      status: "event"
    };

    current.events.push(item);
    current.latestAt = latestTimestamp(current.latestAt, eventTimestamp(item.event));
    current.status = destinationStatus(current.status, item.event);
    current.output = item.event.kind === "brainstem.output" ? item.event : current.output;
    current.inputEnvelope = current.inputEnvelope ?? destinationInputEnvelope(payload, item.event);
    records.set(key, current);
  }

  return [...records.values()].map(record => {
    const activity = items.filter(item => destinationMatches(item.event, record.destinationKey) && sameRun(item.event, record));
    const titleId = record.observationId ?? record.pollId ?? "delivery";

    return {
      id: record.id,
      timestamp: record.latestAt,
      title: `Received ${titleId}`,
      subtitle: `${node.data.label}.${node.data.subtitle ?? "default"}`,
      badge: record.status,
      status: record.status,
      count: activity.length,
      leftTitle: "Input envelope",
      leftSubtitle: "Decision and observation delivered to this destination",
      leftBlocks: [
        { type: "summary", items: compactSummaryItems([
          ["Observation", record.observationId],
          ["Poll", record.pollId],
          ["Destination", record.destinationKey]
        ]) },
        { type: "json", title: "received", value: record.inputEnvelope }
      ],
      rightTitle: "Destination activity",
      rightSubtitle: "Logs and output tied to the selected received envelope",
      rightBlocks: [
        { type: "timeline", title: "Scoped activity", items: activity, empty: "No destination logs matched this envelope." },
        { type: "json", title: "output envelope", value: record.output }
      ]
    };
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function buildInputRecords(node, items) {
  const inputId = node.id.slice("input:".length);
  const pollEvents = items.filter(({ event }) => inputEventMatches(event, inputId));
  const records = new Map();

  for (const item of pollEvents) {
    const pollId = pollIdForEvent(item.event);
    if (!pollId) continue;
    const current = records.get(pollId) ?? {
      id: `poll-${inputId}-${pollId}`,
      pollId,
      inputId,
      events: [],
      observations: [],
      startedAt: null,
      completedAt: null,
      latestAt: eventTimestamp(item.event),
      status: "running"
    };

    current.events.push(item);
    current.latestAt = latestTimestamp(current.latestAt, eventTimestamp(item.event));
    if (item.event.kind === "brainstem.input.poll.started") current.startedAt = eventTimestamp(item.event);
    if (item.event.kind === "brainstem.input.poll.completed") {
      current.completedAt = eventTimestamp(item.event);
      current.status = "output";
    }
    if (item.event.kind === "brainstem.input.observation") current.observations.push(item.event.payload?.observation ?? item.event);
    records.set(pollId, current);
  }

  const inputLogs = items.filter(({ event }) => inputLogMatches(event, inputId));
  for (const item of inputLogs) {
    const pollId = pollIdForEvent(item.event) ?? findPollForTimestamp([...records.values()], eventTimestamp(item.event));
    if (!pollId || !records.has(pollId)) continue;
    const record = records.get(pollId);
    record.events.push(item);
    record.latestAt = latestTimestamp(record.latestAt, eventTimestamp(item.event));
    if (eventLevel(item.event) === "error") record.status = "error";
  }

  return [...records.values()].map(record => {
    const sortedActivity = [...record.events].sort((a, b) => Date.parse(eventTimestamp(a.event)) - Date.parse(eventTimestamp(b.event)));

    return {
      id: record.id,
      timestamp: record.startedAt ?? record.latestAt,
      title: `Poll ${record.inputId}`,
      subtitle: `${record.observations.length} observation${record.observations.length === 1 ? "" : "s"} emitted`,
      badge: record.status === "output" ? "completed" : record.status,
      status: record.status,
      count: sortedActivity.length,
      leftTitle: "Poll activity",
      leftSubtitle: "Lifecycle and plugin logs for the selected poll",
      leftBlocks: [
        { type: "summary", items: compactSummaryItems([
          ["Input", record.inputId],
          ["Started", record.startedAt ? formatTime(record.startedAt) : null],
          ["Completed", record.completedAt ? formatTime(record.completedAt) : null]
        ]) },
        { type: "timeline", title: "Poll logs", items: sortedActivity }
      ],
      rightTitle: "Output envelopes",
      rightSubtitle: "Observation envelopes emitted by this poll",
      rightBlocks: record.observations.length > 0
        ? record.observations.map((observation, index) => ({ type: "json", title: `observation ${index + 1}`, value: observation }))
        : [{ type: "json", title: "observation", value: null }]
    };
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function compactSummaryItems(entries) {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => ({ label, value }));
}

function observationIdForEvent(event) {
  const payload = event.payload ?? {};
  return payload.observationId
    ?? payload.observation?.payload?.id
    ?? payload.observationEnvelope?.payload?.id
    ?? payload.fields?.observationId
    ?? payload.fields?.observation_id
    ?? payload.decisionEnvelope?.payload?.observation_id
    ?? payload.decision?.payload?.observation_id;
}

function pollIdForEvent(event) {
  const payload = event.payload ?? {};
  return payload.pollId ?? payload.fields?.pollId ?? payload.fields?.poll_id ?? null;
}

function findObservationEnvelope(items, observationId) {
  if (!observationId) return null;
  return items.find(({ event }) => event.kind === "brainstem.input.observation" && event.payload?.observation?.payload?.id === observationId)?.event.payload?.observation ?? null;
}

function relatedByObservationOrPoll(items, { observationId, pollId, includeKinds }) {
  return items.filter(({ event }) => {
    if (includeKinds && !includeKinds.has(event.kind)) return false;
    const eventObservationId = observationIdForEvent(event);
    const eventPollId = pollIdForEvent(event);
    return Boolean(
      (observationId && eventObservationId === observationId) ||
      (pollId && eventPollId === pollId)
    );
  });
}

function destinationMatches(event, destinationKey) {
  const payload = event.payload ?? {};
  const eventDestination = event.kind === "brainstem.output"
    ? `${payload.destination?.plugin}:${payload.destination?.name}`
    : payload.plugin && payload.destination
      ? `${payload.plugin}:${payload.destination}`
      : null;

  return eventDestination === destinationKey;
}

function destinationInputEnvelope(payload, event) {
  if (event.kind === "brainstem.output") {
    return {
      pollId: payload.pollId ?? null,
      input: payload.input ?? null,
      destination: payload.destination ?? null,
      decision: payload.decision ?? null,
      observation: payload.observation ?? null
    };
  }

  return {
    pollId: payload.pollId ?? null,
    decision: payload.decisionEnvelope ?? payload.decision ?? null,
    observation: payload.observationEnvelope ?? payload.observation ?? null
  };
}

function destinationStatus(current, event) {
  if (event.kind === "brainstem.destination.failed" || eventLevel(event) === "error") return "error";
  if (current === "error") return current;
  if (event.kind === "brainstem.destination.completed" || event.kind === "brainstem.output") return "output";
  if (event.kind === "brainstem.destination.running") return "event";
  return current;
}

function sameRun(event, record) {
  const eventObservationId = observationIdForEvent(event);
  const eventPollId = pollIdForEvent(event);
  return Boolean(
    (record.observationId && eventObservationId === record.observationId) ||
    (record.pollId && eventPollId === record.pollId) ||
    (!record.observationId && !record.pollId && destinationMatches(event, record.destinationKey))
  );
}

function inputEventMatches(event, inputId) {
  const payload = event.payload ?? {};
  return (
    ["brainstem.input.poll.started", "brainstem.input.poll.completed", "brainstem.input.observation"].includes(event.kind) && payload.id === inputId
  );
}

function inputLogMatches(event, inputId) {
  const payload = event.payload ?? {};
  return event.kind === "brainstem.plugin.log" && payload.scope === "input" && payload.id === inputId;
}

function findPollForTimestamp(records, timestamp) {
  const value = Date.parse(timestamp);
  const match = records.find(record => {
    const start = record.startedAt ? Date.parse(record.startedAt) : -Infinity;
    const end = record.completedAt ? Date.parse(record.completedAt) : Date.parse(record.latestAt) + 1000;
    return value >= start && value <= end;
  });

  return match?.pollId ?? null;
}

function latestTimestamp(a, b) {
  return Date.parse(a) >= Date.parse(b) ? a : b;
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

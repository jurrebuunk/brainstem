import React, { useCallback, useEffect, useMemo, useState } from "react";
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

export default function App() {
  const [events, setEvents] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const graph = useMemo(() => buildGraph(events), [events]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setEdges, setNodes]);

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
    <main className="app">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        minZoom={0.35}
        maxZoom={1.4}
      >
        <Background color="#343a40" gap={22} size={1} />
        <Controls />
      </ReactFlow>

      {selectedNode && (
        <NodeModal
          node={selectedNode}
          events={nodeEvents}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </main>
  );
}

function BrainstemNode({ data }) {
  const isInput = data.nodeType === "input";
  const isCore = data.nodeType === "core";
  const isDestination = data.nodeType === "destination";

  return (
    <div className={`node-card node-${data.nodeType}${data.active ? " is-active" : ""}`}>
      {(isCore || isDestination) && (
        <Handle type="target" position={Position.Left} className="node-handle" />
      )}

      <div className="node-topline">
        <span className="node-type">{data.nodeType}</span>
        <span className="node-state">{data.active ? "live" : "idle"}</span>
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

      {(isInput || isCore) && (
        <Handle type="source" position={Position.Right} className="node-handle" />
      )}
    </div>
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

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

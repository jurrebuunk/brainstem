import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import {
  buildGraph,
  eventId,
  eventLabel,
  eventNodeIds,
  eventTimestamp
} from "./events.js";

const nodeTypes = {
  input: NodeCard,
  core: NodeCard,
  destination: NodeCard
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
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background />
        <MiniMap />
        <Controls />
      </ReactFlow>

      {selectedNode && (
        <NodePanel
          node={selectedNode}
          events={nodeEvents}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </main>
  );
}

function NodeCard({ data }) {
  return (
    <div className={`node-card node-card-${data.type}${data.active ? " node-card-active" : ""}`}>
      <div className="node-type">{data.type}</div>
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>
    </div>
  );
}

function NodePanel({ node, events, onClose }) {
  const [expanded, setExpanded] = useState(null);

  return (
    <aside className="panel">
      <button className="panel-close" onClick={onClose}>×</button>
      <h2>{node.data.label}</h2>
      <p>{node.data.subtitle}</p>

      <div className="event-list">
        {events.length === 0 && (
          <div className="empty">No events for this node yet.</div>
        )}

        {events.map(({ event, index }) => {
          const id = eventId(event, index);
          const open = expanded === id;

          return (
            <article className="event" key={id}>
              <button
                className="event-summary"
                onClick={() => setExpanded(open ? null : id)}
              >
                <span className={`kind ${kindClass(event.kind)}`}>{event.kind}</span>
                <span className="label">{eventLabel(event)}</span>
                <time>{eventTimestamp(event)}</time>
              </button>

              {open && (
                <pre>{JSON.stringify(event, null, 2)}</pre>
              )}
            </article>
          );
        })}
      </div>
    </aside>
  );
}

function kindClass(kind) {
  return kind.replace(/[^a-z0-9]/gi, "-").toLowerCase();
}

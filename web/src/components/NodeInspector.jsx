import React, { useEffect, useMemo, useState } from "react";
import {
  eventId,
  eventLevel,
  eventSummary,
  eventTimestamp,
  eventTitle
} from "../events.js";
import { buildInspectorRecords, inspectorMode } from "../telemetry/inspector-records.js";

export default function NodeInspector({ node, events, allEvents, onClose }) {
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

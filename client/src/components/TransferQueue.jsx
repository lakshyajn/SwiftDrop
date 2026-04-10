export default function TransferQueue({ outgoing, active, completed, fmtSize, fileIcon, onCancel }) {
  // FIX: Filter out duplicates. If it's "sending", it's in 'active'. If it's "done", it's in 'completed'.
  const displayOutgoing = outgoing?.filter(o => o.status !== "sending" && o.status !== "done") || [];

  if (!displayOutgoing.length && !active?.length && !completed?.length) return null;

  return (
    <div className="transfer-queue">

      {/* ── Active transfers ─────────────────────────────────────── */}
      {active?.map(([transferId, t]) => (
        <div key={transferId} className={`transfer-item active ${t.phase === "corrupt" ? "corrupt" : ""}`}>
          <div className="transfer-row">
            <span className="transfer-icon">{fileIcon(t.fileInfo?.name)}</span>
            <div className="transfer-info">
              <div className="transfer-name">{t.fileInfo?.name}</div>
              <div className="transfer-meta">
                {t.direction === "sending" ? "↑ Sending to " + t.peerName : "↓ Receiving from " + t.peerName}
                {" · "}{Number(t.speed || 0).toFixed(1)} Mbps
                {t.eta && t.eta !== "--:--" && <span className="transfer-eta"> · ETA {t.eta}</span>}
                {t.phase && t.phase !== "transferring" && (
                  <span className={`transfer-phase ${t.phase}`}>
                    {" · "}
                    {{
                      connecting: "🔗 Connecting",
                      flushing:   "⏳ Flushing…",
                      verifying:  "🔒 Verifying…",
                      corrupt:    "❌ Corrupted!",
                      stalled:    "🚨 Stalled",
                    }[t.phase] || t.phase}
                  </span>
                )}
              </div>
            </div>
            <div className="transfer-pct">
              {t.phase === "corrupt" ? "❌" : `${Number(t.progress || 0).toFixed(0)}%`}
            </div>
          </div>
          <div className="transfer-bar">
            <div
              className={`transfer-fill ${t.phase === "corrupt" ? "corrupt" : ""} ${t.phase === "verifying" ? "verifying" : ""}`}
              style={{ width: `${t.progress || 0}%` }}
            />
          </div>
        </div>
      ))}

      {/* ── Outgoing queue (Pending / Queued / Rejected) ───────── */}
      {displayOutgoing.map(item => (
        <div key={item.transferId} className={`transfer-item outgoing ${item.status}`}>
          <div className="transfer-row">
            <span className="transfer-icon">{fileIcon(item.fileInfo?.name)}</span>
            <div className="transfer-info">
              <div className="transfer-name">{item.fileInfo?.name}</div>
              <div className="transfer-meta">
                → {item.toName} ·{" "}
                {{
                  pending:     "⏳ Waiting for acceptance",
                  queued:      "📋 Queued — will send automatically",
                  accepted:    "✅ Accepted",
                  connecting:  "🔗 Connecting…",
                  rejected:    "❌ Rejected",
                  busy:        "📋 Queued",
                  stalled:     "🚨 Stalled — retrying…",
                  denied:      `🚫 ${item.reason || "Not allowed by host"}`,
                }[item.status] || item.status}
                {item.eta && item.eta !== "--:--" && <span className="transfer-eta"> · ETA {item.eta}</span>}
              </div>
            </div>
            {(item.status === "pending" || item.status === "queued" || item.status === "accepted") && onCancel && (
              <button className="cancel-btn" onClick={() => onCancel(item.transferId, item.to)}>✕</button>
            )}
          </div>
        </div>
      ))}

      {/* ── Completed ────────────────────────────────────────────── */}
      {completed?.slice(0, 5).map(c => (
        <div key={c.transferId} className="transfer-item completed">
          <div className="transfer-row">
            <span className="transfer-icon">{fileIcon(c.fileInfo?.name)}</span>
            <div className="transfer-info">
              <div className="transfer-name">{c.fileInfo?.name}</div>
              <div className="transfer-meta">
                {c.direction === "sending" ? `↑ Sent to ${c.peerName}` : `↓ Received from ${c.peerName}`}
                {" · "}{c.avgSpeed} Mbps · {c.duration?.toFixed(1)}s
                <span className="transfer-verified"> · ✅ Verified</span>
              </div>
            </div>
          </div>
        </div>
      ))}

    </div>
  );
}
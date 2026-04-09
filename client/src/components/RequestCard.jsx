// ─── RequestCard ──────────────────────────────────────────────────────────────
import { useState, useEffect } from "react";

export function RequestCard({ request, onAccept, onReject, fmtSize, fileIcon }) {
  const [seconds, setSeconds] = useState(30);

  const safeFileIcon = typeof fileIcon === "function"
    ? fileIcon
    : () => "📄";

  const safeFmtSize = typeof fmtSize === "function"
    ? fmtSize
    : (b) => b + " B";

  useEffect(() => {
    const t = setInterval(() => setSeconds(s => {
      if (s <= 1) { clearInterval(t); onReject(); return 0; }
      return s - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [request.transferId]);

  return (
    <div className="request-card">
      <div className="request-file-row">
        <span className="request-file-icon">{safeFileIcon(request.fileInfo?.name)}</span>
        <div className="request-file-info">
          <div className="request-file-name">{request.fileInfo.name}</div>
          <div className="request-file-meta">
            {safeFmtSize(request.fileInfo?.size) || 0} · from <strong>{request.fromName}</strong>
            {request.isBroadcast && <span className="broadcast-tag">📡 Broadcast</span>}
          </div>
        </div>
        <div className="request-timer">{seconds}s</div>
      </div>
      <div className="request-timer-bar">
        <div className="request-timer-fill" style={{ width: `${(seconds / 30) * 100}%` }} />
      </div>
      <div className="request-actions">
        <button className="btn-accept" onClick={onAccept}>✓ Accept</button>
        <button className="btn-reject" onClick={onReject}>✕ Reject</button>
      </div>
    </div>
  );
}

export default RequestCard;

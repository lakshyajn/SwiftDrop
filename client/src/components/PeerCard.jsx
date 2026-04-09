export default function PeerCard({ peer, selected, onClick, onKick, activeTransfer }) {
  return (
    <div
      className={`peer-card ${selected ? "selected" : ""} ${peer.busy ? "busy" : ""}`}
      onClick={onClick}
    >
      <div className="peer-icon">
        {peer.device === "phone" ? "📱" : "💻"}
      </div>
      <div className="peer-info">
        <div className="peer-name">{peer.name}</div>
        <div className="peer-status">
          {peer.busy
            ? activeTransfer
              ? `${activeTransfer.direction === "sending" ? "↑" : "↓"} ${Number(activeTransfer?.progress || 0).toFixed(0)}%`
              : "Busy"
            : "Ready"
          }
        </div>
        {activeTransfer && (
          <div className="peer-progress-bar">
            <div className="peer-progress-fill" style={{ width: `${activeTransfer.progress}%` }} />
          </div>
        )}
      </div>
      <div className="peer-actions" onClick={e => e.stopPropagation()}>
        <button className="peer-kick" title="Kick" onClick={onKick}>🚫</button>
      </div>
    </div>
  );
}

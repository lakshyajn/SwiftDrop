import { create } from "zustand";

export const useStore = create((set, get) => ({
  theme:           "dark",
  role:            null,
  roomId:          null,
  myName:          "",
  myDevice:        "laptop",
  serverInfo:      null,
  isHost:          false,
  pendingRoom:     null,
  sessionEndedMsg: null,
  leaveStatus:     null,       // "pending" | "denied"
  pendingHostCreate: null,     // { roomId, name, device } — waiting for host-create-approved
  hostCreateError:   null,     // string — shown in create-room UI on failure/denial

  roomSettings: {
    allowGuestToGuest:      false,
    allowGuestToHost:       true,
    allowGuestLeave:        true,
    requireLeaveApproval:   false,
    allowLateJoin:          true,
    broadcastToLateJoiners: false,
    maxGuests:              100,
  },

  peers:       [],
  hostId:      null,
  leaveRequests: [], // [{ peerId, name }] — host sees these
  hostCreateRequests: [], // [{ requestId, name, ip, roomId, requestedAt }]

  incomingRequests: [],
  activeTransfers:  {},
  completedTransfers: [],
  outgoingQueue:    [],

  setServerInfo:   (info)     => set({ serverInfo: info }),
  setTheme:        (theme)    => set({ theme }),
  setRole:         (role)     => set({ role, isHost: role === "host" }),
  setSession:      (s)        => set(s),
  setPeers:        (peers)    => set({ peers }),
  setRoomSettings: (settings) => set({ roomSettings: settings }),

  addLeaveRequest: (req) => set(s => ({
    leaveRequests: [...s.leaveRequests.filter(r => r.peerId !== req.peerId), req],
  })),
  removeLeaveRequest: (peerId) => set(s => ({
    leaveRequests: s.leaveRequests.filter(r => r.peerId !== peerId),
  })),

  addHostCreateRequest: (req) => set(s => ({
    hostCreateRequests: [...s.hostCreateRequests.filter(r => r.requestId !== req.requestId), req],
  })),
  removeHostCreateRequest: (requestId) => set(s => ({
    hostCreateRequests: s.hostCreateRequests.filter(r => r.requestId !== requestId),
  })),

  addIncomingRequest: (req) => set(s => ({
    incomingRequests: [...s.incomingRequests, req],
  })),
  removeIncomingRequest: (transferId) => set(s => ({
    incomingRequests: s.incomingRequests.filter(r => r.transferId !== transferId),
  })),

  addOutgoing: (item) => set(s => ({ outgoingQueue: [...s.outgoingQueue, item] })),
  updateOutgoing: (transferId, patch) => set(s => ({
    outgoingQueue: s.outgoingQueue.map(o =>
      o.transferId === transferId ? { ...o, ...patch } : o),
  })),
  removeOutgoing: (transferId) => set(s => ({
    outgoingQueue: s.outgoingQueue.filter(o => o.transferId !== transferId),
  })),

  startActiveTransfer: (transferId, info) => set(s => ({
    activeTransfers: { ...s.activeTransfers, [transferId]: { ...info, progress: 0, speed: 0, startTime: Date.now() } },
  })),
  updateTransferProgress: (transferId, patch) => set(s => {
    const t = s.activeTransfers[transferId];
    if (!t) return {};
    return { activeTransfers: { ...s.activeTransfers, [transferId]: { ...t, ...patch } } };
  }),
  completeTransfer: (transferId) => set(s => {
    const t = s.activeTransfers[transferId];
    if (!t) return {};
    const duration = (Date.now() - t.startTime) / 1000;
    const next = { ...s.activeTransfers };
    delete next[transferId];
    return {
      activeTransfers: next,
      completedTransfers: [
        { transferId, peerName: t.peerName, fileInfo: t.fileInfo, direction: t.direction, duration, avgSpeed: t.speed },
        ...s.completedTransfers,
      ].slice(0, 10),
    };
  }),
  removeActiveTransfer: (transferId) => set(s => {
    const next = { ...s.activeTransfers };
    delete next[transferId];
    return { activeTransfers: next };
  }),

  reset: () => set({
    role: null, roomId: null, isHost: false, pendingRoom: null,
    sessionEndedMsg: null, leaveStatus: null,
    pendingHostCreate: null, hostCreateError: null,
    peers: [], hostId: null, leaveRequests: [], hostCreateRequests: [],
    incomingRequests: [], activeTransfers: {},
    completedTransfers: [], outgoingQueue: [],
    roomSettings: {
      allowGuestToGuest: false, allowGuestToHost: true,
      allowGuestLeave: true, requireLeaveApproval: false,
      allowLateJoin: true, broadcastToLateJoiners: false,
      maxGuests: 100,
    },
  }),
}));
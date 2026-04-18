# SwiftDrop Troubleshooting

## App Does Not Open
- Verify installer architecture matches OS (x64 vs arm).
- On Windows, run as standard user first; only use admin if policy requires.
- Check endpoint security quarantine logs.

## Cannot Discover/Join Host
- Confirm both devices are on same LAN.
- Verify host machine firewall allows app traffic on port 3001.
- Ensure VPN is disabled (or configured to allow local subnet access).

## Transfers Stuck or Slow
- Confirm large file transfers are not blocked by antivirus deep inspection.
- Check CPU/memory pressure on host and guest devices.
- Validate no packet shaping or QoS throttling on the LAN.
- Retry after reconnecting both peers.

## Broadcast Not Completing for Some Peers
- Check whether late joiners are expected to receive current broadcast.
- Confirm target peers remain connected until receiver-side completion.
- Review host logs for stall-recovery/watchdog events.

## Host Approval Flow Issues
- If first host disconnects, wait up to 30s for failover grace window.
- Retry host creation after grace period.
- Ensure at least one connected host remains for election.

## Wrong LAN Address Selected
- SwiftDrop now selects IP from default gateway interface first.
- If incorrect address is still chosen, check routing table priority.
- Temporarily disable unused virtual interfaces (VPN/VM adapters).

## TURN Relay Not Available
- Ensure `node-turn` dependency is present in packaged build.
- Verify UDP/TCP 3478 availability.
- If TURN fails, direct LAN P2P may still work in many cases.

## Collecting Diagnostics
- Start app from terminal to capture logs.
- Record:
  - OS version
  - Installer version
  - Host IP and subnet
  - Time of failure
  - Reproducible steps

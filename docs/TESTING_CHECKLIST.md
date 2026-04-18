# SwiftDrop Testing & Validation Checklist

## Pre-Deployment
- [ ] Fresh install on Windows machine succeeds
- [ ] Fresh install on macOS machine succeeds
- [ ] Fresh install on Linux machine succeeds
- [ ] App launches without Node.js installed globally

## Core Functional Tests
- [ ] Host can create room
- [ ] Guest can join room
- [ ] Host can approve/reject room creation requests
- [ ] Direct guest-to-host transfer works
- [ ] Direct guest-to-guest transfer respects room settings
- [ ] Host broadcast reaches all active guests
- [ ] Transfer progress and completion states update correctly

## Reliability Tests
- [ ] Interrupt network during transfer, verify recovery path
- [ ] Disconnect approver host, verify failover/election
- [ ] Rejoin after temporary disconnect works
- [ ] Session end clears all peer state cleanly
- [ ] Stalled broadcast queue recovers automatically

## Performance Tests
- [ ] Small files (<10MB) transfer quickly
- [ ] Medium files (100MB-1GB) transfer reliably
- [ ] Large files (1GB+) complete without corruption
- [ ] Broadcast to 10+ peers remains stable

## Integrity Tests
- [ ] CRC validation passes for transferred files
- [ ] Corrupted transfer is detected and rejected
- [ ] Retries succeed after transient failures

## Security & Policy
- [ ] App works on isolated LAN without internet
- [ ] Firewall rules documented and tested
- [ ] Endpoint security does not block binaries

## Sign-off
- [ ] Pilot group sign-off
- [ ] IT admin sign-off
- [ ] Production rollout approved

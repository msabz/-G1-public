# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-18

## Read first
Latest dated checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_LIVE_LAN_PHASE5_SEAMS_COMPLETE.md`

## Current verified implementation state
- Phase 5 pre-live LAN seams are implemented.
- Seam code head: `56f5dde32ac0a98a408a0bcd4d9867d20b5e0b43`.
- CI run #75 (`32098204508`) is fully green on that seam code head.
- PR #7 is the preparation PR. `src/App.js` is intentionally untouched by it.
- `main` was still `fb992f83abcf951c8ac70789a765e79623a08d83` immediately before the final documentation checkpoint was created.

## Resume procedure
1. Inspect current GitHub `main`, PR #7 state and the latest Actions run. Do not assume the merge happened merely because this file exists on a feature branch.
2. If PR #7/final docs checkpoint is fully green and `main` is still the recorded base, fast-forward `main` non-force to the exact tested checkpoint head and verify the PR closes as merged.
3. After the merge, create `agent/live-lan-app-wiring-phase5b` from the merged `main`.
4. Execute the App wiring instructions in the latest dated checkpoint. Do not add more architectural seams before using the existing ones.
5. Preserve current P2P live ownership during the outbound LAN wiring step.
6. After outbound known-LAN is CI-green, address incoming-LAN promotion/reciprocal identity separately.

## Progress metric
G1-before-I2P: **39%** before the seam package merge. Raise only on a real verified milestone.

## Goal constraint
Finish and device-verify G1 P0/P1 reliability before implementing I2P. I2P is a future independent transport/overlay, not a prerequisite chain and not an IP-address identity.

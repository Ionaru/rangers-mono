# Discord roles are the source of truth for rank/role/badge; TeamSpeak is synced one-way from them

A member's rank, roles, and badges are represented as Discord roles and managed in Discord. The platform reads Discord roles and reconciles TeamSpeak server-groups to match. Sync is one-way: Discord to TeamSpeak. The platform holds no independent authoritative roster; it stores identity links and a role-to-group mapping, and may cache role state for display.

## Why

Discord is already the identity hub (see ADR 0001) and where admins actually manage people. Making it the role master avoids a second **source of truth** (and the two-masters bug where two authoritative stores disagree), requires no change to how the unit already assigns roles (you promote someone by giving them a Discord role), and means role assignment needs no platform UI at all. This decision is about *authority*, not about where any buttons live: the platform-only admin concerns it leaves (the role-to-group mapping, identity-link exceptions, running the sync) are handled without a web admin panel, see ADR 0009. The abandoned rangers-site tried to make its own DB the master and never finished the outward sync; this avoids that trap.

## Considered and rejected

- **Platform DB is the roster master.** Cleaner reporting, but adds a second source of truth to keep reconciled (and a role-assignment UI) for ~100 people. Rejected as disproportionate.
- **TeamSpeak groups are the truth.** The legacy leaned on TS heavily, but TS is the worst admin surface and has no account. Rejected.

## Consequences

- Demotions propagate: removing a Discord role removes the mapped TeamSpeak group on the next sync (this fixes the legacy's add-only bug, where demotions never propagated).
- The sync only ever touches TeamSpeak groups it owns via the mapping. Groups outside the mapping always persist untouched: TS **Server Admin**, Server Query, channel groups, and any one-off manual grant are invisible to the sync (the rangers-site `teamspeak.service.ts` three-way reconciliation, reused). The reconcile computes the owned set as the union of all `ts_sgid`s in the Assignable mapping and only ever adds/removes within that set.
- Because we avoid the Discord gateway (see the bot architecture decision), role state is read by periodic REST polling of guild members, not real-time gateway events. Sync is therefore eventually-consistent with a few minutes of latency, not instant.

# Op attendance is measured from TeamSpeak Operations-channel presence

The platform records attendance by sampling membership of the single TeamSpeak Operations channel during the op window (Saturday 20:00-23:00 Europe/Amsterdam), over the ServerQuery connection it already holds for role sync. Samples are reconstructed into presence sessions per TeamSpeak identity, resolved to Members, and a Member is credited if their total in-window presence is at least 60 minutes. There is **no Arma server integration.**

## Why

Voice is on TeamSpeak (it is the unit's primary comms), and during an op there is no reason to sit in the Operations channel unless you are playing (in-game squad radio runs over ACRE2, so members stay in the one channel rather than splitting into sub-channels). Channel presence is therefore a faithful attendance proxy. This approach:

- reuses the ServerQuery connection the worker already holds, so it adds almost no moving parts;
- needs zero Arma-side code, no RPT log parsing, no Windows-to-container file bridge, and does not depend on BattlEye;
- keys attendance on the TeamSpeak identity, which members already link, so Steam is not needed for attendance;
- is exactly what the abandoned rangers-site did (`record-operation-attendees.task`: a Saturday cron sampling `getClientsInChannel(RANGERS_TS_OPERATIONS_CHANNEL)` every 15 minutes and diffing), which the unit ran successfully. Supersedes ADR 0004.

## Attendance is a statistic, nothing more

Nothing acts on attendance. It gates no promotion, triggers no removal, and feeds no decision. It appears on a member's own profile and in a read-only site view, and that is the whole of it. The design is sized accordingly: this is decoration, not a system of record.

## Considered and rejected

- **Mission-side SQF logger + RPT tail (ADR 0004).** Gave true in-game presence and SteamID64s, but at the cost of Arma-side code in every mission and brittle log plumbing on Windows. Rejected as disproportionate once TS presence proved sufficient.
- **Counting a channel subtree.** Only needed if ops split into TeamSpeak sub-channels; they don't (ACRE2 handles squad comms), so we sample the single Operations channel. If that ever changes, widen to the parent channel plus descendants.

## Consequences

- Attendance credit depends on members being in the one Operations channel and on their TeamSpeak identity being linked.
- Unlinked TeamSpeak identities present during an op are recorded as guest sessions. When that identity is later linked to a member, its guest sessions auto-backfill to them, so nobody loses credit for attending before linking. An admin-gated slash command can claim a guest session directly (ADR 0009); there is no admin web UI.
- The unit's ask for attendance counting is satisfied via TeamSpeak presence rather than a direct connection to the Arma server.
- Sampling cadence is 90 seconds (cheap over the existing connection), finer than the legacy's 15 minutes, giving tighter join/leave reconstruction.
- **Historical attendance is not imported. Attendance starts from zero.** The legacy used the same mechanism, so the data is nominally comparable, but importing it is not worth it and would make the new numbers worse, not better:
  - it is a statistic nobody acts on, so there is nothing to be gained by having history for it;
  - the legacy recorder's last write was 2024-07-27, it has been dead for two years, and the unit did not notice;
  - 113 of the 401 legacy operations have zero samples;
  - the legacy `operation` table has no date column at all, so the ops cannot even be placed in time;
  - 90 of the 188 TeamSpeak attendees in the dump resolve to no member;
  - the legacy's 15-minute sample resolution does not match the new 90-second cadence, so mixing them would quietly mix two precisions in one column.
- Because attendance drives nothing, there is no live test environment, and infrastructure is out of scope (the deliverable is a `docker-compose.yml`, not the box it runs on), nobody will notice quickly if the sampler silently stops working. The legacy proved exactly that: it died in July 2024 and nothing surfaced it. This is accepted deliberately. The cost of guarding a decorative statistic exceeds the cost of it being wrong.

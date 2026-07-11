# Op attendance is measured from TeamSpeak Operations-channel presence

The platform records attendance by sampling membership of the single TeamSpeak Operations channel during the op window (Saturday 20:00-23:00 Europe/Amsterdam), over the ServerQuery connection it already holds for role sync. Samples are reconstructed into presence sessions per TeamSpeak identity, resolved to Members, and a Member is credited if their total in-window presence is at least 60 minutes. There is **no Arma server integration.**

## Why

Voice is on TeamSpeak (it is the unit's primary comms), and during an op there is no reason to sit in the Operations channel unless you are playing (in-game squad radio runs over ACRE2, so members stay in the one channel rather than splitting into sub-channels). Channel presence is therefore a faithful attendance proxy. This approach:

- reuses the ServerQuery connection the worker already holds, so it adds almost no moving parts;
- needs zero Arma-side code, no RPT log parsing, no Windows-to-container file bridge, and does not depend on BattlEye;
- keys attendance on the TeamSpeak identity, which members already link, so Steam is not needed for attendance;
- is exactly what the abandoned rangers-site did (`record-operation-attendees.task`: a Saturday cron sampling `getClientsInChannel(RANGERS_TS_OPERATIONS_CHANNEL)` every 15 minutes and diffing), which the unit ran successfully. Supersedes ADR 0004.

## Considered and rejected

- **Mission-side SQF logger + RPT tail (ADR 0004).** Gave true in-game presence and SteamID64s, but at the cost of Arma-side code in every mission and brittle log plumbing on Windows. Rejected as disproportionate once TS presence proved sufficient.
- **Counting a channel subtree.** Only needed if ops split into TeamSpeak sub-channels; they don't (ACRE2 handles squad comms), so we sample the single Operations channel. If that ever changes, widen to the parent channel plus descendants.

## Consequences

- Attendance credit depends on members being in the one Operations channel and on their TeamSpeak identity being linked; unlinked TS identities present during an op are surfaced as guests to be claimed.
- Because the legacy used the same mechanism, historical attendance is comparable and can be imported from the old database.
- Requirement #4 ("a connection with our Arma server so we can count attendance") is satisfied via TeamSpeak presence rather than a direct Arma connection.
- Sampling cadence is ~1-2 minutes (cheap over the existing connection), finer than the legacy's 15 minutes, giving tighter join/leave reconstruction.

# Op attendance via a mission-side SQF logger

**Status: superseded by [ADR 0007](0007-attendance-via-teamspeak-presence.md).**

This decision was reversed during design and is kept only for history.

It assumed attendance had to come from in-game presence on the Arma server. Because 7R runs BattlEye off (so no RCon), the plan was a server-side handler in the 7R Framework that logged each player's SteamID64 to the RPT, tailed by a collector. It worked on paper but carried the entire fragile half of the system: an Arma-side code change in every mission, RPT log parsing, a Windows-to-container filesystem bridge, and rotation handling.

We replaced it with TeamSpeak Operations-channel presence (ADR 0007), which the unit already trusted (the legacy rangers-site used exactly this), reuses the ServerQuery connection we hold anyway, and needs no Arma-side code at all. As a result the platform has **no direct Arma server integration**; the Steam link survives only for roster/vetting, not attendance.

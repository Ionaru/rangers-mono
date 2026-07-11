# 7R Platform

The software platform for the 7th Ranger Group ("7R"), an Arma 3 milsim unit. It provides the public website (info, handbook, briefing generator), a Discord bot, and background services that keep roles in sync across Discord and TeamSpeak and record op attendance from TeamSpeak presence.

## Language

**Member**:
One human in the unit. The single person-record that all external identities hang off. A Member always has a Discord identity (that is how they log in and are recognised); TeamSpeak and Steam are linked onto it.
_Avoid_: User, Account, Person.

**Discord identity**:
A Member's Discord account, identified by the Discord user snowflake (stored as a string). This is the **hub identity**: the site's only login, and the source of truth for roles.
_Avoid_: Discord user, DiscordUser.

**TeamSpeak link**:
A Member's TeamSpeak identity (its client UID). One current link per member, self-service replaceable. Proven by a possession challenge (the pick-from-list + poked-code flow). This link is load-bearing: it drives role sync and it is how op attendance is credited to a person.
_Avoid_: TS user, TeamSpeak account.

**Steam link**:
A Member's Steam account (its SteamID64), proven by Steam OpenID login. Exactly one per member. Used for **roster completeness and vetting** (a verified Arma identity on the profile, and proof a member really owns the account); it is not used for attendance.
_Avoid_: Steam user.

**Assignable**:
A grantable thing a Member can hold: a **Rank**, a **Role** (a job/qualification such as Medic or Pilot), or a **Badge** (an achievement). Each is represented as a Discord role and mapped to an optional TeamSpeak server-group. Discord is authoritative (see ADR 0002).
_Avoid_: Permission, grant, tag.

**Rank**:
A Member's standing on the unit ladder: Recruit, Member, NCO, Officer. A kind of Assignable.
_Avoid_: Level, grade.

**TeamSpeak server-group**:
A group on the TeamSpeak server (identified by its `sgid`) that the platform assigns to a linked TeamSpeak identity to mirror a Member's Discord roles. The platform only touches server-groups it owns via the Assignable mapping; everything else (Server Admin, Server Query, channel groups) is left untouched.
_Avoid_: TS role, TS rank.

**Operation** (Op):
A single scheduled 7R mission. The recurring one is Saturday, official mission time 20:00-23:00 Europe/Amsterdam, with the Discord event window running to 23:30 to cover overtime and debrief. An Operation is anchored to a Discord scheduled event (the bot auto-creates both together).
_Avoid_: Event (unqualified), mission (which is the in-game scenario), game night.

**Operations channel**:
The single TeamSpeak channel where members sit during an op (in-game squad comms run over ACRE2, so members stay in this one channel). Presence in it during the op window is what attendance is measured from.
_Avoid_: Op channel, voice channel.

**Attendance session**:
One continuous span a Member (resolved by their TeamSpeak identity) was present in the Operations channel during an Operation, with a join and leave time, reconstructed from periodic presence samples. A Member is credited for an op if their total in-window presence is at least 60 minutes.
_Avoid_: Presence, sample (a sample is one poll; a session is the reconstructed span).

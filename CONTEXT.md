# 7R Platform

The software platform for the 7th Ranger Group ("7R"), an Arma 3 milsim unit. It provides the public website (info, handbook, briefing generator), a Discord bot, a background service that mirrors a Member's Discord roles onto their TeamSpeak server-groups, and an attendance statistic derived from TeamSpeak presence during ops.

## Language

**Member**:
One human in the unit. The single person-record that all external identities hang off. A Member always has a Discord identity (that is how they log in and are recognised); TeamSpeak and Steam are linked onto it.
_Avoid_: User, Account, Person.

**Discord identity**:
A Member's Discord account, identified by the Discord user snowflake (stored as a string). This is the **hub identity**: the site's only login, and the source of truth for roles.
_Avoid_: Discord user, DiscordUser.

**7R_Bot**:
The Discord application the platform runs as. Its bot user serves the slash commands, grants roles, polls the guild and creates the weekly op event. Ours, already in the guild, previously the bot behind the legacy `/loa` (a feature that is not ported: ADR 0010, ADR 0015). It is **not** the 2019 bot from `joeyyyb/7r-discordbot`, whose commands we port and whose account we do not. It is also not the TeamSpeak ServerQuery client, whose nickname happens to be `7R Bot` (`TS_BOT_NICKNAME`): different system, different thing, and that nickname is not changing.
_Avoid_: the bot (unqualified, in any sentence that also mentions TeamSpeak).

**TeamSpeak link**:
A Member's TeamSpeak identity (its client UID). One current link per member, self-service replaceable. Proven by a possession challenge (the pick-from-list + poked-code flow). This link is load-bearing: it drives role sync and it is how op attendance is credited to a person.
_Avoid_: TS user, TeamSpeak account.

**Steam link**:
A Member's Steam account (its SteamID64), proven by Steam OpenID login. A plain profile field: it proves the member owns the account and lets other members find them in Steam. Optional (a member without one is not incomplete), at most one per member. It gates nothing and is not used for attendance.
_Avoid_: Steam user, vetting, roster completeness.

**Assignable**:
A grantable thing a Member can hold. Three kinds: **Rank**, **Role**, **Badge**. The kinds differ only in meaning and in how they are displayed; the sync treats all three identically. Each Assignable is represented as a Discord role and mapped to an optional TeamSpeak server-group. Discord is authoritative (see ADR 0002).
_Avoid_: Permission, grant, tag, category.

**Rank**:
A Member's standing: Recruit, Member, NCO, Officer, Reserve. **Exclusive**: a Member holds exactly one. Reserve means "still one of us, not currently active"; it is a rank rather than a rung on the ladder, and sorts last. A kind of Assignable.
_Avoid_: Level, grade.

**Role**:
A staff function a Member is appointed to: Recruiter, Instructor, Mission maker. Additive (a Member may hold several, or none). A kind of Assignable. A Role is not a qualification.
_Avoid_: Job, position, permission.

**Badge**:
A training qualification a Member has earned: Medic, Marksman, Engineer, Armoured, Heavy Weapons, Leadership, Rotary Aviation, Fixed-Wing Aviation. Additive. A kind of Assignable.
_Avoid_: Achievement, certificate, qualification (as a term of its own).

**TeamSpeak server-group**:
A group on the TeamSpeak server (identified by its `sgid`) that the platform assigns to a linked TeamSpeak identity to mirror a Member's Discord roles. The platform only touches server-groups it owns via the Assignable mapping; everything else (Server Admin, Server Query, channel groups) is left untouched.
_Avoid_: TS role, TS rank.

**Operation** (Op):
A single scheduled 7R mission. Ops run on Saturday and only on Saturday, official mission time 20:00-23:00 Europe/Amsterdam, with the Discord event window running to 23:30 to cover overtime and debrief. An Operation is anchored to a Discord scheduled event (the weekly job auto-creates both together). RSVP on that event (Discord's native "Interested" list) is how the unit signals who is coming; there is no separate absence concept.
_Avoid_: Event (unqualified), mission (which is the in-game scenario), game night.

**Operations channel**:
The single TeamSpeak channel where members sit during an op (in-game squad comms run over ACRE2, so members stay in this one channel). Presence in it during the op window is what attendance is measured from.
_Avoid_: Op channel, voice channel.

**Attendance session**:
One continuous span a Member (resolved by their TeamSpeak identity) was present in the Operations channel during an Operation, with a join and leave time, reconstructed from periodic presence samples. A Member is credited for an op if their total in-window presence is at least 60 minutes. Attendance is a **statistic and nothing else**: it is shown on a Member's own profile and in a read-only site view. Nothing acts on it. It gates no promotion and triggers no removal.
_Avoid_: Presence, sample (a sample is one poll; a session is the reconstructed span).

**Guest**:
A TeamSpeak identity present in the Operations channel during an Operation that resolves to no Member. Its sessions are recorded against the bare TeamSpeak identity. If that identity is later linked to a Member, the guest sessions auto-backfill to them.
_Avoid_: Visitor, unknown user, orphan.

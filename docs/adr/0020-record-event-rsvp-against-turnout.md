# The Discord event's RSVP list is recorded, and compared against who turned up

During the op window, the worker captures the Saturday event's native "Interested" list into a new `operation_rsvp` table, every `ATTENDANCE_RSVP_REFRESH_SECONDS` (default 900). The attendance view then cross-tabulates it against TeamSpeak presence into three buckets: **came as promised**, **said yes and did not come**, and **came without saying**.

This reverses one line of IMPLEMENTATION §7, which said of the Interested list: "We store nothing for it and build no UI for it." That was right when the list had one job (ADR 0010: planning who turns up, so squads can be sized), and it is wrong now that the unit has asked a second question of it.

## Why the reversal

The list has always been live-only. **Discord exposes no way to ask an event who was interested in it after the fact**: `GET /guilds/{guild}/scheduled-events/{event}/users` answers about the event as it stands, the event ends, and the answer is gone. So "who said they were coming and did not turn up" cannot be computed later from anything we keep. It is a snapshot taken during the op or it does not exist.

Against that, the cost is small and bounded: one table of a Discord id, a display-name snapshot and two timestamps, and about a dozen REST calls per op.

## Why the capture window is the op, and not the announcement

The snapshot starts when the attendance window opens (20:00) and refreshes through it, rather than from the Wednesday announcement.

That is the difference between a no-show list that is fair and one that is not. A member who RSVPs on Wednesday, finds out on Saturday afternoon that they cannot make it, and **withdraws** has done exactly the right thing. Capturing from the announcement would keep their name and report them as a no-show for behaving well. Capturing from 20:00 asks the only question worth asking: when the op started, who was still signed up?

Refreshing *through* the window rather than once at 20:00 buys two things for eleven extra calls: somebody who signs up at 20:40 is recorded, and a worker that booted at 20:30 still captures a list instead of losing the op's RSVP data entirely.

## This does not make attendance a system of record

ADR 0010 stands, unamended. **Nothing acts on any of this.** It gates no promotion, triggers no removal, and feeds no process. ADR 0010's revisit trigger is about *acting* on attendance, which would demand an excuse mechanism, a dispute path and admin correction; none of that is being built, because nothing here decides anything. Two read-only views got more to show.

The roster view deliberately shows **counts, not an Active/Inactive label**, for the same reason. Where that line sits is arguable, nothing consumes the answer, and a binary flag is an invitation for something to start consuming it.

## Consequences

- **New table `operation_rsvp`**, unique on (`operation_id`, `discord_id`), plus `operation.rsvp_refreshed_at` as the pacing marker and `operation.last_sample_at` as the sampler's liveness mark.
- **No `member_id` column on it.** The join to `member.discord_id` happens at read time, so somebody who first signs in a month after an op is still matched against it, and there is no backfill to remember.
- **Privacy (ARCHITECTURE §7, GDPR-lite).** What is stored is a Discord id, a username snapshot and two timestamps, about people who are in the guild. The username snapshot exists only so a responder who is not a member can be named at all; a member is named from `member.display_name`. Rows cascade with the op.
- **The unit-wide view is admin-gated** (`DISCORD_ADMIN_ROLE_IDS`), unlike a member's own attendance, which stays on their profile. A list of named people who did not turn up belongs with the handful of people who have a reason to read it.
- **Two matches are structurally impossible, and both shrink as people link.** A responder who resolves to no member can never be matched to an attendee, so they land in "said yes and did not come"; a Guest can never be matched to a Discord id, so they land in "came without saying". Both are honest about what is actually known.
- **The RSVP half must never cost the op its attendance.** The Interested list is the decorative half of a decorative feature; the presence sample is the half that cannot be recovered afterwards. A failure reading the list is logged and swallowed, and the pass carries on sampling. A 403 there is a missing grant on `7R_Bot`, not a code fault.
- **If the weekly job never created an event** (its dry-run is still on, or the create 403'd on the missing `CREATE_EVENTS` grant), there is no list to read and the op simply has no RSVP data. Attendance is unaffected.

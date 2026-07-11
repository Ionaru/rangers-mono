# Op attendance is a statistic, and there is no leave of absence

Attendance is recorded and displayed, and **nothing acts on it**. It gates no promotion, triggers no demotion or removal, and is not a system of record. It is a number on a member's own profile and in a read-only site view.

Because nothing acts on it, the platform models **no absence at all**. There is no Leave of Absence concept, no `loa` table, no absence UI, and the legacy's **2,667 LOA rows are not imported**.

## Why

- Asked what attendance is *for*, the answer was: a number on a profile. Nothing consumes it.
- The legacy's LOA feature existed to *excuse* absence, which only makes sense when absence has consequences. With no consequences, LOA has no job to do.
- The planning need LOA also served (who is turning up on Saturday, so squads can be sized) is met for free by **Discord scheduled-event RSVP**. The weekly job already creates the Saturday event (ADR 0003's bot, Phase 4), and Discord's native "Interested" list sits in the tool the unit already has open. Zero schema, zero UI, zero migration.
- Corroborating evidence: the legacy attendance recorder's last write was **2024-07-27**, and the unit ran for two years without noticing. That is what a decoration looks like.

## Considered and rejected

- **Port LOA as-is.** Faithful to the legacy, but it is an accountability tool with no accountability to serve.
- **Build attendance but not LOA, and let members explain absence in Discord.** This is effectively what we have. Naming Discord scheduled-event RSVP as *the* mechanism is just being explicit about it.
- **Cut attendance entirely.** Genuinely tempting: it is the most complex remaining subsystem (a sampling loop, session reconstruction, guest backfill, a worker that must be alive on Saturday nights), and it is the only one nothing depends on. Rejected because the unit does want the number. Noted here as the **first thing to cut if the project stalls**.

## Consequences

- No `loa` table, no absence UI, no LOA import. The 2,667 legacy rows are binned.
- No historical attendance import either (75,241 samples, 401 operations); see ADR 0007. Attendance starts from zero.
- The credit rule (60 minutes of in-window presence, ADR 0007) survives, because it still defines what the displayed number *means*, but nothing downstream depends on it being exactly right.
- Combined with there being no live test environment and infrastructure being out of scope, nobody will notice quickly if attendance silently stops working. Accepted: it is decoration, not a system of record.
- **Revisit trigger:** if the unit ever wants to *act* on attendance (promotion gates, inactivity pruning), reopen this ADR **first**. Acting on it demands defensible data: LOA or an equivalent excuse mechanism, a dispute path, and admin correction. None of those exist today, and retrofitting them onto a decoration is the expensive path.

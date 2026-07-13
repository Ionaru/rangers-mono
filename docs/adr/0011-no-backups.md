# No backups: the only irreplaceable data is about a hundred TeamSpeak links

The platform takes **no off-box backups**. No restic, no object storage, no restore drill, no second key-holder. Postgres runs on a Docker volume and that is the whole story.

## Why

The question is not "what is the disaster recovery strategy". It is "what in this database cannot be reconstructed". After the decisions already taken, the answer is almost nothing:

| Data | Where it really lives | Cost to rebuild |
| --- | --- | --- |
| Ranks, roles, badges | Discord, which is the source of truth (ADR 0002) | Zero: the next poll re-derives it |
| Assignable mapping | git-tracked config, applied by a seed task (ADR 0009); TeamSpeak sgids are re-resolved by name against the live server anyway | Zero: it is in the repo |
| Steam links | A plain optional profile field | One click per member |
| Handbook | Markdown in git | Zero |
| Attendance | A statistic nobody acts on (ADR 0010); no history is imported | Zero, by design |
| **TeamSpeak identity links** | **Only here: ~100 rows, a few kilobytes** | **Ask the unit to re-link over a week** |

That last row is the entire exposure. Losing it means posting "everyone please re-link" and waiting a week. Mildly annoying, entirely survivable.

An elaborate backup workstream to protect a few kilobytes whose loss costs a week of mild annoyance is disproportionate for a spare-time project. The cost of a backup system is not the `pg_dump` line: it is writing it, storing it off-box, and above all **testing the restore**, because an untested backup is not a backup. That cost exceeds the cost of the loss it prevents.

## Considered and rejected

- **Nightly `pg_dump -Fc` + restic to object storage, with a restore drill.** The original plan (the old "Phase 7 - Hardening"). Rejected as disproportionate once it became clear how little irreplaceable data there is.
- **Dump to a private git repo.** Cheap and off-box, but it puts member PII (Discord IDs, TeamSpeak UIDs, Steam IDs) into a git repository, permanently and by design: history is the whole point of git, so a dump committed once is a dump you cannot take back. "Private" is a setting, not a property, and it is one keystroke from not being true. Rejected. (This bullet originally rested on a second argument, that the predecessor leaked a bot token into a public repo for seven years. That turned out to be false: the repo was private throughout, ARCHITECTURE §7. The PII argument above never depended on it, and the decision stands.)

## Consequences

- **Total loss of the box costs the unit the TeamSpeak links and any accrued attendance.** Accepted.
- The "hardening" phase is deleted, along with the restore drill and the second key-holder. The bus-factor question that was originally deferred no longer exists: there is no key to hold.
- **This decision is coupled to ADR 0010.** If attendance ever becomes something the unit *acts on*, it becomes a system of record, and this ADR must be reopened alongside that one.
- Reopen also if any future feature stores data that exists nowhere else (application history, incident records, anything written once and never re-derivable).

## A cheap thing worth doing anyway (not a backup)

A `pg_dump` to a different folder on the same box costs nothing and protects against the **likelier** failure. The realistic disaster is not losing the disk, it is a bad migration dropping a table. It is not disaster recovery, and nothing here claims it is.

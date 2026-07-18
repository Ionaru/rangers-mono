import type { Db } from "@7r/db";
import {
  clearMemberDisabledAt,
  listAssignables,
  listSyncMembers,
  setMemberDisabledAt,
} from "@7r/db";
import {
  type AssignableMapping,
  type MappedAssignable,
  type MemberSyncInput,
  planSyncPass,
  type SyncPassPlan,
} from "@7r/domain";
import { type DiscordRestOptions, listGuildMembers } from "@7r/discord";
import {
  addClientToServerGroup,
  getClientDbIdByUid,
  getServerGroupsByClientDbId,
  listServerGroups,
  removeClientFromServerGroup,
  type TeamspeakConnection,
} from "@7r/teamspeak";

/**
 * One reconcile pass, Discord -> TeamSpeak (IMPLEMENTATION §6), shared by the
 * worker's loop and the `sync:preview` CLI. All the decisions live in the pure
 * `planSyncPass` (packages/domain); this file only gathers its inputs and
 * applies its outputs, so everything that can be *wrong* about a pass stays
 * testable without a live server.
 */

export interface SyncDeps {
  db: Db;
  teamspeak: TeamspeakConnection;
  discord: DiscordRestOptions;
  guildId: string;
  maxRemovals: number;
  log: (message: string, extra?: Record<string, unknown>) => void;
  alert: (summary: string, detail?: unknown) => void;
}

/** A member the pass could not reconcile. Skipped, named, never fatal. */
export interface SkippedMember {
  displayName: string;
  tsUid: string;
  reason: string;
}

export interface SyncPassResult {
  outcome: "applied" | "dry_run" | "halted" | "aborted";
  /** Why, when aborted. */
  abortReason?: string;
  /** Absent only when aborted before planning. */
  plan?: SyncPassPlan;
  membersConsidered: number;
  skipped: SkippedMember[];
  appliedAdds: number;
  appliedRemoves: number;
  /** Live sgid -> group name, for a human-readable preview. */
  groupNames: Map<number, string>;
}

/**
 * Run one pass. `apply: false` computes and reports without writing anything,
 * which is both SYNC_DRY_RUN and the preview; `apply: true` writes TeamSpeak
 * groups and the `disabled_at` stamps, unless the blast-radius guard halts the
 * pass first.
 */
export async function runSyncPass(
  deps: SyncDeps,
  opts: { apply: boolean },
): Promise<SyncPassResult> {
  const { db, teamspeak, discord, guildId, log, alert } = deps;

  const aborted = (reason: string): SyncPassResult => {
    log("sync pass aborted", { reason });
    alert(`sync pass aborted: ${reason}`);
    return {
      outcome: "aborted",
      abortReason: reason,
      membersConsidered: 0,
      skipped: [],
      appliedAdds: 0,
      appliedRemoves: 0,
      groupNames: new Map(),
    };
  };

  // ---------------------------------------------- the mapping (DB, once)

  const assignables = await listAssignables(db);
  const mappingEntries: [string, MappedAssignable][] = assignables.map((
    a,
  ) => [a.discordRoleId, { kind: a.kind, name: a.name, tsSgid: a.tsSgid }]);
  let mapping: AssignableMapping = new Map(mappingEntries);

  if (mapping.size === 0) {
    // Without a mapping the owned set is empty and every member would diff to
    // "remove nothing, add nothing": a pass that looks like success and means
    // nothing. Say what is actually wrong instead.
    return aborted(
      "assignable mapping is empty; run `deno task assignables:seed` first",
    );
  }

  // ---------------------------------------------- the guild poll (once)

  // A thrown DiscordApiError propagates to the caller. A 403 here is almost
  // certainly the GUILD_MEMBERS intent toggle (packages/discord/members.ts).
  const guildMembers = await listGuildMembers(discord, guildId);
  if (guildMembers.length === 0) {
    // An empty guild is not a state this unit can be in; an empty *poll* is a
    // Discord failure. Planning on it would mark every member a leaver and
    // stamp disabled_at across the board, damage the blast-radius guard does
    // not count because stamps are not removals. Abort instead.
    return aborted("guild member poll returned 0 members");
  }
  const rolesByDiscordId = new Map(
    guildMembers.map((m) => [m.user.id, m.roles]),
  );

  // ------------------------------------- validate the mapping against TS

  const liveGroups = await listServerGroups(teamspeak);
  const groupNames = new Map<number, string>(
    liveGroups.map((g) => [Number(g.sgid), g.name]),
  );
  const deadEntries = mappingEntries.filter(
    ([, a]) => a.tsSgid !== null && !groupNames.has(a.tsSgid),
  );
  if (deadEntries.length > 0) {
    // A mapped group that no longer exists on the server: the sgid went stale
    // (server rebuilt, group deleted). Adds to it would fail and removals from
    // it are meaningless, so drop those entries for this pass and alert; the
    // durable fix is re-running the seed.
    const names = deadEntries.map(([, a]) => `${a.name} (sgid ${a.tsSgid})`);
    log("mapped sgids missing from live servergrouplist", { names });
    alert(
      "sync: mapped TeamSpeak groups no longer exist; re-run the seed",
      names.join(", "),
    );
    mapping = new Map(
      mappingEntries.map((
        [roleId, a],
      ) => [
        roleId,
        a.tsSgid !== null && !groupNames.has(a.tsSgid)
          ? { ...a, tsSgid: null }
          : a,
      ]),
    );
  }

  // ------------------------------------- gather per-member TeamSpeak state

  const members = await listSyncMembers(db);
  const inputs: MemberSyncInput[] = [];
  const cldbidByMemberId = new Map<string, string>();
  const skipped: SkippedMember[] = [];

  for (const member of members) {
    const roles = rolesByDiscordId.get(member.discordId);
    try {
      const cldbid = await getClientDbIdByUid(deps.teamspeak, member.tsUid);
      if (cldbid === null) {
        // This server has never seen the identity: a legacy-imported uid from
        // before the rebuild, or a typo'd force-link. Nothing to reconcile.
        skipped.push({
          displayName: member.displayName,
          tsUid: member.tsUid,
          reason: "TeamSpeak identity unknown to this server",
        });
        continue;
      }
      const groups = await getServerGroupsByClientDbId(teamspeak, cldbid);
      cldbidByMemberId.set(member.id, cldbid);
      inputs.push({
        memberId: member.id,
        displayName: member.displayName,
        tsUid: member.tsUid,
        inGuild: roles !== undefined,
        discordRoleIds: roles ?? [],
        alreadyDisabled: member.disabledAt !== null,
        currentSgids: groups.map((g) => Number(g.sgid)),
      });
    } catch (error) {
      // One member's ServerQuery hiccup must not kill the other ninety-nine.
      skipped.push({
        displayName: member.displayName,
        tsUid: member.tsUid,
        reason: String(error),
      });
    }
  }

  // ---------------------------------------------- plan (pure), then act

  const plan = planSyncPass(inputs, mapping, {
    maxRemovals: deps.maxRemovals,
  });

  for (const memberPlan of plan.changed) {
    for (const warning of memberPlan.warnings) {
      log("sync warning", { member: memberPlan.displayName, warning });
    }
  }

  const base = {
    plan,
    membersConsidered: members.length,
    skipped,
    groupNames,
  };

  if (plan.halted) {
    const strippees = plan.members
      .filter((m) => m.toRemove.length > 0)
      .map((m) => m.displayName);
    alert(
      `SYNC HALTED by the blast-radius guard: a single pass would remove owned groups from ` +
        `${plan.removalMemberCount} members (SYNC_MAX_REMOVALS=${plan.maxRemovals}). ` +
        `Nothing was applied. This is definitionally a bug: a bad mapping, an empty-ish ` +
        `Discord poll, or TeamSpeak returning garbage.`,
      strippees.join(", "),
    );
    return { ...base, outcome: "halted", appliedAdds: 0, appliedRemoves: 0 };
  }

  if (!opts.apply) {
    for (const m of plan.changed) {
      log("sync dry-run diff", {
        member: m.displayName,
        tsUid: m.tsUid,
        toAdd: m.toAdd,
        toRemove: m.toRemove,
        stampDisabled: m.stampDisabled,
        clearDisabled: m.clearDisabled,
      });
    }
    log("sync pass (dry run)", {
      members: members.length,
      changed: plan.changed.length,
      removalMembers: plan.removalMemberCount,
      skipped: skipped.length,
    });
    return { ...base, outcome: "dry_run", appliedAdds: 0, appliedRemoves: 0 };
  }

  let appliedAdds = 0;
  let appliedRemoves = 0;
  const writeFailures: string[] = [];

  for (const memberPlan of plan.changed) {
    const cldbid = cldbidByMemberId.get(memberPlan.memberId);
    try {
      if (cldbid !== undefined) {
        for (const sgid of memberPlan.toAdd) {
          await addClientToServerGroup(teamspeak, cldbid, String(sgid));
          appliedAdds++;
        }
        for (const sgid of memberPlan.toRemove) {
          await removeClientFromServerGroup(teamspeak, cldbid, String(sgid));
          appliedRemoves++;
        }
      }
      if (memberPlan.stampDisabled) {
        await setMemberDisabledAt(db, memberPlan.memberId);
        log("member stamped disabled (missing from guild)", {
          member: memberPlan.displayName,
        });
      }
      if (memberPlan.clearDisabled) {
        await clearMemberDisabledAt(db, memberPlan.memberId);
        log("member re-enabled (back in guild)", {
          member: memberPlan.displayName,
        });
      }
    } catch (error) {
      writeFailures.push(`${memberPlan.displayName}: ${String(error)}`);
    }
  }

  if (writeFailures.length > 0) {
    alert(
      `sync: ${writeFailures.length} member(s) failed to apply`,
      writeFailures.join("\n"),
    );
  }

  log("sync pass applied", {
    members: members.length,
    changed: plan.changed.length,
    adds: appliedAdds,
    removes: appliedRemoves,
    skipped: skipped.length,
    failures: writeFailures.length,
  });

  return { ...base, outcome: "applied", appliedAdds, appliedRemoves };
}

/**
 * The steady-state loop: one pass now, then every `intervalSeconds`, forever.
 *
 * Sync is eventually-consistent by design (ADR 0002: REST polling, no
 * gateway), so a failed pass is logged, alerted, and simply retried on the
 * next tick. The `running` latch stops a slow pass stacking a second one onto
 * the same ServerQuery connection. Returns a stop function for the worker's
 * shutdown path, which releases every handle it takes (main.ts's rule).
 */
export function startSyncLoop(
  deps: SyncDeps,
  opts: { intervalSeconds: number; dryRun: boolean },
): () => void {
  let running = false;

  const pass = async () => {
    if (running) {
      deps.log("sync pass still running, skipping this tick");
      return;
    }
    running = true;
    try {
      await runSyncPass(deps, { apply: !opts.dryRun });
    } catch (error) {
      deps.log("sync pass failed", { error: String(error) });
      deps.alert("sync pass failed", error);
    } finally {
      running = false;
    }
  };

  deps.log("sync loop started", {
    intervalSeconds: opts.intervalSeconds,
    dryRun: opts.dryRun,
  });
  pass();
  const interval = setInterval(pass, opts.intervalSeconds * 1_000);
  return () => clearInterval(interval);
}

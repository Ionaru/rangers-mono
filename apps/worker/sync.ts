import type { Db } from "@7r/db";
import {
  clearMemberDisabledAt,
  listAssignables,
  listSyncMembers,
  setMemberDisabledAt,
} from "@7r/db";
import {
  type AssignableMapping,
  gatherSyncInputs,
  type GroupHolder,
  type MappedAssignable,
  type MemberSyncInput,
  ownedSgids,
  planSyncPass,
  type SyncPassPlan,
} from "@7r/domain";
import {
  DiscordApiError,
  type DiscordRestOptions,
  listGuildMembers,
} from "@7r/discord";
import {
  addClientToServerGroup,
  commandThrottleStats,
  getClientDbIdByUid,
  listServerGroupMembers,
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

/**
 * A member whose TeamSpeak group reconcile was skipped this pass. Named, never
 * fatal. Their `disabled_at` is still decided from Discord state; only the
 * group add/remove is skipped, because we could not read their TeamSpeak side.
 */
export interface SkippedMember {
  displayName: string;
  tsUid: string;
  reason: string;
  /**
   * Why the group reconcile was skipped:
   * - `unknown_identity`: the server has never seen this uid (a legacy import
   *   from before the rebuild, or a bad force-link). Mostly routine, so the loop
   *   counts it rather than alerting; `sync:preview` names them for the rare
   *   force-link typo worth chasing.
   * - `lookup_error`: a ServerQuery call threw. A member stuck erroring every
   *   pass is a real fault, so this class alerts (once per episode) and is named
   *   in the loop's logs every pass.
   */
  kind: "unknown_identity" | "lookup_error";
}

export interface SyncPassResult {
  outcome: "applied" | "dry_run" | "halted" | "aborted";
  /** Why, when aborted. */
  abortReason?: string;
  /** Absent only when aborted before planning. */
  plan?: SyncPassPlan;
  membersConsidered: number;
  skipped: SkippedMember[];
  /**
   * Members who hold no owned group and are due none, so no per-identity lookup
   * was spent on them. They are a no-op either way; what the cheap pass gives up
   * is noticing that their `ts_uid` is stale.
   */
  notLookedUp: { displayName: string; tsUid: string }[];
  /** Per-identity lookups this pass had to fall back to. Steady state is a handful. */
  probes: number;
  /**
   * Owned groups whose client list could not be read, and which were therefore
   * left out of the reconcile entirely for this pass.
   */
  unreadableGroups: string[];
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

  /**
   * @param reason a summary that is CONSTANT per condition. The loop's page
   *   de-duplication keys on it, so a reason carrying a group name, a count or
   *   an error string would page on every single tick of a standing fault.
   *   Everything that varies belongs in `detail`.
   */
  const aborted = (
    reason: string,
    opts: { page?: boolean; detail?: unknown } = {},
  ): SyncPassResult => {
    log("sync pass aborted", { reason, detail: opts.detail });
    // Most aborts are real failures worth paging (an empty guild poll is a
    // Discord outage or a revoked GUILD_MEMBERS intent). A few are expected
    // states that must not page the error webhook every tick: those callers
    // pass `page: false`, and the log line above still records them.
    if (opts.page !== false) alert(`sync pass aborted: ${reason}`, opts.detail);
    return {
      outcome: "aborted",
      abortReason: reason,
      membersConsidered: 0,
      skipped: [],
      notLookedUp: [],
      probes: 0,
      unreadableGroups: [],
      appliedAdds: 0,
      appliedRemoves: 0,
      groupNames: new Map(),
    };
  };

  const throttleBefore = commandThrottleStats(teamspeak);

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
    //
    // But do NOT page the error webhook for it: the deploy starts this loop at
    // boot and seeds the mapping *afterwards* (assignable-seed.ts runs before
    // the first sync:preview), so an empty mapping is the expected pre-seed
    // state, not a bug. Paging every ROLE_SYNC_INTERVAL_SECONDS until someone
    // seeds would only train operators to ignore the channel.
    return aborted(
      "assignable mapping is empty; run `deno task assignables:seed` first",
      { page: false },
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
    // Decide "dead" once, here, so the alert above and the rebuild below can
    // never fall out of lock-step on the same predicate.
    const deadSgids = new Set(deadEntries.map(([, a]) => a.tsSgid!));
    mapping = new Map(
      mappingEntries.map((
        [roleId, a],
      ) => [
        roleId,
        a.tsSgid !== null && deadSgids.has(a.tsSgid)
          ? { ...a, tsSgid: null }
          : a,
      ]),
    );
  }

  // ---------------------------- gather TeamSpeak state, one call per GROUP

  /**
   * The command budget is why this is shaped the way it is.
   *
   * Asking TeamSpeak about each member in turn costs two commands each, which
   * on this roster was two hundred commands a pass against a server that allows
   * ten every three seconds: a permanent flood that held the connection the link
   * flow shares (packages/teamspeak/throttle.ts). Asking about each owned GROUP
   * instead costs one command each, fifteen in total, whatever the roster does,
   * and `servergroupclientlist -names` returns the durable `cldbid` alongside
   * the identity, so nobody who holds a group needs looking up separately.
   *
   * The pass still iterates OUR members (below). Only the lookup direction
   * changed; the leaver fix that depends on iterating our own database is
   * untouched (§4.4).
   */
  const ownedForReads = ownedSgids(mapping);
  const holdersBySgid = new Map<number, GroupHolder[]>();
  const unreadableGroups: string[] = [];

  /**
   * Take a group out of the reconcile for this pass.
   *
   * Nulling its sgid in the mapping removes it from `desired` and from `current`
   * together, which is the only honest position when we cannot see who holds it:
   * this pass has no opinion about that group, for anyone. Everybody else
   * reconciles normally and the next tick tries again.
   *
   * The failure it avoids is not a strip. With the per-group gather, `current`
   * is built FROM the lists, so a group read as empty can only shrink `current`:
   * it plans adds for people who already hold the group (which TeamSpeak refuses
   * as duplicates, noisily) and silently drops the removals that were due. The
   * blast-radius guard counts removals, so it would see none of it.
   */
  const excludeFromPass = (sgids: ReadonlySet<number>) => {
    for (const sgid of sgids) holdersBySgid.delete(sgid);
    mapping = new Map(
      [...mapping].map((
        [roleId, a],
      ) => [
        roleId,
        a.tsSgid !== null && sgids.has(a.tsSgid) ? { ...a, tsSgid: null } : a,
      ]),
    );
  };

  for (const sgid of [...ownedForReads].sort((a, b) => a - b)) {
    try {
      holdersBySgid.set(
        sgid,
        await listServerGroupMembers(teamspeak, String(sgid)),
      );
    } catch (error) {
      unreadableGroups.push(
        `${groupNames.get(sgid) ?? "?"} (sgid ${sgid}): ${String(error)}`,
      );
      excludeFromPass(new Set([sgid]));
    }
  }

  // ---------------------------------------------- join it to our members

  const members = await listSyncMembers(db);
  const memberRows = members.map((member) => {
    const roles = rolesByDiscordId.get(member.discordId);
    // The disabled_at half of a member's plan is a pure Discord fact and does
    // not depend on TeamSpeak at all. A member we cannot read on TeamSpeak is
    // planned with a null TeamSpeak state: no group ops, but the stamp/clear
    // still fires (§4.4).
    return {
      memberId: member.id,
      displayName: member.displayName,
      tsUid: member.tsUid,
      inGuild: roles !== undefined,
      discordRoleIds: roles ?? [],
      alreadyDisabled: member.disabledAt !== null,
    };
  });

  let gathered = gatherSyncInputs(memberRows, holdersBySgid, mapping);

  if (gathered.malformedBySgid.size > 0) {
    /**
     * A holder list we cannot join is the same problem as one we could not read,
     * arriving by a different route, so it gets the same treatment: exclude
     * those groups and reconcile the rest. `-names` is what puts the identity in
     * the response, and without it nothing joins and every member in that group
     * reads as holding nothing. Re-gathering is free: it is a pure function.
     */
    for (const [sgid, count] of gathered.malformedBySgid) {
      unreadableGroups.push(
        `${
          groupNames.get(sgid) ?? "?"
        } (sgid ${sgid}): ${count} entr(ies) had no identity, no client id, or a duplicate client`,
      );
    }
    excludeFromPass(new Set(gathered.malformedBySgid.keys()));
    gathered = gatherSyncInputs(memberRows, holdersBySgid, mapping);
  }

  if (unreadableGroups.length > 0) {
    if (ownedForReads.size > 0 && ownedSgids(mapping).size === 0) {
      // Nothing usable is not a pass with nothing to do, it is a pass that saw
      // nothing. Say so rather than reporting a clean no-op.
      return aborted("no owned TeamSpeak group could be read", {
        detail: unreadableGroups.join("\n"),
      });
    }
    log("sync: owned groups excluded from this pass", {
      groups: unreadableGroups,
    });
    // Stable summary, the group names and errors in the detail, so a standing
    // fault on one group pages once per episode rather than every tick.
    alert(
      "sync: some TeamSpeak groups could not be read",
      `Left out of the reconcile for this pass (nobody gains or loses them):\n${
        unreadableGroups.join("\n")
      }`,
    );
  }

  const skipped: SkippedMember[] = gathered.unresolved.map((u) => ({
    displayName: u.displayName,
    tsUid: u.tsUid,
    reason: u.reason,
    kind: "lookup_error" as const,
  }));

  /**
   * The fallback, and the only per-member command left: somebody Discord says
   * should hold a group, who holds none of them, so the group lists never gave
   * us their `cldbid`. A removal never lands here, because holding a group is
   * what puts you in a list in the first place.
   */
  const probeFailed = new Set<string>();
  for (const target of gathered.needsProbe) {
    try {
      const cldbid = await getClientDbIdByUid(teamspeak, target.tsUid);
      if (cldbid === null) {
        // This server has never seen the identity: a legacy-imported uid from
        // before the rebuild, or a typo'd force-link. Their groups cannot be
        // reconciled, but their disabled_at still follows Discord.
        skipped.push({
          displayName: target.displayName,
          tsUid: target.tsUid,
          reason: "TeamSpeak identity unknown to this server",
          kind: "unknown_identity",
        });
        probeFailed.add(target.memberId);
      } else {
        gathered.cldbidByMemberId.set(target.memberId, cldbid);
      }
    } catch (error) {
      // One member's ServerQuery hiccup must not kill the other ninety-nine.
      skipped.push({
        displayName: target.displayName,
        tsUid: target.tsUid,
        reason: String(error),
        kind: "lookup_error",
      });
      probeFailed.add(target.memberId);
    }
  }

  // A member we could not resolve is one we cannot write to, so plan no group
  // ops for them: `null`, which is what "we do not know" means to the reconcile,
  // rather than the `[]` the gather optimistically gave them.
  const inputs: MemberSyncInput[] = gathered.inputs.map((input) =>
    probeFailed.has(input.memberId) ? { ...input, currentSgids: null } : input
  );
  const cldbidByMemberId = gathered.cldbidByMemberId;

  // A member that errors on every pass is never reconciled and, unlike a write
  // failure, would otherwise be invisible: surface the error class (the routine
  // unknown-identity class is a count only, below). The loop de-dupes this page
  // so a persistently-broken member is reported once per episode, not per tick.
  const skippedErrors = skipped.filter((s) => s.kind === "lookup_error");
  const skippedUnknown = skipped.filter((s) => s.kind === "unknown_identity");
  if (skippedErrors.length > 0) {
    log("sync: members errored on TeamSpeak lookup", {
      members: skippedErrors.map((s) => `${s.displayName}: ${s.reason}`),
    });
    alert(
      "sync: members could not be looked up on TeamSpeak",
      skippedErrors
        .map((s) => `${s.displayName} (${s.tsUid}): ${s.reason}`)
        .join("\n"),
    );
  }

  // ---------------------------------------------- plan (pure), then act

  const plan = planSyncPass(inputs, mapping, {
    maxRemovals: deps.maxRemovals,
  });

  // Warnings hang on every planned member, not only the ones with a diff. A
  // member holding two rank roles whose TeamSpeak groups already mirror both is
  // a no-op this pass, so it is absent from `plan.changed`, but it is still a
  // Discord state to flag every pass until a human fixes it (IMPLEMENTATION §6
  // step 7). Iterate `plan.members`, as sync-preview.ts already does; iterating
  // `plan.changed` here silently dropped exactly the converged-conflict case.
  for (const memberPlan of plan.members) {
    for (const warning of memberPlan.warnings) {
      log("sync warning", { member: memberPlan.displayName, warning });
    }
  }

  const base = {
    plan,
    membersConsidered: members.length,
    skipped,
    notLookedUp: gathered.notLookedUp,
    probes: gathered.needsProbe.length,
    unreadableGroups,
    groupNames,
  };

  /**
   * What the pacing cost this pass.
   *
   * The flood used to announce itself: a log line per second saying the
   * connection was over budget. Pacing removes the announcement along with the
   * flood, so this replaces it. A pass that grows from five seconds of waiting
   * to forty means the command budget is being outgrown, and this is the only
   * place that would say so.
   */
  const throttleUsage = () => {
    const now = commandThrottleStats(teamspeak);
    return {
      commands: now.commands - throttleBefore.commands,
      gateWaitMs: Math.round(now.waitedMs - throttleBefore.waitedMs),
    };
  };

  if (plan.halted) {
    const strippees = plan.members
      .filter((m) => m.toRemove.length > 0)
      .map((m) => m.displayName);
    // Log every pass (the page is de-duped by the loop, so without this a
    // standing halt would go dark in the logs after its first alert). A halt is
    // often the whole membership (a bad or empty mapping), so the names are
    // sampled rather than dumped in full every tick: the count is the signal,
    // and sync:preview enumerates them in full on demand.
    log("sync halted by blast-radius guard", {
      removalMembers: plan.removalMemberCount,
      maxRemovals: plan.maxRemovals,
      dryRun: !opts.apply,
      sample: strippees.slice(0, 10),
    });
    // Stable summary (the varying counts live in the detail, which the loop's
    // de-dup ignores), plus a dry-run marker so it does not read as a live trip.
    alert(
      `SYNC HALTED by the blast-radius guard${opts.apply ? "" : " (dry run)"}`,
      `A single pass would remove owned groups from ${plan.removalMemberCount} ` +
        `member(s) (SYNC_MAX_REMOVALS=${plan.maxRemovals}); nothing was applied. ` +
        `This is definitionally a bug: a bad mapping, an empty-ish Discord poll, ` +
        `or TeamSpeak returning garbage.\nMembers losing groups: ${
          strippees.join(", ")
        }`,
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
      skippedUnknown: skippedUnknown.length,
      skippedErrors: skippedErrors.length,
      notLookedUp: gathered.notLookedUp.length,
      probes: gathered.needsProbe.length,
      ...throttleUsage(),
    });
    return { ...base, outcome: "dry_run", appliedAdds: 0, appliedRemoves: 0 };
  }

  let appliedAdds = 0;
  let appliedRemoves = 0;
  const writeFailures: string[] = [];

  for (const memberPlan of plan.changed) {
    const cldbid = cldbidByMemberId.get(memberPlan.memberId);
    try {
      if (
        cldbid === undefined &&
        (memberPlan.toAdd.length > 0 || memberPlan.toRemove.length > 0)
      ) {
        // Unreachable by construction: a member with no resolved cldbid was
        // planned with a null TeamSpeak state, which yields no group ops. If it
        // ever happens, the plan and the gather have drifted apart, and
        // dropping the writes on the floor silently is how that stays hidden.
        throw new Error(
          "planned group changes for a member with no resolved TeamSpeak client id",
        );
      }
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
    // Log the members every pass: the page below is de-duped on a stable
    // summary, so without this log a *different* member failing on a later pass
    // (same summary, suppressed page) would leave no trace anywhere.
    log("sync write failures", { members: writeFailures });
    // Stable summary, count in the detail, so the loop's de-dup pages a standing
    // write fault once per episode rather than every tick.
    alert(
      "sync: members failed to apply",
      `${writeFailures.length} member(s):\n${writeFailures.join("\n")}`,
    );
  }

  log("sync pass applied", {
    members: members.length,
    changed: plan.changed.length,
    adds: appliedAdds,
    removes: appliedRemoves,
    skippedUnknown: skippedUnknown.length,
    skippedErrors: skippedErrors.length,
    notLookedUp: gathered.notLookedUp.length,
    probes: gathered.needsProbe.length,
    failures: writeFailures.length,
    ...throttleUsage(),
  });

  return { ...base, outcome: "applied", appliedAdds, appliedRemoves };
}

/**
 * A failure that will still be there in fifteen minutes, so waiting to report it
 * buys nothing.
 *
 * A 401 is a bad or revoked bot token; a 403 on the member list is almost always
 * the GUILD_MEMBERS privileged intent turned off (packages/discord/members.ts).
 * Neither is weather, both need a human, and while either is true the website's
 * guild gate is failing for every new sign-in on the same token.
 */
function isPermanent(error: unknown): boolean {
  return error instanceof DiscordApiError &&
    (error.status === 401 || error.status === 403);
}

/**
 * The steady-state loop: one pass now, then every `intervalSeconds`, forever.
 *
 * Sync is eventually-consistent by design (ADR 0002: REST polling, no
 * gateway), so a failed pass is logged, alerted, and simply retried on the
 * next tick. The `running` latch stops a slow pass stacking a second one onto
 * the same ServerQuery connection, and an edge-triggered de-dup (below) keeps a
 * standing fault from paging the error webhook on every tick. Returns a stop
 * function for the worker's shutdown path, which releases every handle it takes
 * (main.ts's rule).
 */
export function startSyncLoop(
  deps: SyncDeps,
  opts: { intervalSeconds: number; dryRun: boolean },
): () => void {
  let running = false;

  /**
   * Edge-triggered page de-duplication. A standing condition (a persistent
   * blast-radius halt, a stale sgid, a member that errors every pass) must page
   * the error webhook ONCE when it starts, not every `intervalSeconds` forever:
   * the guard's channel is only useful while people still read it, and an alert
   * that repeats 288 times a day trains them not to.
   *
   * We key on the alert *summary*, which the callers above write to be stable
   * per condition (the varying counts and names live in the `detail` argument,
   * which is ignored here). A summary pages only when it was absent from the
   * previous pass; while it persists it stays quiet; if it clears and later
   * returns it pages again. runSyncPass still `log()`s every condition every
   * pass, so nothing goes dark, only the paging is de-duplicated. This is
   * category-level on purpose: a different `detail` under the same summary (a
   * different member failing) does not re-page, which the per-pass logs cover,
   * and which is the price of never spamming.
   */
  let pagedLastPass = new Set<string>();

  /**
   * A pass that fails is not yet news. Discord and Cloudflare both hiccup, and
   * the first week of Phase 4 in production produced a 500, a 520 and two 522s,
   * every one of which had fixed itself by the next tick and every one of which
   * paged. So the webhook waits until failures accumulate. Every failure is
   * still logged, immediately and individually.
   *
   * A leaky bucket rather than a strict run: a failure adds one, a clean pass
   * takes one away. A single blip drains to nothing and is never paged, which is
   * the whole point, but a fault that fails two passes in three no longer hides
   * behind the successes forever, which a "three consecutive" rule would let it
   * do indefinitely.
   */
  const FAILURE_ALERT_AT = 3;
  let failureScore = 0;
  let pagedFailure = false;

  /**
   * The one failure the run rule must not delay, and the one the `running` latch
   * hides completely. A pass that hangs never returns and never throws, so it
   * never becomes a "failed pass" at all: it silently suppresses every tick
   * after it. Count the suppressed ticks and say so.
   */
  const STALL_ALERT_AFTER = 3;
  let skippedTicks = 0;
  let pagedStall = false;

  const pass = async () => {
    if (running) {
      skippedTicks++;
      deps.log("sync pass still running, skipping this tick", { skippedTicks });
      if (skippedTicks >= STALL_ALERT_AFTER && !pagedStall) {
        pagedStall = true;
        deps.alert(
          "sync pass appears stuck",
          `A pass has been running for more than ${skippedTicks} intervals and every tick since has been skipped. ` +
            `Nothing is being reconciled. The usual cause is a ServerQuery command that will never answer, ` +
            `which a worker restart clears.`,
        );
      }
      return;
    }
    running = true;
    skippedTicks = 0;
    pagedStall = false;
    const pagedThisPass = new Set<string>();
    const dedupedAlert = (summary: string, detail?: unknown) => {
      pagedThisPass.add(summary);
      if (!pagedLastPass.has(summary)) deps.alert(summary, detail);
    };
    try {
      const result = await runSyncPass({ ...deps, alert: dedupedAlert }, {
        apply: !opts.dryRun,
      });
      failureScore = Math.max(0, failureScore - 1);
      if (pagedFailure && failureScore === 0) {
        /**
         * The episode is over: clear the latch unconditionally, so a NEW run of
         * failures later can page again. That is separate from whether to say
         * so out loud, because a pass can reach "applied" while alerting about
         * something else entirely (write failures, an unreadable group), and an
         * all-clear stapled to the same tick as a standing fault, or to a
         * blast-radius halt, is worse than saying nothing. Tie the latch to the
         * failures and the announcement to the silence.
         */
        pagedFailure = false;
        if (
          pagedThisPass.size === 0 &&
          (result.outcome === "applied" || result.outcome === "dry_run")
        ) {
          deps.alert("sync recovered", "A pass completed normally again.");
        }
      }
    } catch (error) {
      failureScore++;
      deps.log("sync pass failed", { error: String(error), failureScore });
      // `pagedFailure` is the episode latch, not `pagedLastPass`: a fault that
      // flaps (fail, succeed, fail) would otherwise clear the one-pass de-dup
      // every other tick and page again and again. One page per episode, one
      // all-clear when it ends.
      if (
        !pagedFailure &&
        (failureScore >= FAILURE_ALERT_AT || isPermanent(error))
      ) {
        pagedFailure = true;
        dedupedAlert("sync pass failed", error);
      }
    } finally {
      pagedLastPass = pagedThisPass;
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

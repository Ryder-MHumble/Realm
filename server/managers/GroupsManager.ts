/**
 * Groups Manager
 *
 * Manages zone group CRUD operations and persistence.
 * Zone groups link adjacent hex zones into "departments".
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import type {
  ZoneGroup,
  CreateZoneGroupRequest,
  UpdateZoneGroupRequest,
  ManagedSession,
  ServerMessage,
} from "../../shared/types.js";
import { log, debug } from "../logger.js";

export class GroupsManager {
  private groups = new Map<string, ZoneGroup>();
  private filePath: string;
  private broadcastFn: ((msg: ServerMessage) => void) | null = null;

  /** Callbacks to access sessions without circular imports */
  private getSessionFn: ((id: string) => ManagedSession | undefined) | null =
    null;
  private hasSessionFn: ((id: string) => boolean) | null = null;
  private broadcastSessionsFn: (() => void) | null = null;
  private saveSessionsFn: (() => void) | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcastFn = fn;
  }

  setSessionAccessors(deps: {
    getSession: (id: string) => ManagedSession | undefined;
    hasSession: (id: string) => boolean;
    broadcastSessions: () => void;
    saveSessions: () => void;
  }): void {
    this.getSessionFn = deps.getSession;
    this.hasSessionFn = deps.hasSession;
    this.broadcastSessionsFn = deps.broadcastSessions;
    this.saveSessionsFn = deps.saveSessions;
  }

  /** Load groups from disk */
  load(): void {
    if (!existsSync(this.filePath)) {
      debug("No saved groups file found");
      return;
    }

    try {
      const content = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(content) as ZoneGroup[];

      for (const group of data) {
        this.groups.set(group.id, group);
      }

      log(`Loaded ${this.groups.size} groups from ${this.filePath}`);
    } catch (e) {
      console.error("Failed to load groups:", e);
    }
  }

  /** Get all groups */
  getAll(): ZoneGroup[] {
    return Array.from(this.groups.values());
  }

  /** Get a group by ID */
  get(id: string): ZoneGroup | undefined {
    return this.groups.get(id);
  }

  /** Find the group a session belongs to */
  findGroupForSession(managedSessionId: string): ZoneGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.memberSessionIds.includes(managedSessionId)) {
        return group;
      }
    }
    return undefined;
  }

  /**
   * Remove a session from its group.
   * If only 1 member remains, dissolve the group.
   */
  removeSessionFromGroup(managedSessionId: string): void {
    const group = this.findGroupForSession(managedSessionId);
    if (!group) return;

    group.memberSessionIds = group.memberSessionIds.filter(
      (id) => id !== managedSessionId,
    );

    // Clear groupId on the session
    const session = this.getSessionFn?.(managedSessionId);
    if (session) {
      session.groupId = undefined;
    }

    // If 1 or fewer members remain, dissolve the group
    if (group.memberSessionIds.length <= 1) {
      if (group.memberSessionIds.length === 1) {
        const remaining = this.getSessionFn?.(group.memberSessionIds[0]);
        if (remaining) {
          remaining.groupId = undefined;
        }
      }
      this.groups.delete(group.id);
      log(`Dissolved group "${group.name || group.id}" (too few members)`);
    }

    this.save();
    this.saveSessionsFn?.();
    this.broadcastGroups();
    this.broadcastSessionsFn?.();
  }

  /** Create a new group */
  create(
    data: CreateZoneGroupRequest,
  ): { ok: true; group: ZoneGroup } | { ok: false; error: string } {
    // Validate member count
    if (
      !data.memberSessionIds ||
      !Array.isArray(data.memberSessionIds) ||
      data.memberSessionIds.length < 2
    ) {
      return { ok: false, error: "Need at least 2 session IDs" };
    }

    // Verify all sessions exist
    for (const sid of data.memberSessionIds) {
      if (!this.hasSessionFn?.(sid)) {
        return { ok: false, error: `Session ${sid} not found` };
      }
    }

    // Check if any members already belong to a group - merge into it
    let existingGroup: ZoneGroup | undefined;
    for (const sid of data.memberSessionIds) {
      const g = this.findGroupForSession(sid);
      if (g) {
        existingGroup = g;
        break;
      }
    }

    if (existingGroup) {
      // Merge: add non-members to the existing group
      for (const sid of data.memberSessionIds) {
        if (!existingGroup.memberSessionIds.includes(sid)) {
          this.removeSessionFromGroup(sid);
          existingGroup.memberSessionIds.push(sid);
          const session = this.getSessionFn?.(sid);
          if (session) {
            session.groupId = existingGroup.id;
          }
        }
      }
      if (data.name) existingGroup.name = data.name;
      if (data.color) existingGroup.color = data.color;

      this.save();
      this.saveSessionsFn?.();
      this.broadcastGroups();
      this.broadcastSessionsFn?.();

      log(
        `Merged into group "${existingGroup.name || existingGroup.id.slice(0, 8)}" - now ${existingGroup.memberSessionIds.length} members`,
      );
      return { ok: true, group: existingGroup };
    }

    // Remove members from existing groups first
    for (const sid of data.memberSessionIds) {
      this.removeSessionFromGroup(sid);
    }

    const group: ZoneGroup = {
      id: randomUUID(),
      name: data.name,
      color: data.color,
      memberSessionIds: data.memberSessionIds,
      createdAt: Date.now(),
    };

    this.groups.set(group.id, group);

    // Set groupId on each member session
    for (const sid of group.memberSessionIds) {
      const session = this.getSessionFn?.(sid);
      if (session) {
        session.groupId = group.id;
      }
    }

    this.save();
    this.saveSessionsFn?.();
    this.broadcastGroups();
    this.broadcastSessionsFn?.();

    log(
      `Created group "${group.name || group.id.slice(0, 8)}" with ${group.memberSessionIds.length} members`,
    );
    return { ok: true, group };
  }

  /** Update a group */
  update(
    id: string,
    data: UpdateZoneGroupRequest,
  ):
    | { ok: true; group: ZoneGroup; dissolved?: boolean }
    | { ok: false; error: string } {
    const group = this.groups.get(id);
    if (!group) return { ok: false, error: "Group not found" };

    if (data.name !== undefined) {
      group.name = data.name || undefined;
    }

    if (data.color !== undefined) {
      group.color = data.color || undefined;
    }

    // Add members
    if (data.addMembers && Array.isArray(data.addMembers)) {
      for (const sid of data.addMembers) {
        if (!this.hasSessionFn?.(sid)) {
          return { ok: false, error: `Session ${sid} not found` };
        }
        this.removeSessionFromGroup(sid);
        if (!group.memberSessionIds.includes(sid)) {
          group.memberSessionIds.push(sid);
        }
        const session = this.getSessionFn?.(sid);
        if (session) {
          session.groupId = group.id;
        }
      }
    }

    // Remove members
    if (data.removeMembers && Array.isArray(data.removeMembers)) {
      for (const sid of data.removeMembers) {
        group.memberSessionIds = group.memberSessionIds.filter(
          (memberId) => memberId !== sid,
        );
        const session = this.getSessionFn?.(sid);
        if (session) {
          session.groupId = undefined;
        }
      }

      // Auto-dissolve if fewer than 2 members remain
      if (group.memberSessionIds.length <= 1) {
        for (const sid of group.memberSessionIds) {
          const session = this.getSessionFn?.(sid);
          if (session) {
            session.groupId = undefined;
          }
        }
        this.groups.delete(id);
        this.save();
        this.saveSessionsFn?.();
        this.broadcastGroups();
        this.broadcastSessionsFn?.();
        log(
          `Auto-dissolved group "${group.name || id.slice(0, 8)}" (too few members)`,
        );
        return { ok: true, group, dissolved: true };
      }
    }

    this.save();
    this.saveSessionsFn?.();
    this.broadcastGroups();
    this.broadcastSessionsFn?.();

    log(
      `Updated group "${group.name || id.slice(0, 8)}" - ${group.memberSessionIds.length} members`,
    );
    return { ok: true, group };
  }

  /** Delete/dissolve a group */
  delete(id: string): boolean {
    const group = this.groups.get(id);
    if (!group) return false;

    // Clear groupId on all members
    for (const sid of group.memberSessionIds) {
      const session = this.getSessionFn?.(sid);
      if (session) {
        session.groupId = undefined;
      }
    }

    this.groups.delete(id);
    this.save();
    this.saveSessionsFn?.();
    this.broadcastGroups();
    this.broadcastSessionsFn?.();

    log(`Dissolved group "${group.name || id.slice(0, 8)}"`);
    return true;
  }

  /** Save groups to disk */
  private save(): void {
    try {
      const data = Array.from(this.groups.values());
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
      debug(`Saved ${this.groups.size} groups to ${this.filePath}`);
    } catch (e) {
      console.error("Failed to save groups:", e);
    }
  }

  /** Broadcast groups to all clients */
  private broadcastGroups(): void {
    if (this.broadcastFn) {
      this.broadcastFn({
        type: "zone_groups",
        payload: this.getAll(),
      });
    }
  }
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Org Graph — builds and maintains a model of the organisational structure,
// team relationships, reporting chains, and cross-functional dependencies.
// Cassidy uses this to route questions to the right people, understand
// escalation paths, and provide context-aware recommendations.
// ---------------------------------------------------------------------------

import { getGraphToken } from '../auth';
import { upsertEntity, getEntity, listEntities } from '../memory/tableStorage';

const TABLE = 'CassidyOrgGraph';
const PARTITION = 'org';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrgNode {
  partitionKey: string;
  rowKey: string;           // userId (sanitised)
  displayName: string;
  email: string;
  jobTitle: string;
  department: string;
  managerId: string;        // userId of direct manager
  managerName: string;
  directReports: string;    // JSON array of { id, name, title }
  teamMembers: string;      // JSON array of peer team member IDs
  expertise: string;        // JSON array of known expertise areas
  lastRefreshed: string;    // ISO timestamp
  [key: string]: unknown;
}

export interface TeamInfo {
  department: string;
  manager: { id: string; name: string; title: string };
  members: Array<{ id: string; name: string; title: string }>;
  headcount: number;
}

// ---------------------------------------------------------------------------
// Refresh org graph from Microsoft Graph
// ---------------------------------------------------------------------------

export async function refreshOrgGraph(): Promise<{ usersProcessed: number; errors: string[] }> {
  const errors: string[] = [];
  let usersProcessed = 0;

  try {
    const token = await getGraphToken();

    // Get all users with manager info
    let nextLink: string | null = `https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department&$top=100`;

    while (nextLink) {
      const res = await fetch(nextLink, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        errors.push(`Graph users API returned ${res.status}`);
        break;
      }

      const data = await res.json() as {
        value: Array<{
          id: string;
          displayName: string;
          mail?: string;
          userPrincipalName?: string;
          jobTitle?: string;
          department?: string;
        }>;
        '@odata.nextLink'?: string;
      };

      for (const user of data.value) {
        try {
          // Get manager for this user
          let managerId = '';
          let managerName = '';
          try {
            const managerRes = await fetch(
              `https://graph.microsoft.com/v1.0/users/${user.id}/manager?$select=id,displayName`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (managerRes.ok) {
              const mgr = await managerRes.json() as { id: string; displayName: string };
              managerId = mgr.id;
              managerName = mgr.displayName;
            }
          } catch (mgrErr) { console.debug(`[OrgGraph] No manager for ${user.displayName}:`, mgrErr); }

          // Get direct reports
          let directReports: Array<{ id: string; name: string; title: string }> = [];
          try {
            const reportsRes = await fetch(
              `https://graph.microsoft.com/v1.0/users/${user.id}/directReports?$select=id,displayName,jobTitle`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (reportsRes.ok) {
              const reportsData = await reportsRes.json() as { value: Array<{ id: string; displayName: string; jobTitle?: string }> };
              directReports = reportsData.value.map(r => ({
                id: r.id,
                name: r.displayName,
                title: r.jobTitle ?? '',
              }));
            }
          } catch (rptErr) { console.warn(`[OrgGraph] Failed to fetch direct reports for ${user.displayName}:`, rptErr); }

          const node: OrgNode = {
            partitionKey: PARTITION,
            rowKey: sanitiseKey(user.id),
            displayName: user.displayName,
            email: user.mail ?? user.userPrincipalName ?? '',
            jobTitle: user.jobTitle ?? '',
            department: user.department ?? '',
            managerId: sanitiseKey(managerId),
            managerName,
            directReports: JSON.stringify(directReports),
            teamMembers: '[]', // Populated in second pass
            expertise: '[]',
            lastRefreshed: new Date().toISOString(),
          };

          await upsertEntity(TABLE, node);
          usersProcessed++;
        } catch (err) {
          errors.push(`Failed to process ${user.displayName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      nextLink = data['@odata.nextLink'] ?? null;
    }

    // Second pass: populate team members (peers under same manager)
    const allNodes = await listEntities<OrgNode>(TABLE, PARTITION);
    const managerTeams = new Map<string, string[]>();
    for (const node of allNodes) {
      if (node.managerId) {
        const team = managerTeams.get(node.managerId) ?? [];
        team.push(node.rowKey);
        managerTeams.set(node.managerId, team);
      }
    }

    for (const node of allNodes) {
      if (node.managerId) {
        const peers = managerTeams.get(node.managerId)?.filter(id => id !== node.rowKey) ?? [];
        if (peers.length > 0) {
          await upsertEntity(TABLE, { ...node, teamMembers: JSON.stringify(peers) });
        }
      }
    }

    console.log(`[OrgGraph] Refreshed: ${usersProcessed} users, ${errors.length} errors`);
  } catch (err) {
    errors.push(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { usersProcessed, errors };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function getOrgNode(userId: string): Promise<OrgNode | null> {
  return getEntity<OrgNode>(TABLE, PARTITION, sanitiseKey(userId));
}

export async function getManager(userId: string): Promise<OrgNode | null> {
  const user = await getOrgNode(userId);
  if (!user?.managerId) return null;
  return getEntity<OrgNode>(TABLE, PARTITION, user.managerId);
}

export async function getDirectReports(userId: string): Promise<Array<{ id: string; name: string; title: string }>> {
  const user = await getOrgNode(userId);
  if (!user) return [];
  try {
    return JSON.parse(user.directReports) as Array<{ id: string; name: string; title: string }>;
  } catch {
    return [];
  }
}

export async function getTeamInfo(userId: string): Promise<TeamInfo | null> {
  const user = await getOrgNode(userId);
  if (!user) return null;

  const manager = user.managerId ? await getOrgNode(user.managerId) : null;
  const allNodes = await listEntities<OrgNode>(TABLE, PARTITION);
  const teamMembers = allNodes
    .filter(n => n.managerId === user.managerId && n.rowKey !== user.rowKey)
    .map(n => ({ id: n.rowKey, name: n.displayName, title: n.jobTitle }));

  return {
    department: user.department,
    manager: manager
      ? { id: manager.rowKey, name: manager.displayName, title: manager.jobTitle }
      : { id: '', name: 'Unknown', title: '' },
    members: teamMembers,
    headcount: teamMembers.length + 1, // Include the user
  };
}

export async function getEscalationChain(userId: string, maxDepth = 5): Promise<Array<{ id: string; name: string; title: string }>> {
  const chain: Array<{ id: string; name: string; title: string }> = [];
  let currentId = userId;

  for (let i = 0; i < maxDepth; i++) {
    const user = await getOrgNode(currentId);
    if (!user?.managerId) break;

    const manager = await getOrgNode(user.managerId);
    if (!manager) break;

    chain.push({ id: manager.rowKey, name: manager.displayName, title: manager.jobTitle });
    currentId = manager.rowKey;
  }

  return chain;
}

export async function findExpertise(area: string): Promise<Array<{ id: string; name: string; title: string; department: string }>> {
  const allNodes = await listEntities<OrgNode>(TABLE, PARTITION);
  const results: Array<{ id: string; name: string; title: string; department: string }> = [];
  const lowerArea = area.toLowerCase();

  for (const node of allNodes) {
    try {
      const expertise = JSON.parse(node.expertise) as string[];
      if (expertise.some(e => e.toLowerCase().includes(lowerArea))) {
        results.push({ id: node.rowKey, name: node.displayName, title: node.jobTitle, department: node.department });
      }
    } catch (parseErr) { console.debug(`[OrgGraph] Failed to parse expertise for ${node.displayName}:`, parseErr); }

    // Also check job title
    if (node.jobTitle.toLowerCase().includes(lowerArea)) {
      if (!results.some(r => r.id === node.rowKey)) {
        results.push({ id: node.rowKey, name: node.displayName, title: node.jobTitle, department: node.department });
      }
    }
  }

  return results;
}

export async function getDepartmentSummary(): Promise<Array<{ department: string; headcount: number; managers: string[] }>> {
  const allNodes = await listEntities<OrgNode>(TABLE, PARTITION);
  const deptMap = new Map<string, { headcount: number; managers: Set<string> }>();

  for (const node of allNodes) {
    const dept = node.department || 'Unknown';
    const entry = deptMap.get(dept) ?? { headcount: 0, managers: new Set<string>() };
    entry.headcount++;

    // If this person has direct reports, they're a manager
    const reports = JSON.parse(node.directReports || '[]') as unknown[];
    if (reports.length > 0) {
      entry.managers.add(node.displayName);
    }

    deptMap.set(dept, entry);
  }

  return [...deptMap.entries()].map(([department, info]) => ({
    department,
    headcount: info.headcount,
    managers: [...info.managers],
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitiseKey(key: string): string {
  return key.replace(/[/\\#?]/g, '_').slice(0, 200);
}

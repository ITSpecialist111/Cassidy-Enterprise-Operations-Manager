// ---------------------------------------------------------------------------
// Tool Result Cache — avoids redundant Graph/MCP calls within short windows
// ---------------------------------------------------------------------------
// Frequently called tools (get_planner_tasks, get_calendar_events, etc.) often
// return identical data within a few seconds. This cache deduplicates those calls.
// ---------------------------------------------------------------------------

import { LruCache } from './lruCache';
import { logger } from './logger';

/** Default TTL — 60 seconds */
const DEFAULT_TOOL_CACHE_TTL_MS = Number(process.env.TOOL_CACHE_TTL_MS) || 60_000;

/** Tools whose results are safe to cache (idempotent, read-only) */
const CACHEABLE_TOOLS = new Set([
  'get_planner_tasks',
  'get_planner_task_details',
  'get_team_members',
  'get_calendar_events',
  'get_user_emails',
  'get_overdue_tasks',
  'check_project_status',
  'get_channel_messages',
  'mcp_CalendarServer_get_calendar_events',
  'mcp_PlannerServer_list_planner_tasks',
  'mcp_MailServer_list_mail_messages',
  'mcp_TeamsServer_list_channels',
  'mcp_SharePointServer_list_sites',
  'mcp_OneDriveServer_list_files',
]);

const cache = new LruCache<string>(500, DEFAULT_TOOL_CACHE_TTL_MS);

function buildCacheKey(toolName: string, params: Record<string, unknown>): string {
  const sortedParams = JSON.stringify(params, Object.keys(params).sort());
  return `${toolName}:${sortedParams}`;
}

/**
 * Check if a cached result exists for this tool call.
 * Returns the cached result string or undefined.
 */
export function getCachedToolResult(toolName: string, params: Record<string, unknown>): string | undefined {
  if (!CACHEABLE_TOOLS.has(toolName)) return undefined;
  const key = buildCacheKey(toolName, params);
  const hit = cache.get(key);
  if (hit !== undefined) {
    logger.debug('Tool cache hit', { module: 'toolCache', toolName });
  }
  return hit;
}

/**
 * Store a tool result in the cache.
 */
export function cacheToolResult(toolName: string, params: Record<string, unknown>, result: string): void {
  if (!CACHEABLE_TOOLS.has(toolName)) return;
  const key = buildCacheKey(toolName, params);
  cache.set(key, result);
}

/** Check whether a tool name is in the cacheable set */
export function isCacheableTool(toolName: string): boolean {
  return CACHEABLE_TOOLS.has(toolName);
}

/** Clear the entire tool cache */
export function clearToolCache(): void {
  cache.clear();
}

/** Current number of cached entries */
export function getToolCacheSize(): number {
  return cache.size;
}

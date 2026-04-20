// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Goal decomposer — uses GPT-5 to break a complex user goal into ordered subtasks.

import type { Subtask } from '../workQueue/workQueue';
import { getSharedOpenAI } from '../auth';
import { config as appConfig } from '../featureConfig';

function getOpenAI() {
  return getSharedOpenAI();
}

const DECOMPOSE_PROMPT = `You are Cassidy, an autonomous Operations Manager AI.
A user has given you a complex goal. Break it into the minimum number of ordered, concrete subtasks.

Rules:
- Each subtask must map to a single tool call or a single discrete action (find user, send email, create task, etc.)
- Identify dependencies — if subtask B needs the result of subtask A, set dependsOn: ["<A.id>"]
- Include a toolHint if applicable: findUser, sendEmail, createPlannerTask, sendTeamsMessage, scheduleCalendarEvent, readSharePointList, getOverdueTasks, getPendingApprovals
- Keep descriptions action-oriented and specific
- Maximum 10 subtasks. If the goal is simple (1-2 steps), return 1-2 subtasks.
- Return ONLY a valid JSON object with a "subtasks" array — no markdown, no explanation.

Format:
{
  "subtasks": [
    { "id": "s1", "description": "...", "toolHint": "...", "dependsOn": [] },
    { "id": "s2", "description": "...", "toolHint": "...", "dependsOn": ["s1"] }
  ]
}`;

export async function decomposeGoal(goal: string): Promise<Subtask[]> {
  const openai = getOpenAI();
  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), appConfig.goalDecomposeTimeoutMs);
    const response = await openai.chat.completions.create(
      {
        model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5',
        messages: [
          { role: 'system', content: DECOMPOSE_PROMPT },
          { role: 'user', content: goal },
        ],
        // GPT-5 reasoning models consume a large chunk of the budget for hidden
        // reasoning tokens. 1000 was empirically too small (decomposer returned
        // empty output, JSON.parse threw 'Unexpected end of JSON input').
        max_completion_tokens: 4000,
        response_format: { type: 'json_object' },
      },
      { signal: controller.signal },
    );
    clearTimeout(timeoutHandle);

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    if (!raw) {
      console.warn('[GoalDecomposer] LLM returned empty content; falling back to single-subtask plan');
      return [{ id: 's1', description: goal, dependsOn: [], status: 'pending' }];
    }
    // Strip markdown code fences if present (defensive — response_format=json_object should prevent this)
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    // response_format=json_object returns an object, not an array. Accept either.
    const parsedRaw = JSON.parse(json);
    const arr = Array.isArray(parsedRaw)
      ? parsedRaw
      : Array.isArray((parsedRaw as { subtasks?: unknown }).subtasks)
        ? (parsedRaw as { subtasks: unknown[] }).subtasks
        : Array.isArray((parsedRaw as { steps?: unknown }).steps)
          ? (parsedRaw as { steps: unknown[] }).steps
          : Array.isArray((parsedRaw as { plan?: unknown }).plan)
            ? (parsedRaw as { plan: unknown[] }).plan
            : [];
    const parsed = arr as Array<{
      id: string;
      description: string;
      toolHint?: string;
      dependsOn?: string[];
    }>;

    return parsed.map(s => ({
      id: s.id,
      description: s.description,
      toolHint: s.toolHint,
      dependsOn: s.dependsOn ?? [],
      status: 'pending' as const,
    }));
  } catch (err) {
    console.error('[GoalDecomposer] Failed to decompose goal:', err);
    // Fallback: single subtask = the whole goal
    return [{ id: 's1', description: goal, dependsOn: [], status: 'pending' }];
  }
}

// Heuristic: is this goal complex enough to need autonomous execution?
// Simple Q&A / single-step requests are answered directly.
export function isComplexGoal(message: string): boolean {
  const complexPatterns = [
    /run.*(process|workflow|review|audit|onboard)/i,
    /follow.?up.*(every|daily|weekly|until)/i,
    /monitor.*(and.*(alert|notify|escalate|report))/i,
    /chase|escalate|remind.*(every|daily|tomorrow|next week)/i,
    /set up|organise|coordinate.*(meeting|review|process)/i,
    /make sure|ensure.*(complete|done|signed off|approved)/i,
    /every (day|morning|week|monday)/i,
    /until (approved|complete|done|resolved)/i,
  ];
  return complexPatterns.some(p => p.test(message));
}

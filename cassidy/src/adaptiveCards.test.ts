// ---------------------------------------------------------------------------
// Tests — Adaptive Card builder
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  buildTaskListCard,
  buildStatusCard,
  buildApprovalCard,
  buildReportCard,
  buildHealthCard,
  tryBuildCardFromReply,
} from './adaptiveCards';

describe('buildTaskListCard', () => {
  it('produces valid Adaptive Card structure', () => {
    const card = buildTaskListCard('My Tasks', [
      { name: 'Fix bug', status: 'in progress', assignee: 'Alice' },
      { name: 'Ship feature', status: 'done', dueDate: '2026-03-30' },
    ]);

    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.type).toBe('AdaptiveCard');
    expect(card.content.version).toBe('1.5');
    expect(card.content.body.length).toBeGreaterThan(0);
  });

  it('includes status icons', () => {
    const card = buildTaskListCard('Tasks', [
      { name: 'Task A', status: 'complete' },
      { name: 'Task B', status: 'overdue' },
      { name: 'Task C', status: 'in progress' },
    ]);
    const json = JSON.stringify(card.content);
    expect(json).toContain('✅');
    expect(json).toContain('🔴');
    expect(json).toContain('🔄');
  });

  it('truncates to 10 items with overflow message', () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({ name: `Task ${i}`, status: 'pending' }));
    const card = buildTaskListCard('Big List', tasks);
    const json = JSON.stringify(card.content);
    expect(json).toContain('and 5 more');
  });
});

describe('buildStatusCard', () => {
  it('produces fact set with label/value pairs', () => {
    const card = buildStatusCard('Status', [
      { label: 'Users', value: '42' },
      { label: 'Uptime', value: '99.9%' },
    ]);

    expect(card.content.type).toBe('AdaptiveCard');
    const json = JSON.stringify(card.content);
    expect(json).toContain('Users');
    expect(json).toContain('99.9%');
  });

  it('applies accent color', () => {
    const card = buildStatusCard('Warning', [{ label: 'Errors', value: '5' }], 'attention');
    const json = JSON.stringify(card.content);
    expect(json).toContain('attention');
  });
});

describe('buildApprovalCard', () => {
  it('includes approve and reject actions', () => {
    const card = buildApprovalCard('Budget Request', 'Need $10k for hardware', [
      { label: 'Amount', value: '$10,000' },
    ], 'apr-123');

    expect(card.content.actions).toHaveLength(2);
    expect(card.content.actions![0].title).toContain('Approve');
    expect(card.content.actions![1].title).toContain('Reject');
  });

  it('embeds approval ID in action data', () => {
    const card = buildApprovalCard('Test', 'Desc', [], 'apr-456');
    const approveAction = card.content.actions![0];
    expect((approveAction as { data: { approvalId: string } }).data.approvalId).toBe('apr-456');
  });
});

describe('buildReportCard', () => {
  it('includes title, subtitle, and body', () => {
    const card = buildReportCard('Weekly Report', 'Week of Mar 20', 'All systems green.');
    const json = JSON.stringify(card.content);
    expect(json).toContain('Weekly Report');
    expect(json).toContain('Week of Mar 20');
    expect(json).toContain('All systems green');
  });

  it('adds link action when URL provided', () => {
    const card = buildReportCard('Report', 'Sub', 'Body', 'https://example.com/report');
    expect(card.content.actions).toHaveLength(1);
    expect((card.content.actions![0] as { url: string }).url).toBe('https://example.com/report');
  });

  it('omits actions when no URL', () => {
    const card = buildReportCard('Report', 'Sub', 'Body');
    expect(card.content.actions).toBeUndefined();
  });
});

describe('buildHealthCard', () => {
  it('shows green for healthy', () => {
    const card = buildHealthCard('healthy', { uptime: '2d', tests: 314 });
    const json = JSON.stringify(card.content);
    expect(json).toContain('System Healthy');
    expect(json).toContain('good');
  });

  it('shows red for degraded', () => {
    const card = buildHealthCard('degraded', { errors: 5 });
    const json = JSON.stringify(card.content);
    expect(json).toContain('System Degraded');
    expect(json).toContain('attention');
  });
});

describe('tryBuildCardFromReply', () => {
  it('returns null for short replies', () => {
    expect(tryBuildCardFromReply('Hello!')).toBeNull();
  });

  it('returns null for medium replies without patterns', () => {
    expect(tryBuildCardFromReply('A'.repeat(250))).toBeNull();
  });

  it('builds task card from numbered list with status keywords', () => {
    const reply = `Here are the overdue tasks:\n\n` +
      `1. Update documentation - overdue\n` +
      `2. Fix deployment pipeline - in progress\n` +
      `3. Review PR #42 - blocked\n` +
      `4. Ship v2.0 release - complete\n\n` +
      `Let me know if you need help with any of these.`;

    const card = tryBuildCardFromReply(reply);
    expect(card).not.toBeNull();
    expect(card!.contentType).toBe('application/vnd.microsoft.card.adaptive');
  });
});

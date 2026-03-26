// ---------------------------------------------------------------------------
// Adaptive Card Builder — rich Teams card responses
// ---------------------------------------------------------------------------
// Produces Adaptive Card JSON payloads for Teams. The agent can return
// these instead of plain text for structured content like task lists,
// approval requests, reports, and status summaries.
// ---------------------------------------------------------------------------

export interface AdaptiveCardAttachment {
  contentType: 'application/vnd.microsoft.card.adaptive';
  content: AdaptiveCard;
}

interface AdaptiveCard {
  $schema: string;
  type: 'AdaptiveCard';
  version: string;
  body: AdaptiveElement[];
  actions?: AdaptiveAction[];
}

type AdaptiveElement =
  | TextBlock
  | FactSet
  | ColumnSet
  | Container
  | ImageBlock;

interface TextBlock {
  type: 'TextBlock';
  text: string;
  size?: 'Small' | 'Default' | 'Medium' | 'Large' | 'ExtraLarge';
  weight?: 'Default' | 'Lighter' | 'Bolder';
  color?: 'Default' | 'Dark' | 'Light' | 'Accent' | 'Good' | 'Warning' | 'Attention';
  wrap?: boolean;
  separator?: boolean;
  spacing?: 'None' | 'Small' | 'Default' | 'Medium' | 'Large' | 'ExtraLarge';
}

interface Fact {
  title: string;
  value: string;
}

interface FactSet {
  type: 'FactSet';
  facts: Fact[];
  separator?: boolean;
}

interface Column {
  type: 'Column';
  width: string;
  items: AdaptiveElement[];
}

interface ColumnSet {
  type: 'ColumnSet';
  columns: Column[];
  separator?: boolean;
}

interface Container {
  type: 'Container';
  items: AdaptiveElement[];
  style?: 'default' | 'emphasis' | 'good' | 'attention' | 'warning' | 'accent';
  separator?: boolean;
}

interface ImageBlock {
  type: 'Image';
  url: string;
  size?: 'Small' | 'Medium' | 'Large';
  altText?: string;
}

type AdaptiveAction = ActionOpenUrl | ActionSubmit;

interface ActionOpenUrl {
  type: 'Action.OpenUrl';
  title: string;
  url: string;
}

interface ActionSubmit {
  type: 'Action.Submit';
  title: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Card factory helpers
// ---------------------------------------------------------------------------

function makeCard(body: AdaptiveElement[], actions?: AdaptiveAction[]): AdaptiveCard {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
    ...(actions?.length ? { actions } : {}),
  };
}

function wrapAttachment(card: AdaptiveCard): AdaptiveCardAttachment {
  return { contentType: 'application/vnd.microsoft.card.adaptive', content: card };
}

// ---------------------------------------------------------------------------
// Public card builders
// ---------------------------------------------------------------------------

/** Task list card — shows a list of tasks with status indicators */
export function buildTaskListCard(
  title: string,
  tasks: Array<{ name: string; assignee?: string; status: string; dueDate?: string }>,
): AdaptiveCardAttachment {
  const statusIcon = (s: string): string => {
    const lower = s.toLowerCase();
    if (lower.includes('done') || lower.includes('complete')) return '✅';
    if (lower.includes('progress') || lower.includes('active')) return '🔄';
    if (lower.includes('overdue') || lower.includes('blocked')) return '🔴';
    return '⬜';
  };

  const body: AdaptiveElement[] = [
    { type: 'TextBlock', text: title, size: 'Large', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: `${tasks.length} item(s)`, size: 'Small', color: 'Dark', spacing: 'None' },
  ];

  for (const task of tasks.slice(0, 10)) {
    body.push({
      type: 'ColumnSet',
      separator: true,
      columns: [
        { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: statusIcon(task.status), wrap: false }] },
        { type: 'Column', width: 'stretch', items: [
          { type: 'TextBlock', text: task.name, weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text: [task.assignee, task.dueDate].filter(Boolean).join(' · '), size: 'Small', color: 'Dark', wrap: true, spacing: 'None' },
        ]},
      ],
    });
  }

  if (tasks.length > 10) {
    body.push({ type: 'TextBlock', text: `_...and ${tasks.length - 10} more_`, size: 'Small', color: 'Dark', wrap: true });
  }

  return wrapAttachment(makeCard(body));
}

/** Status summary card — key-value pairs with a header */
export function buildStatusCard(
  title: string,
  facts: Array<{ label: string; value: string }>,
  accentColor?: 'good' | 'attention' | 'warning',
): AdaptiveCardAttachment {
  const body: AdaptiveElement[] = [
    { type: 'TextBlock', text: title, size: 'Large', weight: 'Bolder', wrap: true },
    {
      type: 'Container',
      style: accentColor ?? 'default',
      items: [{
        type: 'FactSet',
        facts: facts.map(f => ({ title: f.label, value: f.value })),
      }],
    },
  ];

  return wrapAttachment(makeCard(body));
}

/** Approval request card — with Approve / Reject action buttons */
export function buildApprovalCard(
  title: string,
  description: string,
  facts: Array<{ label: string; value: string }>,
  approvalId: string,
): AdaptiveCardAttachment {
  const body: AdaptiveElement[] = [
    { type: 'TextBlock', text: '✅ Approval Request', size: 'Small', color: 'Accent', weight: 'Bolder' },
    { type: 'TextBlock', text: title, size: 'Large', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: description, wrap: true },
    { type: 'FactSet', facts: facts.map(f => ({ title: f.label, value: f.value })), separator: true },
  ];

  const actions: AdaptiveAction[] = [
    { type: 'Action.Submit', title: '✅ Approve', data: { action: 'approve', approvalId } },
    { type: 'Action.Submit', title: '❌ Reject', data: { action: 'reject', approvalId } },
  ];

  return wrapAttachment(makeCard(body, actions));
}

/** Report card — summary header with body text */
export function buildReportCard(
  title: string,
  subtitle: string,
  bodyText: string,
  linkUrl?: string,
): AdaptiveCardAttachment {
  const body: AdaptiveElement[] = [
    { type: 'TextBlock', text: '📊 Report', size: 'Small', color: 'Accent', weight: 'Bolder' },
    { type: 'TextBlock', text: title, size: 'Large', weight: 'Bolder', wrap: true },
    { type: 'TextBlock', text: subtitle, size: 'Small', color: 'Dark', wrap: true, spacing: 'None' },
    { type: 'TextBlock', text: bodyText, wrap: true, separator: true },
  ];

  const actions: AdaptiveAction[] = [];
  if (linkUrl) {
    actions.push({ type: 'Action.OpenUrl', title: 'View Full Report', url: linkUrl });
  }

  return wrapAttachment(makeCard(body, actions));
}

/** Health / system status card */
export function buildHealthCard(
  status: string,
  details: Record<string, string | number | boolean>,
): AdaptiveCardAttachment {
  const isHealthy = status.toLowerCase() === 'healthy';

  const body: AdaptiveElement[] = [
    {
      type: 'Container',
      style: isHealthy ? 'good' : 'attention',
      items: [
        { type: 'TextBlock', text: isHealthy ? '🟢 System Healthy' : '🔴 System Degraded', size: 'Large', weight: 'Bolder', color: 'Default' },
      ],
    },
    {
      type: 'FactSet',
      facts: Object.entries(details).map(([k, v]) => ({ title: k, value: String(v) })),
    },
  ];

  return wrapAttachment(makeCard(body));
}

/**
 * Detect whether the agent's reply would benefit from an Adaptive Card
 * and build the appropriate card. Returns null if plain text is fine.
 */
export function tryBuildCardFromReply(reply: string): AdaptiveCardAttachment | null {
  // Don't card-ify short or simple replies
  if (reply.length < 200) return null;

  // Detect task lists (numbered lists with status-like keywords)
  const taskListPattern = /^\d+\.\s+.*(overdue|blocked|in progress|complete|done|pending)/im;
  if (taskListPattern.test(reply)) {
    const lines = reply.split('\n').filter(l => /^\d+\.\s+/.test(l.trim()));
    if (lines.length >= 3) {
      const tasks = lines.map(l => {
        const text = l.replace(/^\d+\.\s+/, '').trim();
        const status = /overdue|blocked/i.test(text) ? 'overdue' :
                       /in progress|active/i.test(text) ? 'in progress' :
                       /complete|done/i.test(text) ? 'complete' : 'pending';
        return { name: text, status };
      });
      return buildTaskListCard('Task Summary', tasks);
    }
  }

  return null;
}

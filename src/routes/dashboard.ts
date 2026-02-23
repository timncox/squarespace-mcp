import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../db/database.js';
import { getTask, getAllTasks, updateTaskStatus } from '../db/tasks.js';
import { getAuditLog } from '../db/audit-log.js';
import { getAllActiveLearnings } from '../db/learnings.js';
import { getAgentEventsByTask, getRecentAgentEvents } from '../db/agent-events.js';
import { getMessagesByConversation, getRecentMessages } from '../db/whatsapp-messages.js';
import { getActiveConversation, getActiveConversations, getInteractiveConversations, getConversation } from '../db/conversations.js';
import { handleIncomingMessage } from '../services/conversation-handler.js';
import { executionQueue } from '../services/execution-queue.js';
import { dashboardEvents } from '../services/dashboard-events.js';
import type { DashboardEvent } from '../services/dashboard-events.js';
import type { IncomingWhatsAppMessage } from '../services/whatsapp.js';
import type { Task, TaskStatus } from '../models/task.js';
import type { Learning } from '../db/learnings.js';
import type { AuditEntry } from '../db/audit-log.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extractPdfText } from '../services/pdf-extractor.js';
import { logger } from '../utils/logger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusBadge(status: TaskStatus): string {
  const colors: Record<TaskStatus, string> = {
    pending: '#eab308',
    confirmed: '#3b82f6',
    executing: '#8b5cf6',
    done: '#22c55e',
    failed: '#ef4444',
  };
  const color = colors[status] ?? '#6b7280';
  return `<span class="badge" style="background:${color}">${escapeHtml(status)}</span>`;
}

function confidenceBadge(confidence: number): string {
  const pct = Math.round(confidence * 100);
  const color = pct >= 70 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444';
  return `<span class="badge" style="background:${color}">${pct}%</span>`;
}

// ─── Layout Shell ───────────────────────────────────────────────────────────

function layout(title: string, activeTab: string, body: string): string {
  const tabs = [
    { id: 'tasks', label: 'Tasks', href: '/dashboard' },
    { id: 'clients', label: 'Clients', href: '/dashboard/clients' },
    { id: 'agents', label: 'Agents', href: '/dashboard/agents' },
    { id: 'learnings', label: 'Learnings', href: '/dashboard/learnings' },
    { id: 'chat', label: 'Chat', href: '/dashboard/chat' },
  ];

  const nav = tabs
    .map(
      (t) =>
        `<a href="${t.href}" class="tab ${t.id === activeTab ? 'active' : ''}">${t.label}</a>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — SQ Helper</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.5; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .shell { max-width: 1200px; margin: 0 auto; padding: 1rem; }
    .header { display: flex; align-items: center; gap: 1.5rem; padding: 1rem 0; border-bottom: 1px solid #1e293b; margin-bottom: 1.5rem; }
    .header h1 { font-size: 1.25rem; font-weight: 600; color: #f1f5f9; white-space: nowrap; }
    .nav { display: flex; gap: 0.25rem; }
    .tab { padding: 0.5rem 1rem; border-radius: 0.5rem; color: #94a3b8; font-weight: 500; font-size: 0.875rem; transition: all 0.15s; }
    .tab:hover { background: #1e293b; color: #e2e8f0; text-decoration: none; }
    .tab.active { background: #1e293b; color: #60a5fa; }

    .card { background: #1e293b; border-radius: 0.75rem; padding: 1.25rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #f1f5f9; }

    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
    .stat { background: #1e293b; border-radius: 0.75rem; padding: 1rem; text-align: center; }
    .stat .value { font-size: 1.75rem; font-weight: 700; color: #f1f5f9; }
    .stat .label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.25rem; }

    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { text-align: left; padding: 0.625rem 0.75rem; color: #94a3b8; font-weight: 500; border-bottom: 1px solid #334155; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.625rem 0.75rem; border-bottom: 1px solid #1e293b; vertical-align: top; }
    tr:hover td { background: rgba(255,255,255,0.02); }

    .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; color: #fff; }
    .mono { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 0.8125rem; color: #94a3b8; }
    .truncate { max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: #64748b; }
    .small { font-size: 0.8125rem; }

    .btn { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.375rem 0.75rem; border-radius: 0.375rem; font-size: 0.8125rem; font-weight: 500; border: none; cursor: pointer; transition: all 0.15s; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-danger:hover { background: #dc2626; }
    .btn-ghost { background: transparent; color: #94a3b8; border: 1px solid #334155; }
    .btn-ghost:hover { background: #1e293b; color: #e2e8f0; }

    .detail-grid { display: grid; grid-template-columns: 160px 1fr; gap: 0.5rem 1rem; font-size: 0.875rem; }
    .detail-grid dt { color: #94a3b8; font-weight: 500; }
    .detail-grid dd { color: #e2e8f0; }

    .audit-timeline { position: relative; padding-left: 1.5rem; }
    .audit-timeline::before { content: ''; position: absolute; left: 0.375rem; top: 0; bottom: 0; width: 2px; background: #334155; }
    .audit-item { position: relative; margin-bottom: 0.75rem; }
    .audit-item::before { content: ''; position: absolute; left: -1.25rem; top: 0.5rem; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #60a5fa; }
    .audit-item .time { font-size: 0.75rem; color: #64748b; }
    .audit-item .action { font-weight: 500; color: #e2e8f0; }
    .audit-item .details { font-size: 0.8125rem; color: #94a3b8; margin-top: 0.125rem; }

    .polarity-positive { color: #22c55e; }
    .polarity-negative { color: #ef4444; }

    .empty-state { text-align: center; padding: 3rem 1rem; color: #64748b; }
    .empty-state .icon { font-size: 2rem; margin-bottom: 0.5rem; }

    .filters { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .filter-btn { padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; border: 1px solid #334155; background: transparent; color: #94a3b8; cursor: pointer; text-decoration: none; }
    .filter-btn:hover { background: #1e293b; color: #e2e8f0; text-decoration: none; }
    .filter-btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }

    @media (max-width: 768px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .detail-grid { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <h1>SQ Helper</h1>
      <nav class="nav">${nav}</nav>
    </div>
    ${body}
  </div>
</body>
</html>`;
}

// ─── Data Queries ───────────────────────────────────────────────────────────

interface TaskStats {
  total: number;
  pending: number;
  executing: number;
  done: number;
  failed: number;
}

function getTaskStats(): TaskStats {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('pending','confirmed') THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'executing' THEN 1 ELSE 0 END) as executing,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks`,
    )
    .get() as Record<string, number>;
  return {
    total: row.total ?? 0,
    pending: row.pending ?? 0,
    executing: row.executing ?? 0,
    done: row.done ?? 0,
    failed: row.failed ?? 0,
  };
}

interface ClientSummary {
  clientName: string;
  siteId: string;
  totalTasks: number;
  lastTaskAt: string;
  doneCount: number;
  failedCount: number;
}

function getClientSummaries(): ClientSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        client_name,
        site_id,
        COUNT(*) as total_tasks,
        MAX(created_at) as last_task_at,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM tasks
      GROUP BY client_name, site_id
      ORDER BY last_task_at DESC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((r) => ({
    clientName: r.client_name as string,
    siteId: r.site_id as string,
    totalTasks: r.total_tasks as number,
    lastTaskAt: r.last_task_at as string,
    doneCount: r.done_count as number,
    failedCount: r.failed_count as number,
  }));
}

function getFilteredTasks(status?: string, limit = 50): Task[] {
  const db = getDb();
  if (status && status !== 'all') {
    const rows = db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, limit) as Record<string, unknown>[];
    return rows.map(rowToTaskQuick);
  }
  return getAllTasks(limit);
}

/** Quick row mapper (duplicated from tasks.ts to avoid circular issues) */
function rowToTaskQuick(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    taskType: row.task_type as Task['taskType'],
    clientName: row.client_name as string,
    siteId: row.site_id as string,
    targetPage: row.target_page as string | undefined,
    contentToFind: row.content_to_find as string | undefined,
    contentToAdd: row.content_to_add as string | undefined,
    attachmentFilename: row.attachment_filename as string | undefined,
    attachmentPath: row.attachment_path as string | undefined,
    description: row.description as string | undefined,
    applyToAllSites: (row.apply_to_all_sites as number) === 1,
    groupId: row.group_id as string | undefined,
    needsClarification: (row.needs_clarification as number) === 1,
    clarificationQuestion: row.clarification_question as string | undefined,
    status: row.status as TaskStatus,
    errorMessage: row.error_message as string | undefined,
    screenshotPath: row.screenshot_path as string | undefined,
    referenceImagePath: row.reference_image_path as string | undefined,
    originalContent: row.original_content as string | undefined,
    attemptCount: (row.attempt_count as number) ?? 0,
    lastError: row.last_error as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ─── Page Renderers ─────────────────────────────────────────────────────────

function renderTasksPage(tasks: Task[], stats: TaskStats, statusFilter: string): string {
  const statsHtml = `
    <div class="stats-row">
      <div class="stat"><div class="value">${stats.total}</div><div class="label">Total</div></div>
      <div class="stat"><div class="value" style="color:#eab308">${stats.pending}</div><div class="label">Pending</div></div>
      <div class="stat"><div class="value" style="color:#8b5cf6">${stats.executing}</div><div class="label">Executing</div></div>
      <div class="stat"><div class="value" style="color:#22c55e">${stats.done}</div><div class="label">Done</div></div>
      <div class="stat"><div class="value" style="color:#ef4444">${stats.failed}</div><div class="label">Failed</div></div>
    </div>`;

  const filterOptions = ['all', 'pending', 'confirmed', 'executing', 'done', 'failed'];
  const filtersHtml = `
    <div class="filters">
      ${filterOptions.map((f) => `<a href="/dashboard?status=${f}" class="filter-btn ${f === statusFilter ? 'active' : ''}">${f}</a>`).join('')}
    </div>`;

  if (tasks.length === 0) {
    return statsHtml + filtersHtml + `<div class="empty-state"><div class="icon">📋</div><p>No tasks found</p></div>`;
  }

  const rows = tasks
    .map(
      (t) => `
      <tr>
        <td class="small muted">${timeAgo(t.createdAt)}</td>
        <td><a href="/dashboard/tasks/${escapeHtml(t.id)}">${escapeHtml(t.clientName)}</a></td>
        <td class="truncate">${escapeHtml(t.description || t.taskType)}</td>
        <td>${escapeHtml(t.targetPage || '—')}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="small muted">${t.attemptCount > 0 ? `${t.attemptCount} retries` : '—'}</td>
      </tr>`,
    )
    .join('');

  return `
    ${statsHtml}
    ${filtersHtml}
    <div class="card">
      <table>
        <thead><tr><th>Time</th><th>Client</th><th>Summary</th><th>Page</th><th>Status</th><th>Retries</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderTaskDetailPage(task: Task, auditEntries: AuditEntry[]): string {
  const desc = task.description || task.taskType;

  const detailGrid = `
    <div class="card">
      <h2>Task Details</h2>
      <dl class="detail-grid">
        <dt>ID</dt><dd class="mono">${escapeHtml(task.id.slice(0, 8))}…</dd>
        <dt>Type</dt><dd>${escapeHtml(task.taskType)}</dd>
        <dt>Client</dt><dd>${escapeHtml(task.clientName)}</dd>
        <dt>Site</dt><dd class="mono">${escapeHtml(task.siteId)}</dd>
        <dt>Target Page</dt><dd>${escapeHtml(task.targetPage || '—')}</dd>
        <dt>Status</dt><dd id="task-status-badge">${statusBadge(task.status)}</dd>
        <dt>Attempts</dt><dd>${task.attemptCount}</dd>
        <dt>Created</dt><dd>${escapeHtml(task.createdAt)}</dd>
        <dt>Updated</dt><dd>${escapeHtml(task.updatedAt)}</dd>
      </dl>
    </div>`;

  const descCard = `
    <div class="card">
      <h2>Description</h2>
      <p class="small">${escapeHtml(desc)}</p>
      ${task.contentToFind ? `<p class="small muted" style="margin-top:0.5rem">Find: "${escapeHtml(task.contentToFind)}"</p>` : ''}
      ${task.contentToAdd ? `<p class="small muted">Add: "${escapeHtml(task.contentToAdd)}"</p>` : ''}
    </div>`;

  // Live progress card — visible when task is executing, updated via SSE
  const isLive = task.status !== 'done' && task.status !== 'failed';
  const progressCard = `
    <div class="card" id="activity-card" style="display:${isLive ? 'block' : 'none'}">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.75rem;">
        <h2 style="margin:0">Agent Activity</h2>
        <span id="activity-phase" class="badge" style="background:#334155; color:#e2e8f0; font-size:0.8rem; padding:0.25rem 0.6rem; border-radius:0.375rem;">
          ${task.status === 'executing' ? 'Executing' : 'Waiting'}
        </span>
      </div>
      <div id="activity-log" style="max-height:160px; overflow-y:auto; font-size:0.8rem; font-family:'SF Mono',SFMono-Regular,Consolas,monospace; background:#0d0d14; border-radius:0.375rem; padding:0.5rem;">
        <div class="muted" style="text-align:center; padding:0.5rem;">Waiting for agent activity\u2026</div>
      </div>
    </div>

    <div class="card" id="progress-card" style="display:${task.status === 'executing' ? 'block' : 'none'}">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.75rem;">
        <h2 style="margin:0">Browser Agent</h2>
        <span id="progress-badge" class="badge" style="background:#7c3aed; color:#fff; font-size:0.8rem; padding:0.25rem 0.6rem; border-radius:0.375rem;">
          Step 0/0
        </span>
      </div>
      <div style="background:#1e1e2e; border-radius:0.375rem; height:0.5rem; overflow:hidden; margin-bottom:0.75rem;">
        <div id="progress-bar" style="height:100%; width:0%; background:#7c3aed; transition:width 0.3s ease;"></div>
      </div>
      <div id="progress-screenshot" style="display:none; margin-bottom:0.75rem;">
        <img id="progress-img" src="" alt="Latest agent screenshot"
             style="max-width:100%; border-radius:0.375rem; border:1px solid #333;">
      </div>
      <div id="step-log" style="max-height:200px; overflow-y:auto; font-size:0.75rem; font-family:monospace; background:#0d0d14; border-radius:0.375rem; padding:0.5rem;">
        <div class="muted" style="text-align:center; padding:0.5rem;">Waiting for agent steps\u2026</div>
      </div>
    </div>

    <script>
    (function() {
      var taskId = '${escapeHtml(task.id)}';
      var taskStatus = '${escapeHtml(task.status)}';

      // Activity card elements
      var actCard = document.getElementById('activity-card');
      var actPhase = document.getElementById('activity-phase');
      var actLog = document.getElementById('activity-log');
      var actFirstEntry = true;

      // Progress card elements
      var card = document.getElementById('progress-card');
      var badge = document.getElementById('progress-badge');
      var bar = document.getElementById('progress-bar');
      var ssDiv = document.getElementById('progress-screenshot');
      var ssImg = document.getElementById('progress-img');
      var log = document.getElementById('step-log');
      var firstStep = true;
      var retryDelay = 1000;

      var agentColors = {
        task_extractor: '#eab308',
        research: '#3b82f6',
        url_researcher: '#06b6d4',
        site_analyst: '#8b5cf6',
        content_strategist: '#ec4899',
        browser_agent: '#f97316',
        supervisor: '#14b8a6',
        learning: '#a855f7'
      };

      var agentNames = {
        task_extractor: 'Task Extractor',
        research: 'Research',
        url_researcher: 'URL Researcher',
        site_analyst: 'Site Analyst',
        content_strategist: 'Content Strategist',
        browser_agent: 'Browser Agent',
        supervisor: 'Supervisor',
        learning: 'Learning'
      };

      function addActivityEntry(agent, status, message, timestamp) {
        actCard.style.display = 'block';
        if (actFirstEntry) { actLog.innerHTML = ''; actFirstEntry = false; }

        var statusIcon = status === 'completed' ? '\\u2705' : status === 'failed' ? '\\u274c' : status === 'started' ? '\\u25b6\\ufe0f' : '\\ud83d\\udd04';
        var color = agentColors[agent] || '#94a3b8';
        var name = agentNames[agent] || agent.replace(/_/g, ' ');

        // Update phase badge
        if (status === 'started') {
          actPhase.textContent = name;
          actPhase.style.background = color;
        } else if (status === 'completed') {
          actPhase.textContent = name + ' done';
          actPhase.style.background = '#22c55e';
        } else if (status === 'failed') {
          actPhase.textContent = name + ' failed';
          actPhase.style.background = '#ef4444';
        }

        var entry = document.createElement('div');
        entry.style.cssText = 'padding:0.25rem 0; border-bottom:1px solid #1e293b; display:flex; gap:0.5rem; align-items:flex-start;';

        var time = new Date(timestamp);
        var timeStr = time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

        var timeSpan = document.createElement('span');
        timeSpan.style.cssText = 'color:#64748b; font-size:0.7rem; min-width:55px;';
        timeSpan.textContent = timeStr;

        var agentTag = document.createElement('span');
        agentTag.style.cssText = 'font-size:0.7rem; font-weight:600; padding:0.0625rem 0.375rem; border-radius:0.25rem; white-space:nowrap; background:' + color + '20; color:' + color + ';';
        agentTag.textContent = name;

        var msgSpan = document.createElement('span');
        msgSpan.style.cssText = 'color:#e2e8f0; flex:1;';
        msgSpan.textContent = statusIcon + ' ' + message;

        entry.appendChild(timeSpan);
        entry.appendChild(agentTag);
        entry.appendChild(msgSpan);
        actLog.appendChild(entry);
        actLog.scrollTop = actLog.scrollHeight;
      }

      function connectSSE() {
        var es = new EventSource('/dashboard/events');

        es.onmessage = function(e) {
          try {
            var evt = JSON.parse(e.data);

            // Agent activity events (pipeline agents: research, site analyst, etc.)
            if (evt.type === 'agent_activity' && evt.data) {
              var a = evt.data;
              // Show all agent_activity events — pipeline agents don't have taskId
              // but they run serially so only one task is active at a time
              addActivityEntry(a.agent, a.status, a.message, evt.timestamp);
            }

            if (evt.type === 'agent_step' && evt.data && evt.data.taskId === taskId) {
              var d = evt.data;
              card.style.display = 'block';

              // Update badge
              badge.textContent = 'Step ' + d.stepNumber + '/' + d.maxSteps;

              // Update bar
              var pct = Math.round((d.stepNumber / d.maxSteps) * 100);
              bar.style.width = pct + '%';
              if (d.done && d.success) {
                bar.style.background = '#22c55e';
                badge.style.background = '#22c55e';
              } else if (d.done && !d.success) {
                bar.style.background = '#ef4444';
                badge.style.background = '#ef4444';
              }

              // Update screenshot
              if (d.screenshotFilename) {
                ssImg.src = '/screenshots/' + d.screenshotFilename + '?t=' + Date.now();
                ssDiv.style.display = 'block';
              }

              // Add to step log
              if (firstStep) { log.innerHTML = ''; firstStep = false; }
              var entry = document.createElement('div');
              entry.style.padding = '0.2rem 0';
              entry.style.borderBottom = '1px solid #1e1e2e';
              var icon = d.success ? '\\u2705' : '\\u274c';
              var reasonText = document.createElement('span');
              reasonText.textContent = icon + ' ' + d.stepNumber + '. ' + d.action + ' \\u2014 ' + (d.reasoning || '').substring(0, 120);
              entry.appendChild(reasonText);
              log.appendChild(entry);
              log.scrollTop = log.scrollHeight;
            }

            if (evt.type === 'task_update' && evt.data && evt.data.taskId === taskId) {
              var st = evt.data.status;
              // Update the status badge in real-time
              var statusBadgeEl = document.getElementById('task-status-badge');
              if (statusBadgeEl) {
                var badgeColors = { pending: '#eab308', confirmed: '#3b82f6', executing: '#8b5cf6', done: '#22c55e', failed: '#ef4444' };
                var col = badgeColors[st] || '#6b7280';
                statusBadgeEl.innerHTML = '<span class="badge" style="background:' + col + '">' + st + '</span>';
              }
              if (st === 'executing') {
                // Show the progress card when task starts executing
                card.style.display = 'block';
                actPhase.textContent = 'Executing';
                actPhase.style.background = '#8b5cf6';
                taskStatus = 'executing';
              }
              if (st === 'done' || st === 'failed') {
                setTimeout(function() { location.reload(); }, 2000);
              }
            }
          } catch (_) {}
        };

        es.onerror = function() {
          es.close();
          setTimeout(function() {
            retryDelay = Math.min(retryDelay * 2, 30000);
            connectSSE();
          }, retryDelay);
        };

        es.onopen = function() { retryDelay = 1000; };
      }

      if (taskStatus !== 'done' && taskStatus !== 'failed') { connectSSE(); }

      // ── Hydrate from stored history ──
      fetch('/dashboard/agents/history?taskId=' + encodeURIComponent(taskId))
        .then(function(r) { return r.json(); })
        .then(function(events) {
          if (!events || !events.length) return;
          events.forEach(function(evt) {
            if (evt.eventType === 'agent_activity' && evt.data) {
              var a = evt.data;
              addActivityEntry(a.agent, a.status, a.message, evt.createdAt);
            }
            if (evt.eventType === 'agent_step' && evt.data && evt.data.taskId === taskId) {
              var d = evt.data;
              card.style.display = 'block';
              badge.textContent = 'Step ' + d.stepNumber + '/' + d.maxSteps;
              var pct = Math.round((d.stepNumber / d.maxSteps) * 100);
              bar.style.width = pct + '%';
              if (d.done && d.success) { bar.style.background = '#22c55e'; badge.style.background = '#22c55e'; }
              else if (d.done && !d.success) { bar.style.background = '#ef4444'; badge.style.background = '#ef4444'; }
              if (d.screenshotFilename) {
                ssImg.src = '/screenshots/' + d.screenshotFilename + '?t=' + Date.now();
                ssDiv.style.display = 'block';
              }
              if (firstStep) { log.innerHTML = ''; firstStep = false; }
              var entry = document.createElement('div');
              entry.style.padding = '0.2rem 0';
              entry.style.borderBottom = '1px solid #1e1e2e';
              var icon = d.success ? '\\u2705' : '\\u274c';
              var reasonText = document.createElement('span');
              reasonText.textContent = icon + ' ' + d.stepNumber + '. ' + d.action + ' \\u2014 ' + (d.reasoning || '').substring(0, 120);
              entry.appendChild(reasonText);
              log.appendChild(entry);
            }
          });
          log.scrollTop = log.scrollHeight;
        })
        .catch(function() {});
    })();
    </script>`;

  const errorCard =
    task.errorMessage || task.lastError
      ? `<div class="card">
          <h2>Error</h2>
          <p class="small" style="color:#ef4444">${escapeHtml(task.errorMessage || task.lastError || '')}</p>
        </div>`
      : '';

  const screenshotCard = task.screenshotPath
    ? `<div class="card">
        <h2>Screenshot</h2>
        <img src="/screenshots/${escapeHtml(task.screenshotPath.split('/').pop() || '')}"
             alt="Task screenshot" style="max-width:100%; border-radius:0.5rem; margin-top:0.5rem;">
      </div>`
    : '';

  const auditHtml =
    auditEntries.length > 0
      ? `<div class="card">
          <h2>Audit Log</h2>
          <div class="audit-timeline">
            ${auditEntries
              .map(
                (e) => `
              <div class="audit-item">
                <div class="time">${timeAgo(e.createdAt)}</div>
                <div class="action">${escapeHtml(e.action)}</div>
                ${e.details ? `<div class="details">${escapeHtml(e.details).slice(0, 200)}</div>` : ''}
              </div>`,
              )
              .join('')}
          </div>
        </div>`
      : '';

  const actions = `
    <div style="display:flex; gap:0.5rem; margin-bottom:1rem;">
      <a href="/dashboard" class="btn btn-ghost">← Back</a>
      ${task.status === 'failed' ? `<form method="POST" action="/dashboard/tasks/${escapeHtml(task.id)}/retry" style="display:inline"><button type="submit" class="btn btn-primary">Retry Task</button></form>` : ''}
    </div>`;

  return `${actions}${detailGrid}${descCard}${progressCard}${errorCard}${screenshotCard}${auditHtml}`;
}

function renderClientsPage(clients: ClientSummary[]): string {
  if (clients.length === 0) {
    return `<div class="empty-state"><div class="icon">👥</div><p>No clients yet</p></div>`;
  }

  const rows = clients
    .map(
      (c) => `
      <tr>
        <td><strong>${escapeHtml(c.clientName)}</strong></td>
        <td class="mono small">${escapeHtml(c.siteId)}</td>
        <td>${c.totalTasks}</td>
        <td style="color:#22c55e">${c.doneCount}</td>
        <td style="color:#ef4444">${c.failedCount}</td>
        <td class="small muted">${timeAgo(c.lastTaskAt)}</td>
      </tr>`,
    )
    .join('');

  return `
    <div class="card">
      <h2>Clients</h2>
      <table>
        <thead><tr><th>Client</th><th>Site</th><th>Tasks</th><th>Done</th><th>Failed</th><th>Last Active</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderLearningsPage(learnings: Learning[]): string {
  if (learnings.length === 0) {
    return `<div class="empty-state"><div class="icon">🧠</div><p>No learnings yet. The agent learns from each task execution.</p></div>`;
  }

  const rows = learnings
    .map(
      (l) => `
      <tr>
        <td><span class="${l.polarity === 'positive' ? 'polarity-positive' : 'polarity-negative'}">${l.polarity === 'positive' ? '✓' : '✗'}</span></td>
        <td>${confidenceBadge(l.confidence)}</td>
        <td><strong>${escapeHtml(l.patternKey)}</strong></td>
        <td class="small">${escapeHtml(l.description.slice(0, 120))}</td>
        <td class="mono small">${escapeHtml(l.category)}</td>
        <td class="mono small">${escapeHtml(l.siteId || 'global')}</td>
        <td class="small muted">${l.confirmationCount}↑ ${l.contradictionCount}↓</td>
      </tr>`,
    )
    .join('');

  return `
    <div class="stats-row">
      <div class="stat"><div class="value">${learnings.length}</div><div class="label">Active</div></div>
      <div class="stat"><div class="value">${learnings.filter((l) => l.polarity === 'positive').length}</div><div class="label">Positive</div></div>
      <div class="stat"><div class="value">${learnings.filter((l) => l.polarity === 'negative').length}</div><div class="label">Negative</div></div>
      <div class="stat"><div class="value">${learnings.filter((l) => l.confidence >= 0.7).length}</div><div class="label">High Conf</div></div>
    </div>
    <div class="card">
      <h2>Learned Patterns</h2>
      <table>
        <thead><tr><th></th><th>Conf</th><th>Pattern</th><th>Description</th><th>Category</th><th>Scope</th><th>Votes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─── Agents Page Renderer ────────────────────────────────────────────────────

function renderAgentsPage(): string {
  const agents = [
    { id: 'task_extractor', name: 'Task Extractor', icon: '&#x1F4E7;', desc: 'Parses emails into tasks' },
    { id: 'research', name: 'Research Agent', icon: '&#x1F50D;', desc: 'Web search for context' },
    { id: 'url_researcher', name: 'URL Researcher', icon: '&#x1F310;', desc: 'Visits project URLs' },
    { id: 'site_analyst', name: 'Site Analyst', icon: '&#x1F4F8;', desc: 'Analyzes page design' },
    { id: 'content_strategist', name: 'Content Strategist', icon: '&#x270F;&#xFE0F;', desc: 'Drafts content plan' },
    { id: 'browser_agent', name: 'Browser Agent', icon: '&#x1F916;', desc: 'Executes Squarespace edits' },
    { id: 'supervisor', name: 'Supervisor', icon: '&#x1F50E;', desc: 'Verifies results' },
    { id: 'learning', name: 'Learning Agent', icon: '&#x1F9E0;', desc: 'Extracts patterns' },
  ];

  const agentCards = agents
    .map(
      (a) => `
      <div class="card agent-card" id="agent-${a.id}" data-agent="${a.id}">
        <div style="display:flex; align-items:center; gap:0.75rem; margin-bottom:0.5rem;">
          <span style="font-size:1.5rem;">${a.icon}</span>
          <div style="flex:1;">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <strong style="color:#f1f5f9;">${escapeHtml(a.name)}</strong>
              <span class="agent-status-dot" style="width:8px; height:8px; border-radius:50%; background:#475569; display:inline-block;"></span>
              <span class="agent-status-label badge" style="background:#334155; font-size:0.7rem;">idle</span>
            </div>
            <div class="small muted">${escapeHtml(a.desc)}</div>
          </div>
        </div>
        <div class="agent-log" style="max-height:120px; overflow-y:auto; font-size:0.75rem; font-family:'SF Mono',SFMono-Regular,Consolas,monospace; background:#0f172a; border-radius:0.375rem; padding:0.5rem; min-height:2rem;">
          <div class="muted" style="text-align:center;">No recent activity</div>
        </div>
      </div>`,
    )
    .join('');

  return `
    <style>
      .agents-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
      .agent-card { transition: border-color 0.3s; border: 1px solid transparent; }
      .agent-card.active { border-color: #22c55e; }
      .agent-card.error { border-color: #ef4444; }
      .timeline-entry { padding: 0.375rem 0.5rem; border-bottom: 1px solid #1e293b; font-size: 0.8125rem; display: flex; gap: 0.5rem; align-items: flex-start; }
      .timeline-entry .time { color: #64748b; font-size: 0.7rem; white-space: nowrap; min-width: 55px; font-family: 'SF Mono',SFMono-Regular,Consolas,monospace; }
      .timeline-entry .agent-tag { font-size: 0.7rem; font-weight: 600; padding: 0.0625rem 0.375rem; border-radius: 0.25rem; white-space: nowrap; }
      .timeline-entry .msg { color: #e2e8f0; flex: 1; }
    </style>

    <div class="agents-grid">${agentCards}</div>

    <div class="card">
      <h2>Activity Timeline</h2>
      <div id="timeline" style="max-height:400px; overflow-y:auto;">
        <div class="empty-state" id="timeline-empty"><p class="small muted">Waiting for agent activity&hellip;</p></div>
      </div>
    </div>

    <script>
    (function() {
      var MAX_LOG_ENTRIES = 30;
      var MAX_TIMELINE_ENTRIES = 100;

      var agentColors = {
        task_extractor: '#eab308',
        research: '#3b82f6',
        url_researcher: '#06b6d4',
        site_analyst: '#8b5cf6',
        content_strategist: '#ec4899',
        browser_agent: '#f97316',
        supervisor: '#14b8a6',
        learning: '#a855f7'
      };

      var statusColors = {
        started: '#3b82f6',
        progress: '#eab308',
        completed: '#22c55e',
        failed: '#ef4444'
      };

      var timeline = document.getElementById('timeline');
      var timelineEmpty = document.getElementById('timeline-empty');

      function esc(str) {
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
      }

      function formatTime(iso) {
        var d = new Date(iso);
        return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      function updateAgentCard(agentId, status, message) {
        var card = document.getElementById('agent-' + agentId);
        if (!card) return;

        var dot = card.querySelector('.agent-status-dot');
        var label = card.querySelector('.agent-status-label');
        var log = card.querySelector('.agent-log');

        // Update status dot and label
        if (status === 'started' || status === 'progress') {
          dot.style.background = '#22c55e';
          card.classList.add('active');
          card.classList.remove('error');
          label.textContent = 'working';
          label.style.background = '#22c55e';
        } else if (status === 'completed') {
          dot.style.background = '#22c55e';
          card.classList.remove('active');
          card.classList.remove('error');
          label.textContent = 'done';
          label.style.background = '#22c55e';
          // Fade to idle after 10 seconds
          setTimeout(function() {
            dot.style.background = '#475569';
            label.textContent = 'idle';
            label.style.background = '#334155';
          }, 10000);
        } else if (status === 'failed') {
          dot.style.background = '#ef4444';
          card.classList.remove('active');
          card.classList.add('error');
          label.textContent = 'error';
          label.style.background = '#ef4444';
          setTimeout(function() {
            card.classList.remove('error');
            dot.style.background = '#475569';
            label.textContent = 'idle';
            label.style.background = '#334155';
          }, 30000);
        }

        // Add to agent log
        var firstEntry = log.querySelector('.muted');
        if (firstEntry && firstEntry.textContent === 'No recent activity') {
          log.innerHTML = '';
        }

        var entry = document.createElement('div');
        entry.style.cssText = 'padding:0.125rem 0; border-bottom:1px solid #1e293b; color:' + (statusColors[status] || '#94a3b8') + ';';
        entry.textContent = message;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;

        // Trim old entries
        while (log.children.length > MAX_LOG_ENTRIES) {
          log.removeChild(log.firstChild);
        }
      }

      function addToTimeline(agentId, status, message, timestamp) {
        if (timelineEmpty) { timelineEmpty.remove(); timelineEmpty = null; }

        var entry = document.createElement('div');
        entry.className = 'timeline-entry';

        var color = agentColors[agentId] || '#94a3b8';
        var statusIcon = status === 'completed' ? '\\u2705' : status === 'failed' ? '\\u274c' : status === 'started' ? '\\u25b6' : '\\ud83d\\udd04';

        entry.innerHTML =
          '<span class="time">' + esc(formatTime(timestamp)) + '</span>' +
          '<span class="agent-tag" style="background:' + color + '20; color:' + color + ';">' + esc(agentId.replace(/_/g, ' ')) + '</span>' +
          '<span class="msg">' + statusIcon + ' ' + esc(message) + '</span>';

        // Prepend (newest first)
        timeline.insertBefore(entry, timeline.firstChild);

        // Trim
        while (timeline.children.length > MAX_TIMELINE_ENTRIES) {
          timeline.removeChild(timeline.lastChild);
        }
      }

      // SSE connection with exponential backoff
      var retryDelay = 1000;

      function connectSSE() {
        var es = new EventSource('/dashboard/events');

        es.onmessage = function(e) {
          try {
            var evt = JSON.parse(e.data);
            if (evt.type === 'agent_activity' && evt.data) {
              var d = evt.data;
              updateAgentCard(d.agent, d.status, d.message);
              addToTimeline(d.agent, d.status, d.message, evt.timestamp);
            }
          } catch (_) {}
        };

        es.onerror = function() {
          es.close();
          setTimeout(function() {
            retryDelay = Math.min(retryDelay * 2, 30000);
            connectSSE();
          }, retryDelay);
        };

        es.onopen = function() { retryDelay = 1000; };
      }

      connectSSE();

      // Reconnect on tab visibility change (handles backgrounded tabs)
      document.addEventListener('visibilitychange', function() {
        if (!document.hidden) { retryDelay = 1000; }
      });

      // ── Hydrate from stored history ──
      fetch('/dashboard/agents/history')
        .then(function(r) { return r.json(); })
        .then(function(events) {
          if (!events || !events.length) return;
          events.forEach(function(evt) {
            if (evt.eventType === 'agent_activity' && evt.data) {
              var d = evt.data;
              updateAgentCard(d.agent, d.status, d.message);
              addToTimeline(d.agent, d.status, d.message, evt.createdAt);
            }
          });
        })
        .catch(function() {});
    })();
    </script>`;
}

// ─── Chat Page Renderer ─────────────────────────────────────────────────────

function renderChatPage(): string {
  return `
    <div style="display:grid; grid-template-columns:1fr 360px; gap:1rem; height:calc(100vh - 100px);">
      <!-- Chat Panel -->
      <div class="card" style="display:flex; flex-direction:column; margin-bottom:0; overflow:hidden;">
        <h2 style="flex-shrink:0;">💬 Chat</h2>
        <div id="chat-messages" style="flex:1; overflow-y:auto; padding:0.75rem 0; display:flex; flex-direction:column; gap:0.5rem;">
          <div class="empty-state" id="chat-empty"><div class="icon">💬</div><p>Send a message to get started</p></div>
        </div>
        <div id="pdf-chip" style="display:none; flex-shrink:0; padding:0.25rem 0.75rem;">
          <span style="display:inline-flex; align-items:center; gap:0.375rem; background:#1e3a5f; color:#93c5fd; border:1px solid #3b82f6; border-radius:1rem; padding:0.25rem 0.625rem; font-size:0.8125rem;">
            <span>📄</span>
            <span id="pdf-chip-name"></span>
            <button id="pdf-chip-remove" style="background:none; border:none; color:#93c5fd; cursor:pointer; font-size:1rem; line-height:1; padding:0 0.125rem;">&times;</button>
          </span>
        </div>
        <div style="flex-shrink:0; border-top:1px solid #334155; padding-top:0.75rem; display:flex; gap:0.5rem;">
          <input type="file" id="pdf-file-input" accept=".pdf" style="display:none;">
          <button id="pdf-attach-btn" title="Attach PDF" style="background:none; border:1px solid #334155; border-radius:0.5rem; padding:0.5rem 0.625rem; cursor:pointer; font-size:1rem; color:#94a3b8; flex-shrink:0;">📎</button>
          <input type="text" id="chat-input" placeholder="Send a request or reply…"
            style="flex:1; background:#0f172a; border:1px solid #334155; border-radius:0.5rem; padding:0.5rem 0.75rem; color:#e2e8f0; font-size:0.875rem; outline:none;"
            autocomplete="off">
          <button id="chat-send" class="btn btn-primary" style="white-space:nowrap;">Send</button>
        </div>
      </div>

      <!-- Task Progress Sidebar -->
      <div class="card" style="display:flex; flex-direction:column; margin-bottom:0; overflow:hidden;">
        <h2 style="flex-shrink:0;">📋 Active Tasks</h2>
        <div id="task-sidebar" style="flex:1; overflow-y:auto; padding:0.75rem 0;">
          <div class="empty-state" id="tasks-empty"><p class="small muted">No active tasks</p></div>
        </div>
        <div style="flex-shrink:0; border-top:1px solid #334155; padding-top:0.5rem;">
          <div id="conversation-status" class="small muted">No active conversation</div>
        </div>
      </div>
    </div>

    <div id="button-container" style="display:none;"></div>

    <script>
      (function() {
        const messagesEl = document.getElementById('chat-messages');
        const inputEl = document.getElementById('chat-input');
        const sendBtn = document.getElementById('chat-send');
        const emptyEl = document.getElementById('chat-empty');
        const tasksEmptyEl = document.getElementById('tasks-empty');
        const taskSidebarEl = document.getElementById('task-sidebar');
        const convStatusEl = document.getElementById('conversation-status');
        const btnContainerEl = document.getElementById('button-container');
        const pdfFileInput = document.getElementById('pdf-file-input');
        const pdfAttachBtn = document.getElementById('pdf-attach-btn');
        const pdfChip = document.getElementById('pdf-chip');
        const pdfChipName = document.getElementById('pdf-chip-name');
        const pdfChipRemove = document.getElementById('pdf-chip-remove');

        // ── PDF Attachment State ──
        var pendingPdfBase64 = null;
        var pendingPdfFilename = null;

        pdfAttachBtn.addEventListener('click', function() { pdfFileInput.click(); });

        pdfFileInput.addEventListener('change', function() {
          var file = pdfFileInput.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function() {
            // result is "data:application/pdf;base64,AAAA..."
            pendingPdfBase64 = reader.result.split(',')[1];
            pendingPdfFilename = file.name;
            pdfChipName.textContent = file.name;
            pdfChip.style.display = 'block';
          };
          reader.readAsDataURL(file);
        });

        pdfChipRemove.addEventListener('click', function() {
          pendingPdfBase64 = null;
          pendingPdfFilename = null;
          pdfFileInput.value = '';
          pdfChip.style.display = 'none';
        });

        // ── Helpers ──
        function esc(str) {
          const d = document.createElement('div');
          d.textContent = str;
          return d.innerHTML;
        }

        function addBubble(body, direction, type) {
          if (emptyEl) emptyEl.remove();
          const bubble = document.createElement('div');
          const isInbound = direction === 'inbound';
          bubble.style.cssText = 'max-width:80%; padding:0.625rem 0.875rem; border-radius:0.75rem; font-size:0.875rem; line-height:1.45; word-wrap:break-word; white-space:pre-wrap; ' +
            (isInbound
              ? 'align-self:flex-end; background:#3b82f6; color:#fff; border-bottom-right-radius:0.25rem;'
              : 'align-self:flex-start; background:#334155; color:#e2e8f0; border-bottom-left-radius:0.25rem;');
          bubble.innerHTML = esc(body);
          messagesEl.appendChild(bubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function addImageBubble(src, caption) {
          if (emptyEl) emptyEl.remove();
          const bubble = document.createElement('div');
          bubble.style.cssText = 'align-self:flex-start; max-width:80%;';
          bubble.innerHTML =
            '<img src="' + esc(src) + '" style="max-width:100%;border-radius:0.5rem;margin-bottom:0.25rem;" alt="screenshot">' +
            (caption ? '<div style="font-size:0.8125rem;color:#94a3b8;padding:0 0.25rem;">' + esc(caption) + '</div>' : '');
          messagesEl.appendChild(bubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function addButtons(body, buttons) {
          if (emptyEl) emptyEl.remove();
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'align-self:flex-start; max-width:85%;';
          wrapper.innerHTML =
            '<div style="background:#334155; color:#e2e8f0; padding:0.625rem 0.875rem; border-radius:0.75rem 0.75rem 0.75rem 0.25rem; font-size:0.875rem; line-height:1.45; white-space:pre-wrap; margin-bottom:0.375rem;">' + esc(body) + '</div>' +
            '<div style="display:flex; gap:0.375rem; flex-wrap:wrap;">' +
            buttons.map(function(b) {
              return '<button class="btn btn-primary chat-btn" data-id="' + esc(b.id) + '" style="font-size:0.8125rem;">' + esc(b.title) + '</button>';
            }).join('') +
            '</div>';
          messagesEl.appendChild(wrapper);
          messagesEl.scrollTop = messagesEl.scrollHeight;

          // Attach click handlers to buttons
          wrapper.querySelectorAll('.chat-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var btnId = this.getAttribute('data-id');
              var btnTitle = this.textContent;
              // Disable all buttons in this group
              wrapper.querySelectorAll('.chat-btn').forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
              // Show as inbound
              addBubble(btnTitle, 'inbound', 'button');
              // Send button reply
              sendMessage(null, btnId);
            });
          });
        }

        function updateTaskCard(taskId, status, errorMessage) {
          var existing = document.getElementById('task-' + taskId);
          if (!existing) {
            if (tasksEmptyEl) tasksEmptyEl.style.display = 'none';
            existing = document.createElement('div');
            existing.id = 'task-' + taskId;
            existing.style.cssText = 'background:#0f172a; border-radius:0.5rem; padding:0.5rem 0.75rem; margin-bottom:0.375rem; font-size:0.8125rem;';
            existing.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;"><span class="mono" style="font-size:0.75rem;">' + esc(taskId.slice(0,8)) + '…</span><span class="task-badge"></span></div>';
            if (errorMessage) existing.innerHTML += '<div class="task-error" style="color:#ef4444;font-size:0.75rem;margin-top:0.25rem;"></div>';
            taskSidebarEl.appendChild(existing);
          }
          var colors = { pending:'#eab308', confirmed:'#3b82f6', executing:'#8b5cf6', done:'#22c55e', failed:'#ef4444' };
          var badge = existing.querySelector('.task-badge');
          if (badge) badge.innerHTML = '<span class="badge" style="background:' + (colors[status]||'#6b7280') + '">' + esc(status) + '</span>';
          var errEl = existing.querySelector('.task-error');
          if (errEl && errorMessage) errEl.textContent = errorMessage;
        }

        function updateConversationStatus(convId, status) {
          convStatusEl.innerHTML = convId
            ? '🔄 <strong>' + esc(status) + '</strong> <span class="mono" style="font-size:0.75rem;">(' + esc(convId.slice(0,8)) + '…)</span>'
            : 'No active conversation';
        }

        // ── Conversation tracking ──
        var activeConversationId = null;

        // ── Send Message ──
        function sendMessage(body, buttonId) {
          var payload = {};
          if (body) payload.body = body;
          if (buttonId) payload.buttonId = buttonId;
          if (activeConversationId) payload.conversationId = activeConversationId;
          if (pendingPdfBase64) {
            payload.pdfBase64 = pendingPdfBase64;
            payload.pdfFilename = pendingPdfFilename;
          }

          fetch('/dashboard/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(function(err) {
            console.error('Send failed:', err);
            addBubble('⚠️ Failed to send message', 'outbound', 'error');
          });

          // Clear PDF state after send
          if (pendingPdfBase64) {
            pendingPdfBase64 = null;
            pendingPdfFilename = null;
            pdfFileInput.value = '';
            pdfChip.style.display = 'none';
          }
        }

        sendBtn.addEventListener('click', function() {
          var text = inputEl.value.trim();
          if (!text && !pendingPdfBase64) return;
          var displayText = text || '';
          if (pendingPdfFilename) displayText = (displayText ? displayText + ' ' : '') + '📄 ' + pendingPdfFilename;
          addBubble(displayText, 'inbound', 'text');
          sendMessage(text, null);
          inputEl.value = '';
        });

        inputEl.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
          }
        });

        // ── SSE with reconnection ──
        var evtSource = null;
        var sseRetryDelay = 1000;
        var sseMaxDelay = 30000;
        var sseConnected = false;

        function handleSseMessage(e) {
          try {
            var evt = JSON.parse(e.data);
            switch (evt.type) {
              case 'message':
                addBubble(evt.data.body, evt.data.direction || 'outbound', 'text');
                break;
              case 'buttons':
                addButtons(evt.data.body, evt.data.buttons || []);
                break;
              case 'image':
                addImageBubble(evt.data.imagePath, evt.data.caption);
                break;
              case 'task_update':
                updateTaskCard(evt.data.taskId, evt.data.status, evt.data.errorMessage);
                break;
              case 'conversation_update':
                updateConversationStatus(evt.data.conversationId, evt.data.status);
                // Track the most recently updated conversation
                if (evt.data.conversationId) activeConversationId = evt.data.conversationId;
                break;
            }
          } catch (err) {
            console.warn('SSE parse error:', err);
          }
        }

        function connectSSE() {
          if (evtSource) {
            evtSource.close();
          }
          evtSource = new EventSource('/dashboard/events');

          evtSource.addEventListener('open', function() {
            sseRetryDelay = 1000; // Reset backoff on successful connect
            sseConnected = true;
          });

          evtSource.addEventListener('message', handleSseMessage);

          evtSource.addEventListener('error', function() {
            sseConnected = false;
            evtSource.close();
            console.warn('SSE connection lost, reconnecting in ' + sseRetryDelay + 'ms…');
            setTimeout(connectSSE, sseRetryDelay);
            sseRetryDelay = Math.min(sseRetryDelay * 2, sseMaxDelay);
          });
        }

        connectSSE();

        // Reconnect when tab becomes visible again (handles backgrounded tabs)
        document.addEventListener('visibilitychange', function() {
          if (!document.hidden && !sseConnected) {
            sseRetryDelay = 1000;
            connectSSE();
          }
        });

        // ── Load History ──
        fetch('/dashboard/chat/history')
          .then(function(r) { return r.json(); })
          .then(function(messages) {
            if (!messages || !messages.length) return;
            if (emptyEl) emptyEl.remove();
            messages.forEach(function(m) {
              if (m.body.startsWith('[BUTTONS] ')) {
                // Historical buttons render as plain text
                addBubble(m.body.replace('[BUTTONS] ', ''), m.direction, 'text');
              } else if (m.mediaUrl) {
                var filename = m.mediaUrl.split('/').pop() || '';
                addImageBubble('/screenshots/' + filename, m.body !== '[image]' ? m.body : '');
              } else {
                addBubble(m.body, m.direction, 'text');
              }
            });
          })
          .catch(function(err) { console.warn('History load failed:', err); });

        // ── Load Conversation State ──
        fetch('/dashboard/chat/conversations')
          .then(function(r) { return r.json(); })
          .then(function(convs) {
            if (!convs || !convs.length) return;
            // Use the most recent active conversation as default
            var conv = convs[0];
            activeConversationId = conv.id;
            updateConversationStatus(conv.id, conv.status);
            // Load task statuses for sidebar
            (conv.taskIds || []).forEach(function(tid) {
              fetch('/dashboard/api/task/' + tid)
                .then(function(r) { return r.json(); })
                .then(function(t) { if (t && t.id) updateTaskCard(t.id, t.status, t.errorMessage); })
                .catch(function() {});
            });
            // Show conversation count if multiple
            if (convs.length > 1) {
              convStatusEl.innerHTML += ' <span class="badge" style="background:#3b82f6;font-size:0.7rem;margin-left:0.25rem;">' + convs.length + ' active</span>';
            }
          })
          .catch(function(err) { console.warn('Conversation load failed:', err); });
      })();
    </script>`;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // Main tasks page
  app.get('/dashboard', async (request: FastifyRequest<{ Querystring: { status?: string } }>, reply: FastifyReply) => {
    const statusFilter = (request.query as { status?: string }).status || 'all';
    const stats = getTaskStats();
    const tasks = getFilteredTasks(statusFilter === 'all' ? undefined : statusFilter);
    const html = layout('Tasks', 'tasks', renderTasksPage(tasks, stats, statusFilter));
    return reply.type('text/html').send(html);
  });

  // Task detail
  app.get('/dashboard/tasks/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const task = getTask(id);
    if (!task) {
      return reply.status(404).type('text/html').send(layout('Not Found', 'tasks', '<div class="empty-state"><p>Task not found</p></div>'));
    }
    const auditEntries = getAuditLog(id);
    const html = layout(`Task ${id.slice(0, 8)}`, 'tasks', renderTaskDetailPage(task, auditEntries));
    return reply.type('text/html').send(html);
  });

  // Retry a failed task
  app.post('/dashboard/tasks/:id/retry', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const task = getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }
    if (task.status !== 'failed') {
      return reply.redirect(`/dashboard/tasks/${id}`);
    }

    updateTaskStatus(id, 'pending', undefined);
    logger.info({ taskId: id }, 'Task re-queued from dashboard');
    return reply.redirect(`/dashboard/tasks/${id}`);
  });

  // Clients page
  app.get('/dashboard/clients', async (_request: FastifyRequest, reply: FastifyReply) => {
    const clients = getClientSummaries();
    const html = layout('Clients', 'clients', renderClientsPage(clients));
    return reply.type('text/html').send(html);
  });

  // Learnings page
  app.get('/dashboard/learnings', async (_request: FastifyRequest, reply: FastifyReply) => {
    const learnings = getAllActiveLearnings();
    const html = layout('Learnings', 'learnings', renderLearningsPage(learnings));
    return reply.type('text/html').send(html);
  });

  // ─── Agents Page ─────────────────────────────────────────────────────────────

  app.get('/dashboard/agents', async (_request: FastifyRequest, reply: FastifyReply) => {
    const html = layout('Agents', 'agents', renderAgentsPage());
    return reply.type('text/html').send(html);
  });

  // ─── Agents History API ────────────────────────────────────────────────────

  app.get('/dashboard/agents/history', async (
    request: FastifyRequest<{ Querystring: { taskId?: string } }>,
    reply: FastifyReply,
  ) => {
    const { taskId } = request.query as { taskId?: string };
    const events = taskId
      ? getAgentEventsByTask(taskId)
      : getRecentAgentEvents(200);
    return reply.send(events);
  });

  // ─── Chat Page ──────────────────────────────────────────────────────────────

  app.get('/dashboard/chat', async (_request: FastifyRequest, reply: FastifyReply) => {
    const html = layout('Chat', 'chat', renderChatPage());
    return reply.type('text/html').send(html);
  });

  // ─── SSE Event Stream ───────────────────────────────────────────────────────

  app.get('/dashboard/events', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Use raw Node.js response for SSE streaming
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering if proxied
    });

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      raw.write(': heartbeat\n\n');
    }, 30_000);

    // Forward dashboard events
    const handler = (evt: DashboardEvent) => {
      try {
        raw.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch {
        // Client disconnected
      }
    };

    dashboardEvents.on('dashboard', handler);

    // Clean up on disconnect
    _request.raw.on('close', () => {
      clearInterval(heartbeat);
      dashboardEvents.off('dashboard', handler);
      logger.debug('SSE client disconnected');
    });

    logger.info('SSE client connected');

    // Send initial ping
    raw.write(': connected\n\n');

    // Prevent Fastify from auto-closing the response
    return reply.hijack();
  });

  // ─── Chat API: Send Message ─────────────────────────────────────────────────

  app.post('/dashboard/chat', {
    config: { rawBody: true },
    bodyLimit: 10 * 1024 * 1024, // 10MB for PDF uploads
  }, async (
    request: FastifyRequest<{ Body: { body?: string; buttonId?: string; conversationId?: string; pdfBase64?: string; pdfFilename?: string } }>,
    reply: FastifyReply,
  ) => {
    const { body, buttonId, conversationId, pdfBase64, pdfFilename } = request.body as {
      body?: string; buttonId?: string; conversationId?: string; pdfBase64?: string; pdfFilename?: string;
    };

    if (!body && !buttonId && !pdfBase64) {
      return reply.status(400).send({ error: 'body, buttonId, or pdfBase64 required' });
    }

    let messageBody = body || buttonId || '';
    const messageType: 'text' | 'button' = buttonId ? 'button' : 'text';

    // Handle PDF attachment
    if (pdfBase64) {
      try {
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
        const safeName = (pdfFilename || 'upload.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');

        // Save to storage/uploads/
        const uploadsDir = 'storage/uploads';
        mkdirSync(uploadsDir, { recursive: true });
        const savedPath = `${uploadsDir}/${randomUUID()}-${safeName}`;
        writeFileSync(savedPath, pdfBuffer);
        logger.info({ filename: safeName, savedPath, bytes: pdfBuffer.length }, 'PDF saved from dashboard upload');

        // Extract text
        const { text, numPages } = await extractPdfText(pdfBuffer);
        messageBody = `${messageBody}\n\n--- PDF Content from '${safeName}' (${numPages} pages) ---\n${text}`;
        logger.info({ filename: safeName, numPages, textLength: text.length }, 'PDF text extracted');
      } catch (err) {
        logger.error({ err, filename: pdfFilename }, 'PDF extraction failed');
        return reply.status(400).send({ error: `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // Build a synthetic IncomingWhatsAppMessage with optional conversationId
    const syntheticMsg: IncomingWhatsAppMessage & { conversationId?: string } = {
      waMessageId: `dash-in-${Date.now()}`,
      from: 'dashboard',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: messageType,
      body: messageBody,
      ...(buttonId ? { buttonId } : {}),
      ...(conversationId ? { conversationId } : {}),
    };

    // Process asynchronously (don't block the response)
    handleIncomingMessage(syntheticMsg).catch((err) => {
      logger.error({ err }, 'Dashboard chat message handler error');
    });

    return reply.send({ ok: true });
  });

  // ─── Chat API: Message History ──────────────────────────────────────────────

  app.get('/dashboard/chat/history', async (
    request: FastifyRequest<{ Querystring: { conversationId?: string } }>,
    reply: FastifyReply,
  ) => {
    const { conversationId } = request.query as { conversationId?: string };

    if (conversationId) {
      const messages = getMessagesByConversation(conversationId);
      return reply.send(messages);
    }

    // Fall back to most recent active conversation or recent messages
    const active = getActiveConversations();
    if (active.length > 0) {
      const messages = getMessagesByConversation(active[0].id);
      return reply.send(messages);
    }

    // No active conversation — return recent dashboard-related messages
    const recent = getRecentMessages(30);
    return reply.send(recent.reverse());
  });

  // ─── Chat API: Active Conversation ──────────────────────────────────────────

  // Return the most recent active conversation (backward compat)
  app.get('/dashboard/chat/conversation', async (_request: FastifyRequest, reply: FastifyReply) => {
    const active = getActiveConversations();
    if (active.length === 0) {
      return reply.send(null);
    }
    return reply.send(active[0]);
  });

  // Return ALL active conversations (new endpoint for multi-conversation UI)
  app.get('/dashboard/chat/conversations', async (_request: FastifyRequest, reply: FastifyReply) => {
    const conversations = getActiveConversations();
    return reply.send(conversations);
  });

  // Execution queue status
  app.get('/dashboard/api/queue', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      running: executionQueue.getRunningConversationId(),
      runningAll: executionQueue.getRunningConversationIds(),
      queued: executionQueue.getQueuedConversationIds(),
      queueLength: executionQueue.getQueueLength(),
      activeSites: executionQueue.getActiveSiteCount(),
      siteQueues: executionQueue.getSiteQueueStatus(),
    });
  });

  // ─── Chat API: Task Detail (for sidebar) ────────────────────────────────────

  app.get('/dashboard/api/task/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    const task = getTask(id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' });
    }
    return reply.send(task);
  });
}

import { CHANNEL_LABELS, escapeHtml, formatText } from './html.js';

function statusLine(item, agent) {
  switch (item.status) {
    case 'published':
      return item.publishResult?.mode === 'dry-run' ? 'Approved (dry run: no publisher connected yet)' : 'Approved and published';
    case 'approved':
      return 'Approved, publishing…';
    case 'publish_failed':
      return `Approved, but publishing failed. ${agent.reviewer.name} has been told.`;
    case 'returned':
      return `Sent back to ${agent.reviewer.name}${item.note ? `: “${item.note}”` : ''}`;
    case 'revised':
      return 'Revised and sent for approval again';
    case 'discarded':
      return 'Discarded';
    default:
      return '';
  }
}

function approverActions(item, action) {
  if (item.status !== 'pending') return '';
  return `<form class="actions" method="post" action="${action}" data-action>
  <details class="note"><summary>Add a note (optional)</summary>
    <textarea name="note" rows="2" placeholder="What should change?"></textarea>
  </details>
  <div class="buttons">
    <button class="no" name="decision" value="return">✕ Send back</button>
    <button class="yes" name="decision" value="approve">✓ Approve</button>
  </div>
</form>`;
}

function reviewerActions(item, action, agent) {
  if (!['returned', 'publish_failed'].includes(item.status)) return '';
  const retry = item.status === 'publish_failed'
    ? '<button class="yes" name="decision" value="retry">Retry publishing</button>'
    : '';
  return `<form class="actions" method="post" action="${action}" data-action>
  <label class="edit">Edit the text (CTA, hashtags and footer are re-added automatically)
    <textarea name="body" rows="8">${escapeHtml(item.draft.body)}</textarea>
  </label>
  <div class="buttons wrap">
    <button class="ghost" name="decision" value="discard">Discard</button>
    <button class="ghost" name="decision" value="rewrite">Rewrite with AI</button>
    ${retry}
    <button class="yes" name="decision" value="resend">Send to ${escapeHtml(agent.approver.name)}</button>
  </div>
</form>`;
}

export function renderCard(item, { agent, role, token }) {
  const action = `/r/${token}/items/${item.id}`;
  const status = statusLine(item, agent);
  const media = item.channel === 'newsletter'
    ? `<div class="subject"><span>Subject</span>${escapeHtml(item.subject)}</div>`
    : `<div class="visual"><span>Suggested visual</span>${escapeHtml(item.draft.visual)}</div>`;

  return `<article class="card ${item.status}" id="item-${item.id}">
  <header>
    <span class="channel ${item.channel}">${CHANNEL_LABELS[item.channel]}</span>
    <span class="cta">→ ${item.draft.cta === 'valuation' ? 'Home valuation' : 'Consultation'}</span>
  </header>
  <h2>${escapeHtml(item.draft.title)}</h2>
  <p class="why">${escapeHtml(item.draft.why)}</p>
  ${media}
  <div class="preview">${formatText(item.text)}</div>
  ${status ? `<p class="status">${escapeHtml(status)}</p>` : ''}
  ${role === 'approver' ? approverActions(item, action) : reviewerActions(item, action, agent)}
</article>`;
}

const STYLES = `
:root{--bg:#f4f6f3;--card:#fff;--text:#1d2b22;--muted:#5b6b60;--line:#e2e8e3;--brand:#1f5d3a;--brand-text:#fff;--no:#8a2f2f;--no-bg:#fbeeee;--ok-bg:#e8f3ec;--preview:#f8faf8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111714;--card:#1a221d;--text:#e4ebe6;--muted:#9aaa9f;--line:#2b362f;--brand:#3f9a66;--brand-text:#0d1410;--no:#f08f8f;--no-bg:#3a2222;--ok-bg:#1e3326;--preview:#141b17}}
:root[data-theme="dark"]{--bg:#111714;--card:#1a221d;--text:#e4ebe6;--muted:#9aaa9f;--line:#2b362f;--brand:#3f9a66;--brand-text:#0d1410;--no:#f08f8f;--no-bg:#3a2222;--ok-bg:#1e3326;--preview:#141b17}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 64px}
.top h1{font-size:22px;margin:0 0 4px}
.top p{margin:0;color:var(--muted)}
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0}
.progress{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 16px}
.card header{display:flex;justify-content:space-between;align-items:center;font-size:13px}
.channel{font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.cta{color:var(--muted)}
.card h2{font-size:18px;margin:8px 0 2px}
.why{margin:0 0 12px;color:var(--muted);font-size:14px}
.visual,.subject{font-size:14px;border-left:3px solid var(--brand);padding:2px 0 2px 10px;margin:0 0 12px}
.visual span,.subject span{display:block;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.preview{background:var(--preview);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:15px;overflow-wrap:anywhere}
.preview a{color:var(--brand)}
.status{margin:12px 0 0;font-weight:600;font-size:14px}
.card.published .status,.card.revised .status{color:var(--brand)}
.card.returned .status,.card.publish_failed .status{color:var(--no)}
.card:not(.pending) .preview{opacity:.75}
.actions{margin-top:12px}
.buttons{display:flex;gap:10px}
.buttons.wrap{flex-wrap:wrap;justify-content:flex-end}
button{font:inherit;font-weight:600;border-radius:10px;padding:14px 16px;border:1px solid transparent;cursor:pointer;min-height:48px}
.buttons:not(.wrap) button{flex:1}
button.yes{background:var(--brand);color:var(--brand-text)}
button.no{background:var(--no-bg);color:var(--no);border-color:var(--no)}
button.ghost{background:transparent;color:var(--text);border-color:var(--line)}
button:disabled{opacity:.5;cursor:default}
.note{margin:0 0 10px;font-size:14px;color:var(--muted)}
.note summary{cursor:pointer}
textarea{width:100%;margin-top:6px;font:inherit;font-size:15px;color:var(--text);background:var(--preview);border:1px solid var(--line);border-radius:8px;padding:10px}
.edit{display:block;font-size:13px;color:var(--muted);margin-bottom:10px}
.done{background:var(--ok-bg);border-radius:12px;padding:16px;text-align:center;font-weight:600;display:none}
.error{color:var(--no);font-size:14px;margin-top:8px}
`;

const SCRIPT = `
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.matches('form[data-action]')) return;
  event.preventDefault();
  const body = new URLSearchParams(new FormData(form, event.submitter));
  const card = form.closest('.card');
  form.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const res = await fetch(form.action, { method: 'POST', body, headers: { accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    card.outerHTML = data.html;
    updateProgress();
  } catch (err) {
    form.querySelectorAll('button').forEach((b) => (b.disabled = false));
    let msg = form.querySelector('.error');
    if (!msg) { msg = document.createElement('p'); msg.className = 'error'; form.append(msg); }
    msg.textContent = err.message;
  }
});
function updateProgress() {
  const left = document.querySelectorAll('.card .actions').length;
  const el = document.querySelector('.progress');
  if (el) el.textContent = left ? left + ' left' : 'All done';
  const all = document.querySelector('.approve-all');
  if (all && left < 2) all.remove();
  else if (all) all.querySelector('button').textContent = '✓ Approve all ' + left;
  if (!left) document.querySelector('.done').style.display = 'block';
}
updateProgress();
`;

export function renderReviewPage({ agent, pkg, role, token }) {
  const pending = pkg.items.filter((i) => i.status === 'pending').length;
  const isApprover = role === 'approver';
  const intro = isApprover
    ? `Approve publishes a piece right away. Send back returns it to ${agent.reviewer.name}.`
    : `Pieces ${agent.approver.name} sent back. Your revision goes back to ${agent.approver.name} for approval.`;
  const approveAll = isApprover && pending > 1
    ? `<form method="post" action="/r/${token}/approve-all" class="approve-all"><button class="yes">✓ Approve all ${pending}</button></form>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(agent.company)} content review</title>
<style>${STYLES}</style>
</head><body><main>
<section class="top">
  <h1>${escapeHtml(pkg.theme)}</h1>
  <p>${escapeHtml(intro)}</p>
</section>
<div class="bar"><span class="progress"></span>${approveAll}</div>
${pkg.items.map((item) => renderCard(item, { agent, role, token })).join('\n')}
<p class="done">All done. Thank you.</p>
</main><script>${SCRIPT}</script></body></html>`;
}

export function renderMessagePage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLES}</style></head>
<body><main><section class="top"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section></main></body></html>`;
}

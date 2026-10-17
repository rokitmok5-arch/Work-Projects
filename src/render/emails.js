import { CHANNEL_LABELS, escapeHtml } from './html.js';

// Email clients need inline styles and table layout.
function layout(title, inner) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f3;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d2b22;">
<tr><td style="padding:24px 24px 8px;font-size:20px;font-weight:600;">${escapeHtml(title)}</td></tr>
${inner}
</table></td></tr></table></body></html>`;
}

function button(url, label) {
  return `<tr><td style="padding:16px 24px 28px;">
<a href="${escapeHtml(url)}" style="display:inline-block;background:#1f5d3a;color:#ffffff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:8px;font-size:16px;">${escapeHtml(label)}</a>
</td></tr>`;
}

const paragraph = (html) => `<tr><td style="padding:4px 24px;font-size:15px;line-height:1.5;">${html}</td></tr>`;

export function approvalEmail({ agent, pkg, url }) {
  const n = pkg.items.length;
  const minutes = Math.max(1, Math.ceil(n / 2));
  const list = pkg.items
    .map(
      (item) => `<tr><td style="padding:10px 24px;border-top:1px solid #e6ebe7;">
<div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#5b6b60;">${CHANNEL_LABELS[item.channel]}</div>
<div style="font-size:15px;font-weight:600;padding:2px 0;">${escapeHtml(item.draft.title)}</div>
<div style="font-size:14px;color:#5b6b60;">${escapeHtml(item.draft.why)}</div>
</td></tr>`,
    )
    .join('');

  const subject = `${n} ${n === 1 ? 'piece' : 'pieces'} ready for your OK (about ${minutes} min)`;
  const html = layout(
    `${agent.approver.name}, ${n === 1 ? 'one piece is' : `${n} pieces are`} ready`,
    `${paragraph(`${escapeHtml(pkg.theme)}. Tap <b>Approve</b> to publish a piece or <b>Send back</b> to return it to ${escapeHtml(agent.reviewer.name)}.`)}
${list}
${button(url, 'Review and approve')}`,
  );
  const text = `${subject}\n\n${pkg.items.map((i) => `- ${CHANNEL_LABELS[i.channel]}: ${i.draft.title}`).join('\n')}\n\nReview: ${url}`;
  return { subject: `${agent.company}: ${subject}`, html, text };
}

export function returnedEmail({ agent, pkg, item, url }) {
  const subject = `${agent.company}: ${agent.approver.name} sent back "${item.draft.title}"`;
  const html = layout(
    'A piece was sent back',
    `${paragraph(`<b>${CHANNEL_LABELS[item.channel]}:</b> ${escapeHtml(item.draft.title)}`)}
${paragraph(`<b>${escapeHtml(agent.approver.name)}'s note:</b> ${item.note ? escapeHtml(item.note) : '<i>No note</i>'}`)}
${paragraph('Edit it yourself or have the AI rewrite it; either way the new version goes back for approval.')}
${button(url, 'Revise')}`,
  );
  return { subject, html, text: `${subject}\nNote: ${item.note ?? 'none'}\nRevise: ${url}` };
}

export function publishFailedEmail({ agent, pkg, item, url }) {
  const subject = `${agent.company}: publishing failed for "${item.draft.title}"`;
  const html = layout(
    'Approved, but publishing failed',
    `${paragraph(`${escapeHtml(agent.approver.name)} approved this ${CHANNEL_LABELS[item.channel]} piece, but sending it failed: ${escapeHtml(item.publishError)}`)}
${button(url, 'Retry or revise')}`,
  );
  return { subject, html, text: `${subject}\n${item.publishError}\n${url}` };
}

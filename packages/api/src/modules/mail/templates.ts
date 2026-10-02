const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export interface StaffInviteEmailData {
  fullName: string;
  roleLabel: string;
  inviteUrl: string;
  expiresAt: Date;
  invitedBy: string | null;
  clients: number;
}

/** The staff invite: plain text plus simple, client-safe HTML (tables, inline styles), no tracking. */
export function staffInviteEmail(d: StaffInviteEmailData): { subject: string; html: string; text: string } {
  const expires = d.expiresAt.toLocaleString('en-GB', {
    timeZone: 'Indian/Mauritius', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const who = d.invitedBy ? `${d.invitedBy} has invited you` : 'You have been invited';
  const scope = d.clients ? ` You will start with ${d.clients} client${d.clients > 1 ? 's' : ''}.` : '';
  const subject = 'Your VAT Assist invitation (Nex-Gen Africa)';
  const text = [
    `Hello ${d.fullName},`,
    '',
    `${who} to VAT Assist as ${d.roleLabel}.${scope}`,
    '',
    'Set your password and authenticator here (the link works once):',
    d.inviteUrl,
    '',
    `It expires on ${expires} (Mauritius time). If you were not expecting this, ignore this email.`,
    '',
    'VAT Assist by Nex-Gen Africa',
  ].join('\n');
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#1b2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d7dbe3;border-radius:8px">
<tr><td style="padding:28px 28px 8px">
<p style="margin:0 0 16px;font-size:16px">Hello ${esc(d.fullName)},</p>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${esc(who)} to <strong>VAT Assist</strong> as ${esc(d.roleLabel)}.${esc(scope)}</p>
<p style="margin:24px 0"><a href="${esc(d.inviteUrl)}" style="background:#23408e;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:4px;font-weight:bold;display:inline-block">Set up my sign-in</a></p>
<p style="margin:0 0 8px;font-size:14px;color:#5b6577">Or paste this link into your browser (it works once):<br><a href="${esc(d.inviteUrl)}" style="color:#23408e;word-break:break-all">${esc(d.inviteUrl)}</a></p>
<p style="margin:16px 0 0;font-size:14px;color:#5b6577">It expires on ${esc(expires)} (Mauritius time). If you were not expecting this, ignore this email.</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;color:#5b6577">VAT Assist by Nex-Gen Africa</td></tr>
</table></td></tr></table>
</body></html>`;
  return { subject, html, text };
}

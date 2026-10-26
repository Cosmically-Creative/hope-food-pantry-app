import { escapeHtml, singleLine } from './html.js';

export type MailShift = {
  role: string;
  eventTitle: string;
  location: string;
  whenLabel: string;
};

export type RenderedMail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * Confirmation and cancellation letters.
 * Email clients do not load the app stylesheet, so the HTML repeats the fallback
 * ink and blue from public/brand/tokens.css.
 */
export function renderConfirmation(input: {
  volunteerName: string;
  shift: MailShift;
  manageUrl: string;
  replyTo: string;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  const name = singleLine(input.volunteerName);
  return render({
    subject: `You're signed up for ${role}`,
    hello: `You are signed up for ${role}.`,
    greeting: `Hello ${name},`,
    shift: input.shift,
    linkLabel: 'Open this signup',
    linkNote: 'You can cancel or switch this signup from that link. Use the separate link for each signup.',
    manageUrl: input.manageUrl,
    replyTo: input.replyTo,
  });
}

export function renderCancellation(input: {
  volunteerName: string;
  shift: MailShift;
  manageUrl: string;
  replyTo: string;
  linkNote?: string;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  const name = singleLine(input.volunteerName);
  return render({
    subject: `Your signup for ${role} is cancelled`,
    hello: `Your signup for ${role} is cancelled. The spot is open for someone else.`,
    greeting: `Hello ${name},`,
    shift: input.shift,
    linkLabel: 'Open this signup',
    linkNote: input.linkNote ?? 'That link opens the cancelled signup.',
    manageUrl: input.manageUrl,
    replyTo: input.replyTo,
  });
}

export function renderChanged(input: {
  volunteerName: string;
  shift: MailShift;
  manageUrl: string;
  replyTo: string;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  return changedLetter(input, `Your ${role} shift has changed`, `The time or place for your ${role} shift has changed.`);
}

export function renderMoved(input: {
  volunteerName: string;
  shift: MailShift;
  manageUrl: string;
  replyTo: string;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  return changedLetter(input, `Your signup was moved to ${role}`, 'A coordinator moved your signup to a different shift.');
}

export function renderSwitched(input: {
  volunteerName: string;
  shift: MailShift;
  manageUrl: string;
  replyTo: string;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  return changedLetter(input, `Your signup was switched to ${role}`, 'You switched this signup to a different shift.');
}

function changedLetter(
  input: { volunteerName: string; shift: MailShift; manageUrl: string; replyTo: string },
  subject: string,
  hello: string,
): RenderedMail {
  const name = singleLine(input.volunteerName);
  return render({
    subject,
    hello,
    greeting: `Hello ${name},`,
    shift: input.shift,
    linkLabel: 'Open this signup',
    linkNote: 'This link replaces the earlier one. The previous link no longer works.',
    manageUrl: input.manageUrl,
    replyTo: input.replyTo,
  });
}

export function renderReminder(input: {
  volunteerName: string;
  shift: MailShift;
  unsubscribeUrl: string;
  replyTo: string;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  const name = singleLine(input.volunteerName);
  const subject = `Reminder: ${role}`;
  const hello = `You are still signed up for ${role}.`;
  const cancelNote = 'To cancel, use the link in your confirmation email.';
  const stopNote = `To stop reminder emails for this signup, open ${input.unsubscribeUrl}. The pantry reads mail sent to ${input.replyTo}. Stopping reminders does not cancel the signup. Confirmation, change, and cancellation emails still arrive.`;
  const greeting = `Hello ${name},`;
  const when = input.shift.whenLabel;
  const place = input.shift.location.trim();
  const lines = [
    greeting,
    '',
    hello,
    '',
    input.shift.eventTitle,
    when,
    ...(place ? [place] : []),
    '',
    cancelNote,
    '',
    stopNote,
    '',
    'Hope Food Pantry',
  ];
  const htmlPlace = place ? `<br>${escapeHtml(place)}` : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px;background:#f4fafd;color:#222;font-family:sans-serif;line-height:1.5">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(hello)}</p>
<p>${escapeHtml(input.shift.eventTitle)}<br>${escapeHtml(when)}${htmlPlace}</p>
<p>${escapeHtml(cancelNote)}</p>
<p><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#222">Stop reminder emails</a></p>
<p>The pantry reads mail sent to ${escapeHtml(input.replyTo)}. Stopping reminders does not cancel the signup. Confirmation, change, and cancellation emails still arrive.</p>
<p>Hope Food Pantry</p>
</body>
</html>`;
  return { subject, text: lines.join('\n'), html };
}

export function renderMagicLink(input: { signInUrl: string; replyTo: string }): RenderedMail {
  const subject = 'Sign in to Hope Volunteer';
  const hello = 'Use this link to sign in. It expires in 15 minutes and works once.';
  const note = 'Opening the link does not sign you in. Use the button on the page. If you did not ask for this, you can ignore it.';
  const text = ['Hello,', '', hello, '', input.signInUrl, '', note, `Replies go to ${input.replyTo}.`, '', 'Hope Food Pantry'].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px;background:#f4fafd;color:#222;font-family:sans-serif;line-height:1.5">
<p>Hello,</p>
<p>${escapeHtml(hello)}</p>
<p><a href="${escapeHtml(input.signInUrl)}" style="color:#222">Sign in</a></p>
<p>${escapeHtml(note)} Replies go to ${escapeHtml(input.replyTo)}.</p>
<p>Hope Food Pantry</p>
</body>
</html>`;
  return { subject, text, html };
}

function render(input: {
  subject: string;
  greeting: string;
  hello: string;
  shift: MailShift;
  linkLabel: string;
  linkNote: string;
  manageUrl: string;
  replyTo: string;
}): RenderedMail {
  const when = input.shift.whenLabel;
  const place = input.shift.location.trim();
  const lines = [
    input.greeting,
    '',
    input.hello,
    '',
    input.shift.eventTitle,
    when,
    ...(place ? [place] : []),
    '',
    `${input.linkLabel}:`,
    input.manageUrl,
    '',
    input.linkNote,
    `Replies go to ${input.replyTo}.`,
    '',
    'Hope Food Pantry',
  ];
  const htmlPlace = place ? `<br>${escapeHtml(place)}` : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:24px;background:#f4fafd;color:#222;font-family:sans-serif;line-height:1.5">
<p>${escapeHtml(input.greeting)}</p>
<p>${escapeHtml(input.hello)}</p>
<p>${escapeHtml(input.shift.eventTitle)}<br>${escapeHtml(when)}${htmlPlace}</p>
<p><a href="${escapeHtml(input.manageUrl)}" style="color:#222">${escapeHtml(input.linkLabel)}</a></p>
<p>${escapeHtml(input.linkNote)} Replies go to ${escapeHtml(input.replyTo)}.</p>
<p>Hope Food Pantry</p>
</body>
</html>`;
  return { subject: input.subject, text: lines.join('\n'), html };
}

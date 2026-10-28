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
  groupSize?: number;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  const name = singleLine(input.volunteerName);
  return render({
    subject: `You're signed up for ${role}`,
    hello: `You are signed up for ${role}.${partyNote(input.groupSize)}`,
    greeting: `Hello ${name},`,
    shift: input.shift,
    directions: 'Use the south driveway and park in the parking lot for your shift.',
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
  groupSize?: number;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  const name = singleLine(input.volunteerName);
  const spots = input.groupSize && input.groupSize > 1 ? `The ${input.groupSize} spots this signup held are open for someone else.` : 'The spot is open for someone else.';
  return render({
    subject: `Your signup for ${role} is cancelled`,
    hello: `Your signup for ${role} is cancelled. ${spots}`,
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
  groupSize?: number;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  return changedLetter(input, `Your ${role} shift has changed`, `The time or place for your ${role} shift has changed.`);
}

export function renderMoved(input: {
  volunteerName: string;
  shift: MailShift;
  manageUrl: string;
  replyTo: string;
  groupSize?: number;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  return changedLetter(input, `Your signup was moved to ${role}`, 'A coordinator moved your signup to a different shift.');
}

export function renderSwitched(input: {
  volunteerName: string;
  shift: MailShift;
  manageUrl: string;
  replyTo: string;
  groupSize?: number;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  return changedLetter(input, `Your signup was switched to ${role}`, 'You switched this signup to a different shift.');
}

function changedLetter(
  input: { volunteerName: string; shift: MailShift; manageUrl: string; replyTo: string; groupSize?: number },
  subject: string,
  hello: string,
): RenderedMail {
  const name = singleLine(input.volunteerName);
  return render({
    subject,
    hello: `${hello}${partyNote(input.groupSize)}`,
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
  groupSize?: number;
}): RenderedMail {
  const role = singleLine(input.shift.role);
  const name = singleLine(input.volunteerName);
  const subject = `Reminder: ${role}`;
  const hello = `You are still signed up for ${role}.${partyNote(input.groupSize)}`;
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

export type CoordinatorNoticeAction = 'signup' | 'cancel' | 'switch' | 'move' | 'change';

/** A roster notice for coordinators. It names the person and links to the shift. It does not include the private signup link. */
export function renderCoordinatorNotice(input: {
  coordinatorName: string;
  volunteerName: string;
  volunteerEmail: string;
  phone: string | null;
  groupSize?: number;
  action: CoordinatorNoticeAction;
  shift: MailShift;
  fromShift?: MailShift;
  rosterUrl: string;
  replyTo: string;
}): RenderedMail {
  const copy = noticeCopy(input);
  const greeting = `Hello ${singleLine(input.coordinatorName)},`;
  const phone = input.phone ? singleLine(input.phone) : '';
  const contact = [singleLine(input.volunteerName), singleLine(input.volunteerEmail), ...(phone ? [phone] : [])];
  const when = input.shift.whenLabel;
  const place = input.shift.location.trim();
  const lines = [
    greeting,
    '',
    copy.hello,
    '',
    ...contact,
    '',
    input.shift.eventTitle,
    when,
    ...(place ? [place] : []),
    '',
    'Open this shift:',
    input.rosterUrl,
    '',
    'That page lists the roster. Sign in if you are not already.',
    `Replies go to ${input.replyTo}.`,
    '',
    'Hope Food Pantry',
  ];
  const htmlPlace = place ? `<br>${escapeHtml(place)}` : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:24px;background:#f4fafd;color:#222;font-family:sans-serif;line-height:1.5">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(copy.hello)}</p>
<p>${contact.map((line) => escapeHtml(line)).join('<br>')}</p>
<p>${escapeHtml(input.shift.eventTitle)}<br>${escapeHtml(when)}${htmlPlace}</p>
<p><a href="${escapeHtml(input.rosterUrl)}" style="color:#222">Open this shift</a></p>
<p>That page lists the roster. Sign in if you are not already. Replies go to ${escapeHtml(input.replyTo)}.</p>
<p>Hope Food Pantry</p>
</body>
</html>`;
  return { subject: copy.subject, text: lines.join('\n'), html };
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

function noticeCopy(input: {
  volunteerName: string;
  groupSize?: number;
  action: CoordinatorNoticeAction;
  shift: MailShift;
  fromShift?: MailShift;
}): { subject: string; hello: string } {
  const name = singleLine(input.volunteerName);
  const role = singleLine(input.shift.role);
  const party = partyNote(input.groupSize);
  const from = input.fromShift
    ? ` from ${singleLine(input.fromShift.role)} (${singleLine(input.fromShift.whenLabel)})`
    : '';
  if (input.action === 'signup') {
    return { subject: `${name} signed up for ${role}`, hello: `${name} signed up for ${role}.${party}` };
  }
  if (input.action === 'cancel') {
    const spots =
      input.groupSize && input.groupSize > 1
        ? `The ${input.groupSize} spots this signup held are open for someone else.`
        : 'The spot is open for someone else.';
    return {
      subject: `${name}'s signup for ${role} was cancelled`,
      hello: `${name}'s signup for ${role} is cancelled. ${spots}`,
    };
  }
  if (input.action === 'switch') {
    return { subject: `${name} switched to ${role}`, hello: `${name} switched${from} to ${role}.${party}` };
  }
  if (input.action === 'move') {
    return { subject: `${name} was moved to ${role}`, hello: `${name} was moved${from} to ${role}.${party}` };
  }
  return {
    subject: `${name}'s ${role} shift changed`,
    hello: `The time or place for ${name}'s ${role} shift has changed.${party}`,
  };
}

function partyNote(groupSize: number | undefined): string {
  if (!groupSize || groupSize <= 1) return '';
  return ` This signup holds ${groupSize} spots.`;
}

function render(input: {
  subject: string;
  greeting: string;
  hello: string;
  shift: MailShift;
  directions?: string;
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
    ...(input.directions ? ['', input.directions] : []),
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
  const htmlDirections = input.directions ? `<p>${escapeHtml(input.directions)}</p>` : '';
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
${htmlDirections}
<p><a href="${escapeHtml(input.manageUrl)}" style="color:#222">${escapeHtml(input.linkLabel)}</a></p>
<p>${escapeHtml(input.linkNote)} Replies go to ${escapeHtml(input.replyTo)}.</p>
<p>Hope Food Pantry</p>
</body>
</html>`;
  return { subject: input.subject, text: lines.join('\n'), html };
}

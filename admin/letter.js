/* Printable verification letter. Content is built server-side
   (buildLetterDocument) from supervisor-approved hours only. */

const id = new URLSearchParams(location.search).get('id') || '';
const $ = (sel) => document.getElementById(sel);

function setText(elId, text) {
  $(elId).textContent = text || '';
}

function showState(message, isError) {
  const box = $('letter-state');
  box.className = 'state-box' + (isError ? ' state-error' : '');
  box.setAttribute('role', isError ? 'alert' : 'status');
  box.textContent = message;
  box.hidden = false;
}

function render(data) {
  const doc = data.document;
  setText('org-name', doc.org.name);
  setText('org-address', doc.org.addressLines.join(' · '));
  setText('org-contact', doc.org.email + ' · ' + doc.org.website);
  setText('issue-date', doc.issueDate ? doc.issueDate : 'Issue date: assigned when approved');
  setText('letter-number', 'Letter No. ' + doc.letterNumber);
  setText('salutation', doc.salutation);
  setText('subject', doc.subject);

  const body = $('body');
  body.innerHTML = '';
  doc.paragraphs.forEach((p) => {
    const el = document.createElement('p');
    el.textContent = p;
    body.appendChild(el);
  });

  const table = $('summary');
  table.innerHTML = '';
  doc.summary.forEach(([k, v]) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = k;
    const td = document.createElement('td');
    td.textContent = v;
    tr.append(th, td);
    table.appendChild(tr);
  });

  setText('closing', doc.closing);
  const signer = $('signer');
  signer.innerHTML = '';
  if (doc.signer) {
    const name = document.createElement('strong');
    name.textContent = doc.signer.name;
    signer.append(name, document.createElement('br'), document.createTextNode(doc.signer.title + ', ' + doc.org.name));
  } else {
    signer.textContent = 'Authorized signer — name and title are added when an administrator approves this letter.';
  }
  setText('letter-foot', doc.org.name + ' is a ' + doc.org.status + ' · EIN ' + doc.org.ein);

  const banner = $('draft-banner');
  const watermark = $('watermark');
  if (doc.isDraft || doc.isVoid) {
    banner.hidden = false;
    banner.className = 'letter-banner no-print ' + (doc.isVoid ? 'banner-void' : 'banner-draft');
    banner.textContent = doc.isVoid
      ? 'This letter has been VOIDED and is not valid.'
      : 'DRAFT — not valid until an authorized administrator reviews and approves it. Printed drafts carry a DRAFT watermark.';
    watermark.hidden = false;
    watermark.textContent = doc.isVoid ? 'VOID' : 'DRAFT';
  } else {
    banner.hidden = true;
    watermark.hidden = true;
  }

  $('letter-status').innerHTML = '';
  const badge = document.createElement('span');
  badge.className = 'badge ' + (doc.isDraft ? 'badge-warn' : doc.isVoid ? 'badge-muted' : 'badge-ok');
  badge.textContent = doc.isDraft ? 'Draft' : doc.isVoid ? 'Void' : 'Approved';
  $('letter-status').appendChild(badge);
  $('approve-btn').hidden = !data.can_approve;

  $('letter-state').hidden = true;
  $('toolbar').hidden = false;
  $('letter').hidden = false;
  document.title = doc.letterNumber + ' — Verification Letter';
}

async function load() {
  showState('Loading letter…');
  let res;
  try {
    res = await fetch('/api/admin/letters?id=' + encodeURIComponent(id), { credentials: 'same-origin' });
  } catch (e) {
    return showState('Could not reach the server. Check your connection and reload.', true);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return showState('Please sign in to the dashboard first, then reopen this letter.', true);
  if (!res.ok) return showState(data.error || 'Could not load this letter.', true);
  render(data);
}

$('print-btn').addEventListener('click', () => window.print());

const modal = $('approve-modal');
$('approve-btn').addEventListener('click', () => {
  $('confirm-reviewed').checked = false;
  $('approve-error').hidden = true;
  modal.showModal();
});
$('approve-cancel').addEventListener('click', () => modal.close());
$('approve-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('approve-error');
  if (!$('confirm-reviewed').checked) {
    err.textContent = 'Check the confirmation box to approve.';
    err.hidden = false;
    return;
  }
  const btn = $('approve-submit');
  btn.disabled = true;
  btn.textContent = 'Approving…';
  try {
    const res = await fetch('/api/admin/approve-letter', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, confirm_reviewed: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.error || 'Could not approve this letter.';
      err.hidden = false;
      return;
    }
    modal.close();
    await load();
  } catch (ex) {
    err.textContent = 'Could not reach the server. Try again.';
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Approve letter';
  }
});

load();

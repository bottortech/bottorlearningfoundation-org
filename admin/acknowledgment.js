/* Donor thank-you letter: preview, edit (drafts), finalize & sign, record as sent.
   Letter content is built server-side (buildAcknowledgmentDocument). Nothing is
   ever sent from here: print or save as PDF, send it yourself, then record it. */

const id = new URLSearchParams(location.search).get('id') || '';
const $ = (sel) => document.getElementById(sel);
const METHODS = { mail: 'Mail', email: 'Email', in_person: 'In person', other: 'Other' };
let data = null;

function text(elId, value) {
  $(elId).textContent = value || '';
}

function showState(message, isError) {
  const box = $('letter-state');
  box.className = 'state-box' + (isError ? ' state-error' : '');
  box.textContent = message;
  box.hidden = false;
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

async function api(path, method, body) {
  try {
    const res = await fetch('/api/admin/' + path, {
      method: method || 'GET', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Could not reach the server. Check your connection.' } };
  }
}

function errorText(res) {
  return (res.data.error || 'Something went wrong.') + (res.data.errors ? ' ' + Object.values(res.data.errors).join(' ') : '');
}

function render() {
  const doc = data.document;
  const ack = data.acknowledgment;
  text('org-name', doc.org.name);
  text('org-address', doc.org.addressLines.join(' · '));
  text('org-contact', doc.org.email + ' · ' + doc.org.website);
  text('issue-date', doc.issueDate || 'Date: added when the letter is finalized');
  const rec = $('recipient');
  rec.innerHTML = '';
  [doc.recipient.name].concat(doc.recipient.donor_type === 'organization' && doc.recipient.contact_name ? ['Attn: ' + doc.recipient.contact_name] : [])
    .concat(doc.recipient.address_lines || []).forEach((line, i) => {
      if (i) rec.appendChild(document.createElement('br'));
      rec.appendChild(document.createTextNode(line));
    });
  text('salutation', doc.salutation);

  const body = $('body');
  body.innerHTML = '';
  [doc.opening, doc.restrictionLine].filter(Boolean).forEach((p) => {
    const el = document.createElement('p');
    el.textContent = p;
    body.appendChild(el);
  });

  const table = $('details');
  table.innerHTML = '';
  doc.details.forEach(([k, v]) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = k;
    const td = document.createElement('td');
    td.textContent = v;
    tr.append(th, td);
    table.appendChild(tr);
  });

  const items = $('items-block');
  items.innerHTML = '';
  if (doc.items.length) {
    const h = document.createElement('p');
    h.innerHTML = '<strong>Items received</strong>';
    const ul = document.createElement('ul');
    ul.className = 'ack-items';
    doc.items.forEach((i) => {
      const li = document.createElement('li');
      li.textContent = i.quantity + ' × ' + i.description + (i.category ? ' (' + i.category.toLowerCase() + ')' : '');
      ul.appendChild(li);
    });
    items.append(h, ul);
  }

  const tax = $('tax');
  tax.innerHTML = '';
  doc.taxParagraphs.forEach((p) => {
    const el = document.createElement('p');
    el.className = 'ack-tax';
    el.textContent = p;
    tax.appendChild(el);
  });

  const closing = $('closing-line');
  closing.innerHTML = '';
  const c1 = document.createElement('span');
  c1.textContent = doc.closing;
  closing.append(c1, document.createElement('br'), document.createElement('br'), document.createTextNode(doc.signoff));

  const signer = $('signer');
  signer.innerHTML = '';
  if (doc.signer) {
    const n = document.createElement('strong');
    n.textContent = doc.signer.name;
    signer.append(n, document.createElement('br'), document.createTextNode(doc.signer.title + ', ' + doc.org.name));
  } else {
    signer.textContent = 'Byron Brown, President, Bottor Learning Foundation (added when the letter is finalized)';
  }
  const img = $('sig-img');
  if (data.signature_data_url) {
    img.src = data.signature_data_url;
    img.hidden = false;
    $('sig-space').hidden = true;
  } else {
    img.hidden = true;
    $('sig-space').hidden = false;
  }

  const ps = $('postscript');
  ps.hidden = !doc.postscript;
  ps.textContent = doc.postscript ? 'P.S. ' + doc.postscript : '';
  text('letter-foot', doc.org.name + ' is a ' + doc.org.status + ' · EIN ' + doc.org.ein + ' · Letter ' + doc.letterNumber);

  const banner = $('draft-banner');
  const wm = $('watermark');
  banner.hidden = !(doc.isDraft || doc.isVoid);
  wm.hidden = banner.hidden;
  if (doc.isVoid) {
    banner.className = 'letter-banner no-print banner-void';
    banner.textContent = 'This letter is VOID' + (ack.void_reason ? ': ' + ack.void_reason : '') + '.';
    wm.textContent = 'VOID';
  } else if (doc.isDraft) {
    banner.className = 'letter-banner no-print banner-draft';
    banner.textContent = 'DRAFT. Review and edit, then finalize to set the date and signature. Printed drafts carry a DRAFT watermark.';
    wm.textContent = 'DRAFT';
  }

  const badge = document.createElement('span');
  const STATUS = { draft: ['Draft', 'badge-warn'], ready: ['Ready to send', 'badge-blue'], sent: ['Sent' + (ack.sent_on ? ' ' + ack.sent_on : '') + (ack.sent_method ? ' · ' + METHODS[ack.sent_method] : ''), 'badge-ok'], void: ['Void', 'badge-muted'] };
  badge.className = 'badge ' + STATUS[ack.status][1];
  badge.textContent = STATUS[ack.status][0];
  $('letter-status').innerHTML = '';
  $('letter-status').appendChild(badge);

  $('finalize-btn').hidden = !data.can_finalize;
  $('sent-btn').hidden = ack.status !== 'ready';
  $('void-btn').hidden = ack.status === 'void';
  renderEditor();

  $('letter-state').hidden = true;
  $('toolbar').hidden = false;
  $('letter').hidden = false;
  document.title = doc.letterNumber + ' · Thank-You Letter';
}

function renderEditor() {
  const editor = $('editor');
  editor.hidden = !data.can_edit;
  if (!data.can_edit) return;
  const c = data.acknowledgment.content;
  const form = $('editor-form');
  form.salutation.value = c.wording.salutation;
  form.opening.value = c.wording.opening;
  form.closing.value = c.wording.closing;
  form.postscript.value = c.wording.postscript || '';
  const src = $('ed-src');
  src.innerHTML = '';
  Object.entries(data.special_sources).forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    o.selected = v === c.tax.special_source;
    src.appendChild(o);
  });
  form.querySelectorAll('input[name=goods_services]').forEach((r) => { r.checked = r.value === c.tax.goods_services; });
  form.goods_services_description.value = c.tax.goods_services_description || '';
  form.goods_services_value.value = c.tax.goods_services_value == null ? '' : c.tax.goods_services_value;
  syncEditor();
}

function syncEditor() {
  const form = $('editor-form');
  const standard = form.special_source.value === 'none';
  $('gs-fields').hidden = !standard;
  $('src-hint').hidden = standard;
  const provided = (form.querySelector('input[name=goods_services]:checked') || {}).value === 'provided';
  $('gs-detail').hidden = !provided;
}

$('editor-form').addEventListener('change', syncEditor);
$('editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const res = await api('acknowledgments?id=' + encodeURIComponent(id), 'PATCH', {
    salutation: form.salutation.value, opening: form.opening.value, closing: form.closing.value, postscript: form.postscript.value,
    special_source: form.special_source.value,
    goods_services: (form.querySelector('input[name=goods_services]:checked') || {}).value,
    goods_services_description: form.goods_services_description.value,
    goods_services_value: form.goods_services_value.value
  });
  btn.disabled = false;
  btn.textContent = 'Save draft';
  const err = $('editor-error');
  if (!res.ok) {
    err.textContent = errorText(res);
    err.hidden = false;
    return;
  }
  err.hidden = true;
  await load();
});

/* ---------- Actions (finalize, sent, void) ---------- */

const modal = $('action-modal');
let modalSubmit = null;

function openAction(title, bodyHtml, submitLabel, onSubmit, onOpen) {
  text('action-title', title);
  $('action-body').innerHTML = bodyHtml;
  $('action-submit').textContent = submitLabel;
  $('action-error').hidden = true;
  modalSubmit = onSubmit;
  modal.showModal();
  if (onOpen) onOpen($('action-body'));
}

$('action-cancel').addEventListener('click', () => modal.close());
$('action-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('action-submit');
  btn.disabled = true;
  const res = await modalSubmit(new FormData(e.target), e.target);
  btn.disabled = false;
  if (!res.ok) {
    $('action-error').textContent = errorText(res);
    $('action-error').hidden = false;
    return;
  }
  modal.close();
  await load();
});

$('finalize-btn').addEventListener('click', async () => {
  const sig = await api('signature');
  const has = sig.ok && sig.data.has_signature;
  openAction('Finalize and sign this letter',
    '<p>Finalizing locks the letter, sets today’s date, and records you as the signer. The gift details are re-checked against the donation record.</p>' +
    '<fieldset class="perm-group"><legend>Signature</legend>' +
    '<label class="check-label"><input type="radio" name="sig" value="hand" checked> <span>Leave space to sign by hand</span></label>' +
    '<label class="check-label"><input type="radio" name="sig" value="digital"' + (has ? '' : ' disabled') + '> <span>Use my digital signature' +
    (has ? '' : ' (upload one on the Thank-you Letters page first)') + '</span></label>' +
    (has ? '<img class="sig-preview" alt="Your saved signature" src="' + sig.data.data_url + '">' : '') + '</fieldset>' +
    '<label class="check-label"><input type="checkbox" name="confirm"> <span>I have reviewed this letter and the gift details are correct.</span></label>' +
    '<p class="field-hint">Nothing is sent. Print or save the letter as a PDF and send it yourself, then record it as sent.</p>',
    'Finalize letter',
    (fd, form) => api('finalize-acknowledgment', 'POST', { id, confirm_reviewed: form.confirm.checked, use_signature: fd.get('sig') === 'digital' }));
});

$('sent-btn').addEventListener('click', () => {
  openAction('Record as sent',
    '<p>Record how and when you sent this letter. This doesn’t send anything.</p>' +
    '<div class="m-grid"><div><label for="s-date">Date sent</label><input type="date" id="s-date" name="sent_on" max="' + today() + '" value="' + today() + '"></div>' +
    '<div><label for="s-method">Method</label><select id="s-method" name="sent_method">' +
    Object.entries(METHODS).map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select></div></div>' +
    '<label for="s-notes">Notes (optional)</label><input type="text" id="s-notes" name="notes" maxlength="1000">',
    'Record as sent',
    (fd) => api('acknowledgment-sent', 'POST', { id, sent_on: fd.get('sent_on'), sent_method: fd.get('sent_method'), notes: fd.get('notes') }));
});

$('void-btn').addEventListener('click', () => {
  openAction('Void this letter',
    '<p>A void letter is kept in the history but can’t be sent. You can then create a new letter for this donation.</p>' +
    '<label for="v-r">Reason</label><textarea id="v-r" name="reason" rows="3"></textarea>',
    'Void letter',
    (fd) => api('void-acknowledgment', 'POST', { id, reason: fd.get('reason') }));
});

$('print-btn').addEventListener('click', () => window.print());

async function load() {
  const res = await api('acknowledgments?id=' + encodeURIComponent(id));
  if (res.status === 401) return showState('Please sign in to the portal first, then reopen this letter.', true);
  if (!res.ok) return showState(res.data.error || 'Could not load this letter.', true);
  data = res.data;
  render();
}

load();

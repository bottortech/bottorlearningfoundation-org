import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { can } from '../permissions.js';
import { ORG } from '../org.js';
import { categoriesBySlugAndId } from './inventory.js';
import { formatLongDate } from './letters.js';
import { cleanMultiline, cleanText, isUuid, isValidDate, todayInOrgTimeZone } from '../../../js/volunteer-core.js';

// Donor thank-you / written acknowledgment letters.
//
// Gift FACTS (date, amount, items, restriction) always come from the donation
// record and are never editable in the letter, so a letter can't show a wrong
// date or amount. Only the friendly wording is editable. Item gifts are
// described, never valued. Nothing is ever sent automatically.

export const SENT_METHODS = ['mail', 'email', 'in_person', 'other'];

// Gifts that get a thank-you without tax wording (check with the accountant).
export const SPECIAL_SOURCES = {
  none: 'Standard gift',
  daf: 'Donor-advised fund grant',
  ira: 'IRA / retirement account distribution',
  services: 'Donated services',
  vehicle: 'Vehicle',
  securities: 'Stock, securities, or cryptocurrency',
  real_property: 'Real estate or other property needing appraisal'
};

const MAX_SIGNATURE_BYTES = 500 * 1024;
const SIGNATURE_TYPES = ['image/png', 'image/jpeg'];
const MISSION = 'Bottor Learning Foundation advances literacy, innovation, and STEM through invention-based learning that empowers young inventors, creative problem-solvers, and future entrepreneurs.';

function fail(errors) {
  return new HttpError(422, 'Please correct the highlighted fields.', { errors: errors });
}

function money(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signaturePath(staffId) {
  return 'signatures/' + staffId;
}

/* ---------- Facts from the donation record ---------- */

async function loadFacts(ctx, donationId) {
  const donation = await ctx.repo.get('donations', donationId);
  if (!donation) throw new HttpError(404, 'Donation not found.');
  const donor = donation.donor_id ? await ctx.repo.get('donors', donation.donor_id) : null;
  const items = await ctx.repo.list('donation_items', { eq: { donation_id: donation.id } });
  const cats = await categoriesBySlugAndId(ctx);
  return {
    donation: donation,
    donor: donor,
    facts: {
      donation_type: donation.donation_type,
      received_on: donation.received_on,
      amount: donation.donation_type === 'monetary' ? Number(donation.amount) : null,
      items: items.map(function (i) {
        return { description: i.description, quantity: i.quantity, category: (cats.byId.get(i.category_id) || {}).name || '' };
      }),
      restriction_purpose: donation.restriction === 'restricted' ? donation.restriction_purpose : null
    },
    recipient: donor ? {
      name: donor.name,
      donor_type: donor.donor_type,
      contact_name: donor.contact_name || null,
      address_lines: [donor.address_line1, donor.address_line2, [donor.city, donor.state].filter(Boolean).join(', ') + (donor.postal_code ? ' ' + donor.postal_code : '')]
        .map(function (l) { return cleanText(l || ''); }).filter(Boolean)
    } : null
  };
}

function defaultSalutation(recipient) {
  if (recipient.donor_type === 'organization') return recipient.contact_name ? 'Dear ' + recipient.contact_name + ',' : 'Dear Friends at ' + recipient.name + ',';
  return 'Dear ' + recipient.name + ',';
}

function defaultWording(facts, recipient) {
  return {
    salutation: defaultSalutation(recipient),
    opening: 'Thank you for your generous ' + (facts.donation_type === 'monetary' ? 'gift' : 'donation') +
      ' to Bottor Learning Foundation. ' + MISSION.replace('Bottor Learning Foundation advances', 'Your support helps us advance'),
    closing: 'We are grateful for your generosity and for your belief in the young people we serve.',
    postscript: ''
  };
}

/* ---------- Letter document (pure) ---------- */

/**
 * Build the printable letter from a stored acknowledgment. Pure function.
 * The tax paragraph is chosen from the recorded facts and answers; it never
 * claims the letter satisfies any legal requirement.
 */
export function buildAcknowledgmentDocument(ack, org) {
  const o = org || ORG;
  const c = ack.content;
  const f = c.facts;
  const tax = c.tax;
  const isMoney = f.donation_type === 'monetary';

  const details = [['Donor', c.recipient.name], ['Date received', formatLongDate(f.received_on)]];
  if (isMoney) details.push(['Amount', money(f.amount)]);
  if (f.restriction_purpose) details.push(['Designated for', f.restriction_purpose]);
  details.push(['Letter number', ack.letter_number]);

  const taxParagraphs = [];
  if (tax.special_source === 'none') {
    taxParagraphs.push(o.name + ' is a tax-exempt organization under Section 501(c)(3) of the Internal Revenue Code (EIN ' + o.ein + ').');
    if (tax.goods_services === 'none') {
      taxParagraphs.push('No goods or services were provided in exchange for this contribution.');
    } else {
      taxParagraphs.push('In exchange for this contribution, you received ' + tax.goods_services_description +
        ', with an estimated fair market value of ' + (tax.goods_services_value == null ? '[VALUE NEEDED]' : money(tax.goods_services_value)) +
        '. The amount of your contribution that is deductible for federal income tax purposes is limited to the amount by which ' +
        (isMoney ? 'your contribution' : 'the value of your contribution') + ' exceeds the value of the goods or services provided.');
    }
    if (!isMoney) {
      taxParagraphs.push('This letter describes the items you donated but does not state their value. Determining the value of donated property is the donor’s responsibility.');
    }
    taxParagraphs.push('Please keep this letter for your tax records.');
  }

  return {
    status: ack.status,
    isDraft: ack.status === 'draft',
    isVoid: ack.status === 'void',
    org: o,
    letterNumber: ack.letter_number,
    issueDate: c.issue_date ? formatLongDate(c.issue_date) : null,
    recipient: c.recipient,
    salutation: c.wording.salutation,
    opening: c.wording.opening,
    restrictionLine: f.restriction_purpose ? 'As you requested, your gift is designated for ' + f.restriction_purpose + '.' : null,
    details: details,
    items: isMoney ? [] : f.items,
    taxParagraphs: taxParagraphs,
    closing: c.wording.closing,
    postscript: c.wording.postscript || null,
    signoff: 'With gratitude,',
    signer: c.signer || null
  };
}

/* ---------- Validation of the editable parts ---------- */

function validateLetterInput(body, existing) {
  const errors = {};
  const prevTax = existing ? existing.tax : {};
  const prevWording = existing ? existing.wording : {};

  const special = 'special_source' in body ? body.special_source : (prevTax.special_source || 'none');
  if (!Object.prototype.hasOwnProperty.call(SPECIAL_SOURCES, special)) errors.special_source = 'Choose how the gift was made.';
  const gs = 'goods_services' in body ? body.goods_services : prevTax.goods_services;
  if (special === 'none' && gs !== 'none' && gs !== 'provided') errors.goods_services = 'Tell us whether the donor received anything in return.';
  const gsDesc = cleanText('goods_services_description' in body ? body.goods_services_description : prevTax.goods_services_description || '');
  let gsValue = 'goods_services_value' in body ? body.goods_services_value : prevTax.goods_services_value;
  if (gsValue === '' || gsValue === undefined) gsValue = null;
  if (special === 'none' && gs === 'provided') {
    if (!gsDesc) errors.goods_services_description = 'Describe what the donor received (for example, a dinner ticket).';
    if (gsValue !== null) {
      const n = Number(gsValue);
      if (!Number.isFinite(n) || n < 0 || Math.round(n * 100) !== n * 100) errors.goods_services_value = 'Enter a dollar value, or leave it blank until you know it.';
      else gsValue = n;
    }
  }

  const wording = {};
  [['salutation', 120], ['opening', 2000], ['closing', 2000], ['postscript', 1000]].forEach(function (pair) {
    const k = pair[0];
    const v = cleanMultiline(k in body ? body[k] : prevWording[k] || '');
    if (k !== 'postscript' && !v) errors[k] = 'This can’t be empty.';
    else if (v.length > pair[1]) errors[k] = 'Please shorten this.';
    wording[k] = v;
  });

  return {
    errors: errors,
    tax: {
      special_source: special,
      goods_services: special === 'none' ? gs : null,
      goods_services_description: special === 'none' && gs === 'provided' ? gsDesc : null,
      goods_services_value: special === 'none' && gs === 'provided' ? gsValue : null
    },
    wording: wording
  };
}

/* ---------- Queries ---------- */

async function loadAck(ctx, id) {
  if (!isUuid(id)) throw new HttpError(400, 'Invalid letter id.');
  const ack = await ctx.repo.get('donor_acknowledgments', id);
  if (!ack) throw new HttpError(404, 'Letter not found.');
  return ack;
}

export async function listAcknowledgments(ctx, staff, query) {
  const [acks, donations, donors] = await Promise.all([
    ctx.repo.list('donor_acknowledgments', { order: ['generated_at', 'desc'] }),
    ctx.repo.list('donations', { eq: { status: 'active' }, order: ['received_on', 'desc'] }),
    ctx.repo.list('donors', {})
  ]);
  const donorMap = new Map(donors.map(function (d) { return [d.id, d]; }));
  const donationMap = new Map(donations.map(function (d) { return [d.id, d]; }));
  const live = new Set(acks.filter(function (a) { return a.status !== 'void'; }).map(function (a) { return a.donation_id; }));

  const pending = donations.filter(function (d) { return !live.has(d.id); }).map(function (d) {
    return {
      donation_id: d.id, received_on: d.received_on, donation_type: d.donation_type, is_historical: d.is_historical,
      donor_name: d.donor_id ? (donorMap.get(d.donor_id) || {}).name || '' : '',
      can_generate: !!d.donor_id
    };
  });
  let letters = acks.map(function (a) {
    const d = donationMap.get(a.donation_id);
    return {
      id: a.id, letter_number: a.letter_number, status: a.status, donation_id: a.donation_id,
      donor_name: a.content && a.content.recipient ? a.content.recipient.name : '',
      received_on: a.content && a.content.facts ? a.content.facts.received_on : (d ? d.received_on : null),
      generated_at: a.generated_at, issue_date: a.content ? a.content.issue_date || null : null,
      sent_on: a.sent_on, sent_method: a.sent_method
    };
  });
  if (query.status) letters = letters.filter(function (l) { return l.status === query.status; });
  return { pending: pending, letters: letters };
}

export async function pendingAcknowledgmentCount(ctx) {
  const { pending, letters } = await listAcknowledgments(ctx, null, {});
  return {
    not_started: pending.length,
    drafts: letters.filter(function (l) { return l.status === 'draft'; }).length,
    ready_to_send: letters.filter(function (l) { return l.status === 'ready'; }).length,
    recent_pending: pending.slice(0, 5)
  };
}

export async function getAcknowledgment(ctx, staff, id) {
  let ack = await loadAck(ctx, id);
  // Drafts always show the latest facts from the donation record.
  if (ack.status === 'draft') {
    const fresh = await loadFacts(ctx, ack.donation_id);
    if (fresh.recipient) ack = Object.assign({}, ack, { content: Object.assign({}, ack.content, { facts: fresh.facts, recipient: fresh.recipient }) });
  }
  let signatureDataUrl = null;
  if (ack.content.signer && ack.content.signer.signature_path) {
    const buf = await ctx.storage.download(ack.content.signer.signature_path);
    if (buf) signatureDataUrl = 'data:' + ack.content.signer.signature_type + ';base64,' + buf.toString('base64');
  }
  return {
    acknowledgment: { id: ack.id, donation_id: ack.donation_id, letter_number: ack.letter_number, status: ack.status, content: ack.content,
      sent_on: ack.sent_on, sent_method: ack.sent_method, void_reason: ack.void_reason, generated_at: ack.generated_at },
    document: buildAcknowledgmentDocument(ack, ORG),
    signature_data_url: signatureDataUrl,
    can_edit: ack.status === 'draft' && can(staff, 'acknowledgments.manage'),
    can_finalize: ack.status === 'draft' && can(staff, 'acknowledgments.sign'),
    special_sources: SPECIAL_SOURCES
  };
}

/* ---------- Actions ---------- */

function newLetterNumber(now) {
  return 'BLF-DA-' + now.getUTCFullYear() + '-' + randomBytes(3).toString('hex').toUpperCase();
}

export async function createAcknowledgment(ctx, staff, body) {
  if (!isUuid(body.donation_id)) throw new HttpError(400, 'Invalid donation id.');
  const { donation, recipient, facts } = await loadFacts(ctx, body.donation_id);
  if (donation.status === 'void') throw new HttpError(409, 'This donation is void, so it can’t be acknowledged.');
  if (!recipient) throw new HttpError(422, 'This gift has no donor record, so there’s no one to address a letter to. Add a donor to the donation first.');
  const live = (await ctx.repo.list('donor_acknowledgments', { eq: { donation_id: donation.id } })).filter(function (a) { return a.status !== 'void'; });
  if (live.length) throw new HttpError(409, 'This donation already has a thank-you letter (' + live[0].letter_number + '). Open it, or void it to start over.', { acknowledgment_id: live[0].id });

  const input = validateLetterInput(Object.assign({}, defaultWording(facts, recipient), body), null);
  if (Object.keys(input.errors).length) throw fail(input.errors);

  const now = ctx.now();
  const ack = await ctx.repo.insert('donor_acknowledgments', {
    id: randomUUID(), donation_id: donation.id, letter_number: newLetterNumber(now), status: 'draft',
    content: { recipient: recipient, facts: facts, tax: input.tax, wording: input.wording, signer: null, issue_date: null },
    generated_by: staff.id, generated_at: now.toISOString(), sent_on: null, sent_method: null, void_reason: null, notes: null
  });
  await audit(ctx, staff, 'acknowledgment.drafted', 'donor_acknowledgment', ack.id, { donation_id: donation.id, historical: donation.is_historical });
  return { acknowledgment: { id: ack.id, letter_number: ack.letter_number, status: ack.status } };
}

export async function updateAcknowledgment(ctx, staff, id, body) {
  const ack = await loadAck(ctx, id);
  if (ack.status !== 'draft') throw new HttpError(409, 'Only drafts can be edited. Void this letter and create a new one to make changes.');
  const input = validateLetterInput(body, ack.content);
  if (Object.keys(input.errors).length) throw fail(input.errors);
  const updated = await ctx.repo.update('donor_acknowledgments', ack.id, {
    content: Object.assign({}, ack.content, { tax: input.tax, wording: input.wording })
  });
  await audit(ctx, staff, 'acknowledgment.edited', 'donor_acknowledgment', ack.id, {});
  return { acknowledgment: { id: updated.id, status: updated.status } };
}

/** Freeze the letter: facts are re-read and locked, the issue date is set, and the signature (if chosen) applied. */
export async function finalizeAcknowledgment(ctx, staff, body) {
  if (!can(staff, 'acknowledgments.sign')) throw new HttpError(403, 'Only an administrator can finalize and sign letters.');
  if (body.confirm_reviewed !== true) throw new HttpError(422, 'Confirm you have reviewed the letter and the gift details.');
  const ack = await loadAck(ctx, body.id);
  if (ack.status !== 'draft') throw new HttpError(409, 'Only drafts can be finalized.');
  if (!staff.title) throw new HttpError(422, 'Add your title to your staff record before signing letters.');

  const fresh = await loadFacts(ctx, ack.donation_id);
  if (fresh.donation.status === 'void') throw new HttpError(409, 'This donation was voided. Void this letter instead.');
  if (!fresh.recipient) throw new HttpError(422, 'This gift no longer has a donor record.');
  const tax = ack.content.tax;
  if (tax.special_source === 'none' && tax.goods_services === 'provided' && tax.goods_services_value == null) {
    throw new HttpError(422, 'Enter the value of what the donor received before finalizing. The letter must state it.');
  }

  let signer = { name: staff.full_name, title: staff.title, signature_path: null, signature_type: null };
  if (body.use_signature === true) {
    const path = signaturePath(staff.id);
    const buf = await ctx.storage.download(path);
    if (!buf) throw new HttpError(422, 'Upload your signature first, or choose to sign by hand.');
    // Freeze a copy so replacing the signature later never changes issued letters.
    const frozen = 'signatures/issued/' + ack.id;
    await ctx.storage.upload(frozen, buf, sniffImageType(buf));
    signer = Object.assign(signer, { signature_path: frozen, signature_type: sniffImageType(buf) });
  }

  const content = Object.assign({}, ack.content, {
    facts: fresh.facts, recipient: fresh.recipient, signer: signer, issue_date: todayInOrgTimeZone(ctx.now())
  });
  const updated = await ctx.repo.update('donor_acknowledgments', ack.id, { status: 'ready', content: content });
  await audit(ctx, staff, 'acknowledgment.finalized', 'donor_acknowledgment', ack.id, { digital_signature: body.use_signature === true });
  return { acknowledgment: { id: updated.id, status: updated.status } };
}

export async function recordSent(ctx, staff, body) {
  const ack = await loadAck(ctx, body.id);
  if (ack.status !== 'ready') throw new HttpError(409, ack.status === 'draft' ? 'Finalize the letter before recording it as sent.' : 'This letter is already marked ' + ack.status + '.');
  const errors = {};
  if (!isValidDate(body.sent_on)) errors.sent_on = 'Enter the date it was sent.';
  else if (body.sent_on > todayInOrgTimeZone(ctx.now())) errors.sent_on = 'The date can’t be in the future.';
  if (SENT_METHODS.indexOf(body.sent_method) === -1) errors.sent_method = 'Choose how it was sent.';
  if (Object.keys(errors).length) throw fail(errors);
  const updated = await ctx.repo.update('donor_acknowledgments', ack.id, {
    status: 'sent', sent_on: body.sent_on, sent_method: body.sent_method, sent_recorded_by: staff.id,
    notes: cleanMultiline(body.notes) || null
  });
  await audit(ctx, staff, 'acknowledgment.sent_recorded', 'donor_acknowledgment', ack.id, { sent_method: body.sent_method });
  return { acknowledgment: { id: updated.id, status: updated.status } };
}

export async function voidAcknowledgment(ctx, staff, body) {
  const ack = await loadAck(ctx, body.id);
  if (ack.status === 'void') throw new HttpError(409, 'This letter is already void.');
  if (ack.status !== 'draft' && !can(staff, 'acknowledgments.sign')) {
    throw new HttpError(403, 'Only an administrator can void a finalized letter.');
  }
  const reason = cleanMultiline(body.reason);
  if (!reason) throw fail({ reason: 'Explain why this letter is being voided.' });
  const updated = await ctx.repo.update('donor_acknowledgments', ack.id, { status: 'void', void_reason: reason });
  await audit(ctx, staff, 'acknowledgment.voided', 'donor_acknowledgment', ack.id, { previous_status: ack.status });
  return { acknowledgment: { id: updated.id, status: updated.status } };
}

/* ---------- Digital signature ---------- */

function sniffImageType(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

export async function getSignature(ctx, staff) {
  const buf = await ctx.storage.download(signaturePath(staff.id));
  return { has_signature: !!buf, data_url: buf ? 'data:' + sniffImageType(buf) + ';base64,' + buf.toString('base64') : null };
}

/** Upload (or replace) the signed-in administrator's own signature image. */
export async function saveSignature(ctx, staff, body) {
  const path = signaturePath(staff.id);
  if (body.remove === true) {
    await ctx.storage.remove(path);
    await audit(ctx, staff, 'signature.removed', 'staff_user', staff.id, {});
    return { has_signature: false };
  }
  if (SIGNATURE_TYPES.indexOf(body.content_type) === -1) throw fail({ file: 'Upload a PNG or JPG image of your signature.' });
  if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.data)) throw fail({ file: 'The image could not be read.' });
  const buf = Buffer.from(body.data, 'base64');
  if (!buf.length || buf.length > MAX_SIGNATURE_BYTES) throw fail({ file: 'Signature images must be 500 KB or smaller.' });
  if (sniffImageType(buf) !== body.content_type) throw fail({ file: 'That file isn’t a valid PNG or JPG image.' });
  await ctx.storage.remove(path).catch(function () {});
  await ctx.storage.upload(path, buf, body.content_type);
  await audit(ctx, staff, 'signature.uploaded', 'staff_user', staff.id, { size_bytes: buf.length });
  return { has_signature: true };
}

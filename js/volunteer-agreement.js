/* ============================================
   BOTTOR LEARNING FOUNDATION — Volunteer Agreement
   ✅ When you change ANY wording below, bump AGREEMENT_VERSION
   and AGREEMENT_EFFECTIVE_DATE. Each volunteer's record stores
   the version they acknowledged, so older acknowledgments stay
   tied to the text they actually saw.
   ============================================ */

export const AGREEMENT_VERSION = '1.0';
export const AGREEMENT_EFFECTIVE_DATE = '2026-10-21';

export const AGREEMENT_INTRO =
  'Thank you for volunteering with Bottor Learning Foundation. This agreement explains what we ' +
  'expect of every volunteer and what you can expect from us. Please read each section carefully.';

export const AGREEMENT_SECTIONS = [
  {
    id: 'conduct',
    title: 'Code of Conduct',
    items: [
      'I will treat students, families, staff, partners, and fellow volunteers with respect and professionalism.',
      'I will not use, possess, or be under the influence of alcohol, illegal drugs, or misused substances while volunteering.',
      'I will not use profanity, harassment, threats, or any form of physical or verbal intimidation.',
      'I will follow the rules of every partner school, library, and venue where I serve.'
    ]
  },
  {
    id: 'confidentiality',
    title: 'Confidentiality',
    items: [
      'I will keep private any personal information I learn about students, families, volunteers, or partners, including names, photos, and school records.',
      'I will not take, post, or share photos or videos of students unless a staff member tells me the foundation has written permission to do so.',
      'My confidentiality obligation continues after my volunteer service ends.'
    ]
  },
  {
    id: 'attendance',
    title: 'Attendance & Reliability',
    items: [
      'I will arrive on time for scheduled shifts and check in and out with my supervisor.',
      'If I cannot attend a shift, I will notify my supervisor as early as possible.',
      'Repeated no-shows may result in the end of my placement.'
    ]
  },
  {
    id: 'youth-safety',
    title: 'Youth Safety',
    items: [
      'I will never be alone with a student out of sight of other adults. I will follow the "two adults present" practice at all times.',
      'I will not contact students privately — including by phone, text, social media, or messaging apps — or give students rides.',
      'I will not give gifts to individual students or ask for their personal contact information.',
      'If I see, hear, or suspect that a child may be harmed or unsafe, I will tell my supervising staff member immediately. Staff will contact the appropriate authorities when required.',
      'I understand that some assignments that involve youth require screening, and in some cases a background check, before I can begin.'
    ]
  },
  {
    id: 'supervision',
    title: 'Supervision',
    items: [
      'I will serve only in the assignments I am approved for and under the supervisor named for that assignment.',
      'I will follow reasonable instructions from foundation staff and partner-site staff.',
      'I will not represent myself as an employee of Bottor Learning Foundation or speak on its behalf unless authorized.'
    ]
  },
  {
    id: 'reporting',
    title: 'Accurate Reporting of Hours',
    items: [
      'I will report my service hours truthfully and accurately.',
      'I understand that only hours confirmed by an authorized supervisor are counted as verified, and that I cannot approve my own hours.',
      'I understand that falsifying hours will end my placement, and that the foundation may share the fact of a falsification with my supervising agency if I am completing court-ordered service.'
    ]
  },
  {
    id: 'non-discrimination',
    title: 'Non-Discrimination',
    items: [
      'Bottor Learning Foundation welcomes volunteers and serves students without discrimination based on race, color, religion, sex, sexual orientation, gender identity, national origin, age, disability, veteran status, or any other protected characteristic.',
      'I will treat everyone I serve and work with fairly and will not engage in discriminatory or harassing behavior.'
    ]
  },
  {
    id: 'right-to-end',
    title: "The Foundation's Right to End a Placement",
    items: [
      'Volunteering is a privilege, not a right. Bottor Learning Foundation may decline, pause, reassign, or end any volunteer placement at any time, for any lawful reason, including concerns about youth safety.',
      'I may also end my volunteer service at any time by notifying the foundation.'
    ]
  },
  {
    id: 'volunteer-status',
    title: 'Volunteer Status',
    items: [
      'I understand that I am a volunteer, that I will not be paid, and that volunteering does not create an employment relationship.',
      'For court-ordered service, I understand that the foundation verifies only the hours its supervisors observe and approve. Whether those hours satisfy a court or agency requirement is decided by that court or agency.'
    ]
  }
];

export const ACKNOWLEDGMENT_NOTICE =
  'Checking the box and typing your name records that you have read and agreed to this ' +
  'agreement. It is an acknowledgment for our volunteer records. It is not a notarized or ' +
  'certified legal signature, and the foundation may ask you to sign a paper copy before you begin.';

/** Render the agreement into a container element (browser only). */
export function renderAgreement(container, headingLevel) {
  const level = headingLevel || 3;
  container.innerHTML = '';

  const intro = document.createElement('p');
  intro.textContent = AGREEMENT_INTRO;
  container.appendChild(intro);

  AGREEMENT_SECTIONS.forEach(function (section, index) {
    const heading = document.createElement('h' + level);
    heading.id = 'agreement-' + section.id;
    heading.textContent = (index + 1) + '. ' + section.title;
    container.appendChild(heading);

    const list = document.createElement('ul');
    section.items.forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    });
    container.appendChild(list);
  });

  const version = document.createElement('p');
  version.className = 'agreement-version';
  version.textContent = 'Agreement version ' + AGREEMENT_VERSION + ' · Effective ' + AGREEMENT_EFFECTIVE_DATE;
  container.appendChild(version);
}

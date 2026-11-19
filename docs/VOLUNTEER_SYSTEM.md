# Foundation Management Portal — Setup & Operations

(Formerly the Volunteer Dashboard. It now also covers donations, inventory, impact reporting, and donor acknowledgments, which are being added in phases.)

The public site is still plain static HTML. The volunteer system adds:

| Piece | Where |
|---|---|
| Public application page | `volunteer.html` (served at `/volunteer`) |
| Printable agreement | `volunteer-agreement.html`; text and version live in `js/volunteer-agreement.js` |
| Staff dashboard | `admin/` (served at `/admin`) |
| Printable verification letter | `admin/letter.html` |
| API (Vercel serverless functions) | `api/apply.js`, `api/auth/[action].js`, `api/admin/[resource].js` |
| Business rules | `api/_lib/services/*`, `js/volunteer-core.js` (shared with the browser) |
| Database schema | `supabase/migrations/20261021000000_volunteer_management.sql` (volunteers) and `20261118000000_foundation_management.sql` (permissions, donations, inventory, impact, acknowledgments) |

Only 3 serverless functions are used, which keeps the project well under the Vercel Hobby plan's limit of 12.

## One-time setup

### 1. Create the Supabase project
1. Create a project at supabase.com. The free tier is enough.
2. Open **SQL Editor**, paste the whole migration file, and click **Run**.
3. Go to **Authentication → Sign In / Providers → Email** and turn **off** "Allow new users to sign up". Staff accounts are created only by an administrator.

### 2. Create staff accounts
1. Go to **Authentication → Users → Add user → Create new user**. Enter the staff member's email and a strong password, and tick "Auto confirm user".
2. In **SQL Editor**, link that login to a dashboard role:

```sql
insert into public.staff_users (auth_user_id, email, full_name, title, role, can_sign_letters)
select id, email, 'Byron Brown', 'President', 'admin', true
from auth.users where email = 'STAFF-EMAIL@example.org';
```

The roles are:

| Role | What it can do |
|---|---|
| `admin` | Everything. With `can_sign_letters = true` and a `title`, the admin can approve verification letters. Only admins see retention and the audit log. |
| `coordinator` | Review applications, record court approval, manage screening, assignments, hours corrections and CSV export, draft letters. |
| `supervisor` | Log hours and verify hours. Sees a reduced volunteer record: no admin notes, agency contact details, or background-check reference. |

If a staff member is also a volunteer, set `volunteer_id` on their `staff_users` row. They can then never verify their own hours or approve their own letter.

To remove someone's access, run `update public.staff_users set active = false where email = '...';`. It takes effect on their next request.

### 3. Add Vercel environment variables
Go to **Vercel → Project → Settings → Environment Variables**. See `.env.example`.

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` key (**secret**) |
| `SUPABASE_ANON_KEY` | Optional: the `anon` key |
| `THROTTLE_SALT` | Any long random string |

Never paste these into HTML or JS files. If they're missing, the API returns a friendly "not configured yet" message (HTTP 503) instead of failing silently.

### 4. Verify on a Preview deployment first
Push to a branch and open the Vercel Preview URL. Then:
- Submit a test application at `/volunteer`.
- Sign in at `/admin` and approve it.
- Create an assignment, log hours, verify them, draft a letter, then approve it and print it.

Delete the test records afterwards from Supabase **Table Editor**.

## Local preview (no Supabase needed)

```
npm install
npm run dev      # http://localhost:3000/volunteer and http://localhost:3000/admin
npm test         # 60 tests: validation, permissions, hours, approvals, letters
```

`npm run dev` uses an **in-memory demo database** with fictional people. The demo sign-in accounts are printed in the terminal. Nothing is saved, and `dev/` is never deployed (see `.vercelignore`).

## How the key rules work

- **Verified hours.** Only entries a staff member approves count toward progress, CSV totals, and letters. Correcting an entry saves the old values to the history and sends it back for re-verification.
- **Overlap and negative-time protection.** This is enforced in the API and again by a database constraint.
- **Youth safety.** A youth-facing assignment needs screening "Cleared" plus a background check that is "Cleared" (and not expired) or "Not required". If a volunteer loses clearance, their youth-facing placements end automatically. Background-check *reports* are never stored. Record only the status, dates, and the vendor reference number.
- **Letters.** A coordinator drafts a letter. An admin with `can_sign_letters` reviews it and approves it. On approval, the totals are re-checked against the hour records. If they changed since the draft, approval is refused. The letter shows the signer's typed name and title above a **blank line for a handwritten signature**. No signature image is ever generated. Use "Print or save as PDF" for a PDF.
- **Agreement.** The checkbox plus the typed name is stored as an *acknowledgment*, with the agreement version and a timestamp. It is labeled clearly as not a certified legal signature. Whenever the agreement wording changes, bump `AGREEMENT_VERSION` in `js/volunteer-agreement.js`.
- **Spam protection.** A hidden honeypot field, a minimum time to fill in the form, and a per-connection rate limit (5 per hour). Rate limiting stores salted hashes, never raw IP addresses.
- **Retention.** Declined or withdrawn applications become eligible for purge after 12 months, and former volunteers 3 years after service ends. Purging is a manual, admin-only step under **Data Retention** and requires typing `PURGE`. The privacy notice on `volunteer.html` states the same periods, so change both together.
- **Email.** The system **does not send email**. Staff contact applicants directly.

## Migration 002 — Foundation Management Portal (2026-11-18)

Run `supabase/migrations/20261118000000_foundation_management.sql` once, in **Supabase → SQL Editor**, before publishing Phase 2. It only **adds** tables. Existing volunteer records, staff accounts, and roles are untouched.

## Per-person permissions

- Each role still has its default access (see `api/_lib/permissions.js`).
- An administrator can grant or revoke any single permission for one person in **Portal → Team & Permissions**. Changes take effect on that person's next action and are recorded in the activity log.
- Administrator-only, never grantable: assigning permissions, approving verification letters, purging records, and approving public impact figures.
- New donation, inventory, impact, acknowledgment, and export permissions start **administrator-only**. Nobody else gets them until an administrator grants them.

## Donor thank-you letters (Phase 4)

- **Portal → Thank-you Letters** lists donations that still need a letter, plus drafts, letters ready to send, sent letters, and void letters.
- Gift facts (date, amount, items, designation) always come from the donation record and can't be edited in the letter. Fix the donation record instead; drafts update automatically. The greeting, opening, closing, and P.S. are editable.
- Tax wording:
  - Money gifts state the amount.
  - Item gifts describe the items and **never state a value**.
  - Every standard letter says whether goods or services were provided. If something was provided, the letter can't be finalized until its value is entered.
  - Gifts through a donor-advised fund or IRA, and gifts of services, vehicles, securities/crypto, or property needing appraisal, get a thank-you **without** tax wording. Check with your accountant.
  - Have your accountant review the wording once before you start sending letters.
- Finalizing and signing letters is administrator-only. When you finalize, you choose either your uploaded digital signature or space for a handwritten one. Each issued letter keeps a frozen copy of the signature used.
- **Nothing is ever sent by the system.** Print or save the letter as a PDF, send it yourself, then click **Record as sent** (date and method).

## Community impact reports (Phase 5)

Run `supabase/migrations/20261119000000_impact_reporting.sql` once in **Supabase → SQL Editor** before publishing Phase 5. It adds a "covers from" date to starting totals, and allows "table interactions" and "tablet activity plays" as event counts.

**Where each figure comes from:**

| Figure | Source |
|---|---|
| Books, clothing, educational supplies, and other items distributed | Inventory distributions. A typed event count is used only for events with no linked inventory in that category. |
| Volunteer hours | Supervisor-approved hour entries only |
| Monetary and in-kind donations | Donation records. Dollar amounts need donor-amount access. |
| Events hosted and attended | Events recorded under **Community Impact → Add event**. Past website-calendar events can be imported once each. |
| Children, families, attendance, game participants, table interactions, tablet plays | Counts recorded per event, each marked exact, about, estimated, or "or more" |

**How the figures are counted:**
- **Count types carry into totals.** A total that includes an estimate is labeled estimated, and engagement counts are never presented as people served.
- **Starting totals cover figures kept before the portal.** A report includes a starting total only when it covers the total's whole span. Entries dated inside that span are then skipped, so nothing is counted twice.
- **Reports:** monthly, quarterly, annual, all-time, and custom ranges, plus monthly charts, year over year, annual goals, and single-event reports.
- **Export:** printable PDF (with an option to leave out donation amounts) and CSV.
- **The public website figures are unchanged.** Connecting them is Phase 6.

## Public website statistics (Phase 6)

- **Portal → Community Impact → Public website** controls the home page's Community Impact section.
- **Numbers always come from your records.** They use the all-time figures, with starting totals counted once. You choose which statistics appear, their order, label, and an optional short description. You can't type a number.
- **Changes are per statistic:**
  - Add a statistic.
  - "Use new number" when your records have changed.
  - Unpublish a statistic.
  - Updating one statistic never changes the others.
  - Unpublished edits show as "You have unpublished changes" until you preview and publish them.
- **Publishing:**
  - Every publish shows an exact preview first and needs a confirmation box.
  - Only administrators can publish (`impact.publish` can't be granted to anyone else).
  - Every publish is kept in **History** and in the activity log.
- **Never publishable:** donation amounts and counts, or anything about individual donors, volunteers, or recipients. Public wording can't contain email addresses, phone numbers, or ID numbers.
- **Where the website gets its numbers:**
  - The website calls `GET /api/impact`, which returns only label, displayed figure, count type, description, and section.
  - Responses are cached briefly at the edge, so a publish appears within about 1–5 minutes.
  - **If the database is unavailable,** visitors see the last published figures saved in their browser. If they have none, they see the figures written into `index.html`. Keep those written figures as the fallback.
- **Before your first publish,** record the website's current totals under **Starting totals** with the span they cover, then check the preview matches the site.

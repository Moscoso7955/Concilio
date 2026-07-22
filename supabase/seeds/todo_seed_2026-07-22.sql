-- AI inbox scrub — 2026-07-22. Action items addressed to Christian,
-- extracted from the last ~10 days of the inbox. source_ref = Gmail
-- thread id, so re-running (or re-scanning later) never duplicates.
insert into todos (title, notes, source, source_ref) values
  ('Reply to Blaine about camera footage request', 'Car incident — he''s asking to check building camera footage', 'email', 'gmail:19f87d42aee871e1'),
  ('GFiber service visit — Wednesday 8:00 AM', 'Be available / arrange access for the tech', 'email', 'gmail:19f86d0aa7474270'),
  ('Send FWPM website direction + materials to Alphaco', 'Site build has an Aug 1 target — they''re waiting on materials', 'email', 'gmail:19f861aa92c0f963'),
  ('Reply to Credit Key with company EIN', 'Their support request #602047 is waiting on the EIN', 'email', 'gmail:19f6249629493266'),
  ('Review & pay Mariana''s weekly invoice', 'From accounts@callidusco.com, attached to her email', 'email', 'gmail:19f81cf7a8747c31'),
  ('Confirm riverfront bar timeline with Austin', 'Design permit docs by 8/10 — confirm or adjust expectations', 'email', 'gmail:19f817877ab7aab1'),
  ('Set up Unifi account (cameras / access control)', 'Dom sent the invitation — set up, then let him know', 'email', 'gmail:19f735499d547a4f'),
  ('Reply to Ellie Aykroyd — Bar Phoebe request', 'Her submission used a mistyped email; she''s following up', 'email', 'gmail:19f80aaeaba168cd'),
  ('Propose a date for Skyline Social discussion', 'Zach added you to find a date (Holtman / Futures)', 'email', 'gmail:19d546ee805f3e8f'),
  ('Review Ariel''s plant proposal — choose phases', 'Three phases; Chloe forwarded for a decision', 'email', 'gmail:19f7626ce4db4524'),
  ('Answer Micah: AIMS for TABC — notarized scan or hard copy?', 'Fort Worth Public Market TABC filing', 'email', 'gmail:1997d89755270ce3'),
  ('Pay Richard T. Bryant & Associates invoice #246467', 'Attached to Nancy''s email', 'email', 'gmail:19f1e48956831e0a'),
  ('Confirm Soca $0 federal 1065 return with Robin', 'Payroll return not due until 4/30 — but $0 federal return needed', 'email', 'gmail:19c3f9746f0d648c'),
  ('Decide on QBO Plus upgrade with Robin', 'Billable-expenses feature needs QuickBooks Plus/Advanced', 'email', 'gmail:19f6d2b998c284a4'),
  ('Tell Lisa which windows to tint', 'She''s pricing Zach''s — asks if you want any done', 'email', 'gmail:19f611f1702d0f99'),
  ('Approve Bar Phoebe coaster option', 'Soli Printing estimates attached; Chloe recommends one', 'email', 'gmail:19f150865d6c9db4'),
  ('Pay Pantera Protection invoice (weekend 07/09)', 'From Sean Rocha', 'email', 'gmail:19f5c7851149cf48'),
  ('Coordinate elevator-downtime laborer with Stephen', 'Zach: need a laborer daily until the elevator works; split with Stephen', 'email', 'gmail:19f61c331fd1f88e'),
  ('Send Aladdin bar plans to Jenny for Soca furniture', '9 barstools, 9 round — Zach asked you to attach plans', 'email', 'gmail:19f619fafcade0ad'),
  ('Choose glass thickness for Fountain Glass shelves', 'Sales order 262357 — they need thickness for pickup', 'email', 'gmail:19f3e59efd14bb13')
on conflict (source_ref) where source_ref is not null do nothing;

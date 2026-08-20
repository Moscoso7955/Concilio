-- Brand assets live IN the database, not as loose storage files: the
-- email header image is stored base64 on the sender profile and served
-- by the mail-asset function at a stable URL — moving or deleting a
-- storage file can no longer break venue branding or sent emails.
-- Run after 0034_unit_address.sql.

alter table mail_senders add column if not exists header_image_data text;
alter table mail_senders add column if not exists header_image_mime text;

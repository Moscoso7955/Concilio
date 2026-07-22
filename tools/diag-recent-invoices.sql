-- Diagnostic: latest invoice rows (run via apply-migration workflow).
select created_at, vendor, amount, needs_review, source_email_id, file_name
from invoices order by created_at desc limit 10;

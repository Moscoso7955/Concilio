-- (a) Purge junk rows from the debug era: unreviewed, no amount, and no
-- real vendor. Real emailed bills always carry vendor+amount.
delete from invoices
where needs_review = true and amount is null
  and (vendor is null or vendor = 'Unknown vendor');
select count(*) as remaining_review_rows from invoices where needs_review = true;

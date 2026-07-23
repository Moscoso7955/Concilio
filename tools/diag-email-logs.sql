-- Diagnostic: newest email-inbound breadcrumbs + latest invoice rows.
select created_at, msg, detail from function_logs
where fn = 'email-inbound' order by created_at desc limit 40;

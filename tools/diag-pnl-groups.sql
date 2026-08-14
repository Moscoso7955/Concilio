-- Diagnose P&L grouping: what the extractor logged recently, and whether
-- stored months carry group values on their lines.
select jsonb_pretty(jsonb_build_object(
  'recent_extracts', (
    select jsonb_agg(jsonb_build_object(
      'at', x.created_at,
      'file', x.detail->>'name',
      'n_months', jsonb_array_length(x.detail->'months'),
      'sample_line', x.detail->'months'->0->'lines'->0
    ) order by x.created_at desc)
    from (select * from function_logs where fn = 'pnl-extract' and msg = 'extracted'
          order by created_at desc limit 6) x
  ),
  'stored_months', (
    select jsonb_agg(jsonb_build_object(
      'unit', e.name, 'period', f.period,
      'n_lines', jsonb_array_length(f.pnl->'lines'),
      'grouped_lines', (select count(*) from jsonb_array_elements(f.pnl->'lines') l
                        where l->>'group' is not null and l->>'group' <> '')
    ) order by f.period desc)
    from financials f join ownership_entities e on e.id = f.entity_id
    where f.pnl is not null
  )
)) as diag;

-- Dump one real month's pnl lines to reproduce a View P&L failure.
select e.name, f.period, f.net, f.pnl
from financials f join ownership_entities e on e.id = f.entity_id
where f.pnl is not null and e.name = 'Bar Phoebe' and f.period = '2026-07-01';

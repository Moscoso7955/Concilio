-- One-time: surface the first wave of venues in the Marketing tab
-- (Bar Phoebe, Barranco, Soca, DFWPMC). Safe to re-run.
update ownership_entities
   set in_marketing = true
 where kind = 'entity'
   and name in ('Bar Phoebe', 'Barranco', 'Soca', 'DFWPMC');

select name, in_marketing from ownership_entities
 where kind = 'entity' and in_marketing order by name;

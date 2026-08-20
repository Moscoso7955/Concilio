-- Surface operating venues in the Marketing tab (holding companies
-- excluded; Callidus newsletter on hold). Safe to re-run.
update ownership_entities
   set in_marketing = true
 where kind = 'entity'
   and name in ('Bar Phoebe', 'Barranco', 'Soca', 'DFWPMC',
                'Tipsy', 'The Garage', 'MMH', 'Three Trees',
                'Shader Haus', 'Green Dino');

select name, in_marketing from ownership_entities
 where kind = 'entity' and in_marketing order by name;

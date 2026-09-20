begin;
create temp table v as select
  'c32821dd-725e-43de-a642-5ab54e178dc7'::uuid as org,
  '00996ed2-7042-4de3-aac6-36bb181d8fc8'::uuid as usr;

update public.organisation_subscriptions
   set plan_id='pro', seat_count=5, status='active', current_period_end=now()+interval '30 days'
 where organisation_id=(select org from v);

insert into public.companies (id, organisation_id, owner_user_id, name, type)
select gen_random_uuid(), org, usr, x.name, x.t from v, (values
  ('Fabric London', array['venue']),
  ('Printworks Events Ltd', array['venue','promoter']),
  ('Kaleidoscope Agency', array['agency'])
) as x(name,t);

insert into public.contacts (id, organisation_id, owner_user_id, name, email, phone, title, location)
select gen_random_uuid(), org, usr, x.name, x.email, x.phone, x.title, x.loc from v, (values
  ('Priya Raman','priya@fabriclondon.com','+44 20 7336 8898','Head of Programming','London'),
  ('Tom Okafor','tom@printworkslondon.co.uk','+44 20 8016 6000','Production Manager','London'),
  ('Leah Byrne','leah@kaleidoscope.agency','+44 161 200 4411','Booking Agent','Manchester'),
  ('Sam Ellis','sam@neonnights.co.uk','+44 7700 900412','Tour Manager','Bristol')
) as x(name,email,phone,title,loc);

insert into public.artists (id, organisation_id, owner_user_id, name, genres, city, country)
select gen_random_uuid(), org, usr, x.name, x.g, x.city, 'UK' from v, (values
  ('Sable Kane', array['techno','electro'],'London'),
  ('Low Static', array['house'],'Manchester'),
  ('HALO NOISE', array['industrial'],'Berlin'),
  ('DJ Mercer', array['disco'],'Bristol')
) as x(name,g,city);

insert into public.venues (id, organisation_id, owner_user_id, name, address, location, capacity, website)
select gen_random_uuid(), org, usr, x.name, x.addr, x.loc, x.cap, x.web from v, (values
  ('Fabric','77a Charterhouse St','London',1600,'https://fabriclondon.com'),
  ('Printworks','Surrey Quays Rd','London',5000,'https://printworkslondon.co.uk')
) as x(name,addr,loc,cap,web);

insert into public.venue_rooms (id, organisation_id, venue_id, name)
select gen_random_uuid(), (select org from v), ve.id, r.name
from public.venues ve, (values ('Room One'),('Room Two')) as r(name)
where ve.organisation_id=(select org from v) and ve.name='Fabric';

insert into public.venue_rooms (id, organisation_id, venue_id, name)
select gen_random_uuid(), (select org from v), ve.id, 'Press Halls'
from public.venues ve
where ve.organisation_id=(select org from v) and ve.name='Printworks';

insert into public.events (id, organisation_id, owner_user_id, name, starts_at, ends_at, status, event_type, venue_id, ticket_link)
select gen_random_uuid(), (select org from v), (select usr from v), e.name, e.starts, e.ends, e.status, e.etype,
       (select id from public.venues where organisation_id=(select org from v) and name=e.venue), e.link
from (values
  ('Neon Nights: Winter Opening', now()+interval '21 days', now()+interval '21 days 6 hours', 'on_sale','club_night','Fabric','https://tickets.example.com/winter-opening'),
  ('Sable Kane - Album Launch',   now()+interval '45 days', now()+interval '45 days 5 hours', 'confirmed','club_night','Printworks','https://tickets.example.com/sable-kane'),
  ('Warehouse Sessions 04',       now()+interval '70 days', now()+interval '70 days 7 hours', 'hold','rave','Fabric', null),
  ('Neon Nights: Autumn Closing', now()-interval '30 days', now()-interval '30 days' + interval '6 hours','completed','club_night','Fabric', null)
) as e(name,starts,ends,status,etype,venue,link);

insert into public.event_lineup (id, organisation_id, event_id, artist_id, position, billing)
select gen_random_uuid(), (select org from v), ev.id, ar.id, l.ord, l.bill
from (values
  ('Neon Nights: Winter Opening','Sable Kane',1,'headliner'),
  ('Neon Nights: Winter Opening','Low Static',2,'support'),
  ('Neon Nights: Winter Opening','DJ Mercer',3,'opener'),
  ('Sable Kane - Album Launch','Sable Kane',1,'headliner'),
  ('Sable Kane - Album Launch','HALO NOISE',2,'support')
) as l(evname,arname,ord,bill)
join public.events ev on ev.organisation_id=(select org from v) and ev.name=l.evname
join public.artists ar on ar.organisation_id=(select org from v) and ar.name=l.arname;

insert into public.tasks (id, organisation_id, owner_user_id, title, status, priority, due_at)
select gen_random_uuid(), (select org from v), (select usr from v), t.title, t.status, t.prio, now()+t.due
from (values
  ('Confirm Sable Kane contract rider','open','high', interval '3 days'),
  ('Send Printworks production schedule','in_progress','normal', interval '7 days'),
  ('Chase Fabric deposit invoice','open','urgent', interval '1 day'),
  ('Book photographer for Winter Opening','done','low', interval '-2 days')
) as t(title,status,prio,due);

insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
select (select org from v), tk.id, 'event', ev.id
from public.tasks tk
join public.events ev on ev.organisation_id=(select org from v) and ev.name='Neon Nights: Winter Opening'
where tk.organisation_id=(select org from v)
  and tk.title in ('Confirm Sable Kane contract rider','Chase Fabric deposit invoice','Book photographer for Winter Opening');

insert into public.notes (id, organisation_id, owner_user_id, body, visibility)
select gen_random_uuid(), (select org from v), (select usr from v), n.body, n.vis
from (values
  ('Fabric want a 10 percent uplift on bar spend for the Winter Opening. Priya is flexible on the door split if we commit to a second date.','company'),
  ('Sable Kane travels with a 4-person crew - two rooms, one van. Agent prefers email over calls.','company'),
  ('Do not re-book DJ Mercer for a Friday - poor door on the last two.','private')
) as n(body,vis);

insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, currency, occurred_on, description, created_by)
select gen_random_uuid(), (select org from v), ev.id, f.cat, f.st, f.amt, 'GBP', current_date, f.descr, (select usr from v)
from public.events ev, (values
  ('fee','budgeted',450000,'Sable Kane - headline fee'),
  ('fee','actual',450000,'Sable Kane - headline fee paid'),
  ('cost','budgeted',120000,'Sound and lighting hire'),
  ('cost','actual',138500,'Sound and lighting hire (final)'),
  ('cost','actual',42000,'Security and stewarding'),
  ('income','budgeted',1400000,'Advance ticket sales'),
  ('income','actual',1268000,'Ticket sales to date'),
  ('income','actual',310000,'Bar revenue share')
) as f(cat,st,amt,descr)
where ev.organisation_id=(select org from v) and ev.name='Neon Nights: Winter Opening';

commit;

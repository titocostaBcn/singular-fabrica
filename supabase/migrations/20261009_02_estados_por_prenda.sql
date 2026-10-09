-- Estados por prenda: pendiente → sin_stock → cortar → estampar → empaquetar.
-- El pedido toma automáticamente el estado de su prenda más atrasada (trigger). "producido" lo pone la función al empaquetar.
alter table public.fab_pedidos drop constraint if exists fab_pedidos_estado_check;
update public.fab_pedidos set estado = 'sin_stock' where estado = 'espera_stock';
alter table public.fab_pedidos add constraint fab_pedidos_estado_check
  check (estado in ('pendiente','sin_stock','cortar','estampar','empaquetar','producido'));

alter table public.fab_lineas
  add column if not exists estado text not null default 'pendiente'
    check (estado in ('pendiente','sin_stock','cortar','estampar','empaquetar')),
  add column if not exists estado_at timestamptz not null default now(),
  add column if not exists estado_por text;
update public.fab_lineas l set estado = 'sin_stock'
  from public.fab_pedidos p where p.order_id = l.order_id and p.estado = 'sin_stock';
create index if not exists fab_lineas_estado_idx on public.fab_lineas (estado);

create or replace function public.fab_recalcular_pedido() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  orden constant text[] := array['pendiente','sin_stock','cortar','estampar','empaquetar'];
  v text;
begin
  select orden[min(array_position(orden, l.estado))] into v
    from public.fab_lineas l where l.order_id = new.order_id;
  update public.fab_pedidos set estado = v, estado_at = now()
   where order_id = new.order_id and estado <> 'producido' and estado is distinct from v;
  return null;
end $$;
revoke execute on function public.fab_recalcular_pedido() from public, anon, authenticated;

drop trigger if exists fab_lineas_estado on public.fab_lineas;
create trigger fab_lineas_estado after insert or update of estado on public.fab_lineas
  for each row execute function public.fab_recalcular_pedido();

alter publication supabase_realtime add table public.fab_lineas;

-- Quién ha estampado y quién ha empaquetado (enviado) cada pedido, para el Histórico.
-- Automático: al pasar el pedido a Empaquetar / Producido se guarda la fecha y la persona que lo tenía cogido (asignado_a).
-- La pantalla además pregunta "¿Quién lo ha hecho?" y lo confirma con fab_marcar_persona.
alter table public.fab_pedidos
  add column if not exists estampado_por text, add column if not exists estampado_at timestamptz,
  add column if not exists empaquetado_por text, add column if not exists empaquetado_at timestamptz;

create or replace function public.fab_registro_personas() returns trigger
language plpgsql set search_path to '' as $$
begin
  if new.estado is distinct from old.estado then
    if new.estado in ('empaquetar', 'producido') and old.estado in ('pendiente', 'sin_stock', 'cortar', 'estampar') and new.estampado_at is null then
      new.estampado_at := now(); new.estampado_por := coalesce(new.estampado_por, new.asignado_a);
    end if;
    if new.estado = 'producido' then
      new.empaquetado_at := now(); new.empaquetado_por := coalesce(new.asignado_a, new.empaquetado_por);
    end if;
    if old.estado = 'producido' and new.estado <> 'producido' then
      new.empaquetado_at := null; new.empaquetado_por := null;
    end if;
  end if;
  return new;
end $$;
create trigger fab_pedidos_registro_personas before update of estado on public.fab_pedidos
  for each row execute function public.fab_registro_personas();

-- p_tipo: 'estampado' | 'empaquetado'
create or replace function public.fab_marcar_persona(p_order_ids bigint[], p_tipo text, p_persona text)
returns int language plpgsql security definer set search_path to '' as $$
declare n int; per text := nullif(trim(p_persona), '');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if p_tipo = 'estampado' then
    update public.fab_pedidos set estampado_por = per, estampado_at = coalesce(estampado_at, now()) where order_id = any(p_order_ids);
  elsif p_tipo = 'empaquetado' then
    update public.fab_pedidos set empaquetado_por = per, empaquetado_at = coalesce(empaquetado_at, now()) where order_id = any(p_order_ids);
  else raise exception 'tipo no válido';
  end if;
  get diagnostics n = row_count;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario)
    select unnest(p_order_ids), 'persona_' || p_tipo, jsonb_build_object('persona', per), auth.jwt()->>'email';
  return n;
end $$;
revoke all on function public.fab_marcar_persona(bigint[], text, text) from public, anon;
grant execute on function public.fab_marcar_persona(bigint[], text, text) to authenticated;

create index if not exists fab_pedidos_empaquetado_at on public.fab_pedidos (empaquetado_at);
create index if not exists fab_pedidos_estampado_at on public.fab_pedidos (estampado_at);

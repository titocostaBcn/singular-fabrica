-- Reparto del trabajo en Empaquetar: cada empaquetadora "coge" pedidos y las demás los ven bloqueados.
-- Las personas se identifican por nombre en cada dispositivo (mismo login); la lista está en fab_config.empaquetadoras (separada por comas).
alter table public.fab_pedidos add column if not exists asignado_a text, add column if not exists asignado_at timestamptz;

insert into public.fab_config (clave, valor) values ('empaquetadoras', '') on conflict (clave) do nothing;

-- p_nombre no nulo = coger (solo libres o ya suyos, salvo p_forzar). p_nombre nulo = soltar (solo los de p_soltar_de, salvo p_forzar).
create or replace function public.fab_asignar(p_order_ids bigint[], p_nombre text, p_soltar_de text default null, p_forzar boolean default false)
returns bigint[] language plpgsql security definer set search_path to '' as $$
declare ids bigint[]; quien text := auth.jwt()->>'email'; n text := nullif(trim(p_nombre), '');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if n is not null then
    with u as (
      update public.fab_pedidos set asignado_a = n, asignado_at = now()
       where order_id = any(p_order_ids) and estado <> 'producido' and cancelado = false
         and (asignado_a is null or asignado_a = n or p_forzar)
      returning order_id)
    select coalesce(array_agg(order_id), '{}') into ids from u;
  else
    with u as (
      update public.fab_pedidos set asignado_a = null, asignado_at = null
       where order_id = any(p_order_ids) and estado <> 'producido' and (asignado_a = p_soltar_de or p_forzar)
      returning order_id)
    select coalesce(array_agg(order_id), '{}') into ids from u;
  end if;
  if array_length(ids, 1) > 0 then
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select unnest(ids), case when n is null then 'soltado' else 'asignado' end, jsonb_build_object('nombre', coalesce(n, p_soltar_de), 'forzado', p_forzar), quien;
  end if;
  return ids;
end $$;
revoke all on function public.fab_asignar(bigint[], text, text, boolean) from public, anon;
grant execute on function public.fab_asignar(bigint[], text, text, boolean) to authenticated;

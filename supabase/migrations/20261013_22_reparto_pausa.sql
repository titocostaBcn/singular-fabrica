-- Pausar el reparto a una persona (13-oct-2026, pedido de Tito: Irene trabaja menos horas que Dania).
-- La jefa pulsa «⏸ Pausar reparto a Irene»: desde ese momento los pedidos nuevos de Empaquetar van todos a las demás
-- (Dania) hasta que pulse «▶ Volver a repartir a Irene». Lo que Irene ya tenía sigue siendo suyo (la jefa puede recuperarlo).
--   fab_config.reparto_pausados = nombres en pausa, separados por comas ('' = nadie)

insert into public.fab_config (clave, valor, nota) values
  ('reparto_pausados', '', 'Personas a las que no se reparten pedidos ahora (las pone y quita la jefa con ⏸ / ▶)')
on conflict (clave) do nothing;

create or replace function public.fab_pausados_reparto()
returns text[] language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(trim(x)), '{}') from public.fab_config c, unnest(string_to_array(c.valor, ',')) x
   where c.clave = 'reparto_pausados' and trim(x) <> '';
$$;
revoke all on function public.fab_pausados_reparto() from public, anon;
grant execute on function public.fab_pausados_reparto() to authenticated, service_role;

-- El reparto sigue activo con dos o más con usuario; el turno solo pasa por las que no están en pausa.
create or replace function public.fab_siguiente_reparto()
returns text language plpgsql security definer set search_path to '' as $$
declare l text[] := public.fab_lista_reparto(); a text[]; t bigint;
begin
  if coalesce(array_length(l, 1), 0) < 2 then return null; end if;
  select coalesce(array_agg(n order by o), '{}') into a from unnest(l) with ordinality as u(n, o)
   where not (n = any(public.fab_pausados_reparto()));
  if coalesce(array_length(a, 1), 0) = 0 then return null; end if;
  update public.fab_config set valor = ((coalesce(nullif(valor, ''), '0'))::bigint + 1)::text
   where clave = 'reparto_turno' returning valor::bigint into t;
  if t is null then
    insert into public.fab_config (clave, valor) values ('reparto_turno', '1') on conflict (clave) do update set valor = '1';
    t := 1;
  end if;
  return a[((t - 1) % array_length(a, 1)) + 1];
end $$;

-- La jefa (o un admin) pone o quita la pausa de una persona
create or replace function public.fab_pausar_reparto(p_nombre text, p_pausa boolean)
returns text[] language plpgsql security definer set search_path to '' as $$
declare yo record; n text := nullif(trim(p_nombre), ''); l text[];
begin
  select u.nombre, u.jefe, u.admin into yo from public.fab_usuarios u where lower(u.email) = lower(auth.jwt()->>'email');
  if yo.nombre is null or not (coalesce(yo.jefe, false) or coalesce(yo.admin, false)) then raise exception 'solo la jefa puede pausar el reparto'; end if;
  if n is null then raise exception 'falta el nombre'; end if;
  l := array_remove(public.fab_pausados_reparto(), n);
  if p_pausa then l := l || n; end if;
  insert into public.fab_config (clave, valor) values ('reparto_pausados', array_to_string(l, ', '))
    on conflict (clave) do update set valor = excluded.valor;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario)
    values (null, case when p_pausa then 'reparto_pausa' else 'reparto_reanuda' end, jsonb_build_object('nombre', n), auth.jwt()->>'email');
  return l;
end $$;
revoke all on function public.fab_pausar_reparto(text, boolean) from public, anon;
grant execute on function public.fab_pausar_reparto(text, boolean) to authenticated, service_role;

-- fab_repartir: si no queda nadie a quien repartir (todas en pausa), para
create or replace function public.fab_repartir()
returns integer language plpgsql security definer set search_path to '' as $$
declare r record; n integer := 0; quien text;
begin
  if auth.uid() is not null and not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if coalesce(array_length(public.fab_lista_reparto(), 1), 0) < 2 then return 0; end if;
  for r in select p.order_id from public.fab_pedidos p
            where p.estado = 'empaquetar' and p.asignado_a is null and not p.cancelado
            order by (p.metodo_envio ~* 'expr[eé]s|urgent' or exists (select 1 from unnest(coalesce(p.tags, '{}'::text[])) t where t ~* 'urgent')) desc,
                     p.creado_shopify asc
            for update
  loop
    quien := public.fab_siguiente_reparto();
    exit when quien is null;
    update public.fab_pedidos set asignado_a = quien, asignado_at = now() where order_id = r.order_id;
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      values (r.order_id, 'asignado', jsonb_build_object('nombre', quien, 'reparto', true), coalesce(auth.jwt()->>'email', 'reparto'));
    n := n + 1;
  end loop;
  return n;
end $$;

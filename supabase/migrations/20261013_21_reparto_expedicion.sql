-- Reparto automático en Expedición (13-oct-2026, decisión de Tito).
-- Expedición son dos personas, Dania (jefa) e Irene, cada una con su ordenador y su usuario.
-- Cada pedido que llega a Empaquetar se asigna por turnos: uno a Dania, uno a Irene, y así sucesivamente
-- (en el orden en que llegan; si llegan varios a la vez, urgentes y antiguos primero, como fab_autoasignar).
-- La jefa (fab_usuarios.jefe) puede recuperar los pedidos de otra persona: todos o los que marque (rpc fab_recuperar).
--   fab_config.reparto_expedicion = lista de nombres en el orden del turno ('' = sin reparto, como antes: llegan libres)
--   Solo cuentan los nombres que tienen usuario (fab_usuarios.nombre, mismo nombre exacto). El reparto funciona cuando hay
--   AL MENOS DOS con usuario; con una sola (p. ej. hoy, que Irene aún no tiene usuario) todo sigue como antes: llegan libres.
--   Cuando se da de alta a la segunda, la pantalla de Expedición llama a fab_repartir y reparte los que estén libres.
--   fab_config.reparto_turno      = contador del turno (lo sube fab_siguiente_reparto)

alter table public.fab_usuarios add column if not exists jefe boolean not null default false;
update public.fab_usuarios set jefe = true where lower(email) = 'dania@singularwardrobe.com';

insert into public.fab_config (clave, valor, nota) values
  ('reparto_expedicion', 'Dania, Irene', 'Reparto automático de Empaquetar por turnos (nombres separados por comas; vacío = sin reparto)'),
  ('reparto_turno', '0', 'Contador del turno del reparto de Expedición (no tocar)')
on conflict (clave) do nothing;

create or replace function public.fab_lista_reparto()
returns text[] language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(n order by o), '{}')
    from (select trim(x) n, o from public.fab_config c,
            unnest(string_to_array(c.valor, ',')) with ordinality as t(x, o)
           where c.clave = 'reparto_expedicion' and trim(x) <> ''
             and exists (select 1 from public.fab_usuarios u where u.nombre = trim(x))) s;
$$;

-- Siguiente persona del turno (null si no hay reparto). Sube el contador; la fila de fab_config bloquea, así dos a la vez no se pisan.
create or replace function public.fab_siguiente_reparto()
returns text language plpgsql security definer set search_path to '' as $$
declare l text[] := public.fab_lista_reparto(); t bigint;
begin
  if coalesce(array_length(l, 1), 0) < 2 then return null; end if;
  update public.fab_config set valor = ((coalesce(nullif(valor, ''), '0'))::bigint + 1)::text
   where clave = 'reparto_turno' returning valor::bigint into t;
  if t is null then
    insert into public.fab_config (clave, valor) values ('reparto_turno', '1') on conflict (clave) do update set valor = '1';
    t := 1;
  end if;
  return l[((t - 1) % array_length(l, 1)) + 1];
end $$;
-- el trigger corre como la usuaria: authenticated y service_role las necesitan; anon no
revoke all on function public.fab_siguiente_reparto() from public, anon;
revoke all on function public.fab_lista_reparto() from public, anon;
grant execute on function public.fab_siguiente_reparto(), public.fab_lista_reparto() to authenticated, service_role;

-- Al llegar a Empaquetar: si ya lo tenía alguien de Expedición se queda con él (p. ej. vuelve de «↶»); si no, le toca al siguiente del turno.
create or replace function public.fab_registro_personas()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if new.estado is distinct from old.estado then
    if new.estado in ('empaquetar', 'producido') and old.estado in ('pendiente', 'sin_stock', 'cortar', 'estampar') then
      if new.estampado_at is null then
        new.estampado_at := now(); new.estampado_por := coalesce(new.estampado_por, new.asignado_a);
      end if;
      if new.estado = 'empaquetar' then
        if new.asignado_a is null or not (new.asignado_a = any(public.fab_lista_reparto())) then
          new.asignado_a := public.fab_siguiente_reparto();
          new.asignado_at := case when new.asignado_a is null then null else now() end;
        end if;
      end if;
    end if;
    if new.estado = 'producido' then
      new.empaquetado_at := now(); new.empaquetado_por := coalesce(new.asignado_a, new.empaquetado_por);
      new.asignado_a := null; new.asignado_at := null;
    end if;
    if old.estado = 'producido' and new.estado <> 'producido' then
      new.empaquetado_at := null; new.empaquetado_por := null;
    end if;
  end if;
  return new;
end $function$;

-- Reparte los pedidos de Empaquetar que estén libres (al activar el reparto y por si alguno se queda suelto).
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
    update public.fab_pedidos set asignado_a = quien, asignado_at = now() where order_id = r.order_id;
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      values (r.order_id, 'asignado', jsonb_build_object('nombre', quien, 'reparto', true), coalesce(auth.jwt()->>'email', 'reparto'));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.fab_repartir() from public, anon;
grant execute on function public.fab_repartir() to authenticated, service_role;

-- La jefa recupera pedidos de otra persona: todos (p_order_ids null) o los marcados. Pasan a su nombre.
create or replace function public.fab_recuperar(p_de text, p_order_ids bigint[] default null)
returns bigint[] language plpgsql security definer set search_path to '' as $$
declare yo record; ids bigint[];
begin
  select u.nombre, u.jefe, u.admin into yo from public.fab_usuarios u where lower(u.email) = lower(auth.jwt()->>'email');
  if yo.nombre is null or not (coalesce(yo.jefe, false) or coalesce(yo.admin, false)) then raise exception 'solo la jefa puede recuperar pedidos'; end if;
  if nullif(trim(p_de), '') is null or p_de = yo.nombre then return '{}'; end if;
  with u as (
    update public.fab_pedidos set asignado_a = yo.nombre, asignado_at = now()
     where asignado_a = p_de and estado = 'empaquetar' and not cancelado
       and (p_order_ids is null or order_id = any(p_order_ids))
    returning order_id)
  select coalesce(array_agg(order_id), '{}') into ids from u;
  if array_length(ids, 1) > 0 then
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select unnest(ids), 'recuperado', jsonb_build_object('de', p_de, 'para', yo.nombre, 'todos', p_order_ids is null), auth.jwt()->>'email';
  end if;
  return ids;
end $$;
revoke all on function public.fab_recuperar(text, bigint[]) from public, anon;
grant execute on function public.fab_recuperar(text, bigint[]) to authenticated, service_role;

-- fab_yo devuelve también si es jefa
create or replace function public.fab_yo()
returns jsonb language sql stable security definer set search_path to '' as $function$
  select coalesce((select jsonb_build_object('email', u.email, 'nombre', u.nombre, 'admin', u.admin, 'puesto', u.puesto, 'jefe', u.jefe)
                     from public.fab_usuarios u where lower(u.email) = lower(auth.jwt()->>'email')), '{}'::jsonb);
$function$;

-- Los que ya están esperando en Empaquetar se reparten ahora (urgentes y antiguos primero), si ya hay dos con usuario
select public.fab_repartir();

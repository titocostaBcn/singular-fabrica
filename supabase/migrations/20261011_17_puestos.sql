-- Puestos (11-oct-2026): cada persona tiene su pantalla.
--   administracion = el programa entero (plan del día, hojas, recogida, histórico…). También si no tiene puesto.
--   produccion     = pantalla sencilla: 1 · Cortar vinilo (hoja de corte) y 2 · Estampar.
--   expedicion     = pantalla sencilla: Empaquetar (etiqueta GLS, Otros envíos o recogida), Hechos hoy y Recogidas.
-- Lo asigna el administrador desde 👥 (función fab, acción usuario_guardar). Es para que cada una vea solo lo suyo,
-- no una barrera de seguridad: los datos los sigue protegiendo fab_es_usuario().
alter table public.fab_usuarios add column if not exists puesto text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fab_usuarios_puesto_check') then
    alter table public.fab_usuarios add constraint fab_usuarios_puesto_check check (puesto is null or puesto in ('administracion','produccion','expedicion'));
  end if;
end $$;

-- La pantalla pregunta quién es (nombre, administrador, puesto) sin poder leer la tabla de usuarios.
create or replace function public.fab_yo() returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce((select jsonb_build_object('email', u.email, 'nombre', u.nombre, 'admin', u.admin, 'puesto', u.puesto)
                     from public.fab_usuarios u where lower(u.email) = lower(auth.jwt()->>'email')), '{}'::jsonb);
$$;
revoke all on function public.fab_yo() from public, anon;
grant execute on function public.fab_yo() to authenticated;

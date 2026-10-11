-- Usuarios desde la pantalla (11-oct-2026): el administrador da de alta al personal, le pone contraseña o le quita el acceso,
-- sin correos. Lo hace la función `fab` (acciones soy_admin, usuarios, usuario_guardar, usuario_quitar) con la clave de servicio;
-- aquí solo se marca quién es administrador. fab_usuarios sigue sin políticas: la pantalla no la lee directamente.
alter table public.fab_usuarios add column if not exists admin boolean not null default false;
update public.fab_usuarios set admin = true where lower(email) = 'titocosta@singularwardrobe.com';
